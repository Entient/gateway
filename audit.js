#!/usr/bin/env node
/**
 * entient-spend — Claude Code Waste Analyzer + Session Enforcer
 *
 * Two modes:
 *   1. REPORT   — reads ~/.claude and shows where quota went (no hooks needed)
 *   2. ENFORCE  — registers hooks that block sessions when waste factor gets too high
 *
 * Usage:
 *   entient-spend                        # waste report (last 7d)
 *   entient-spend --last 30d
 *   entient-spend install                # register enforcement hooks (blocks at 10x waste)
 *   entient-spend install --shadow       # register hooks in observe-only mode (warn, never block)
 *   entient-spend uninstall              # remove hooks
 *   entient-spend status                 # show hook status + current waste factor
 *   entient-spend --json                 # machine-readable report
 *
 *   # Hook modes (called by Claude Code, not users):
 *   entient-spend --hook prompt          # UserPromptSubmit — block if waste too high
 *   entient-spend --hook tool            # PostToolUse — block autonomous work if waste high
 *   entient-spend --hook compact         # PreCompact — save session state
 *   entient-spend --hook start           # SessionStart — inject saved context
 *
 * Want automated enforcement?  entient.com
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ExecutionGate adapter — contract v1 consumer.  Lazy-loaded so a broken
// Python/runtime install does not prevent `entient-spend` itself from running.
let _gateAdapter = null;
function gateAdapter() {
  if (_gateAdapter === null) {
    try { _gateAdapter = require("./gate_adapter.js"); }
    catch (_) { _gateAdapter = false; }
  }
  return _gateAdapter || null;
}

// ── Config ──────────────────────────────────────────────────────────────────

const AUDIT_DIR       = path.join(os.homedir(), ".entient-spend");
const LAST_SESSION    = path.join(AUDIT_DIR, "last-session.md");
const RESTART_FLAG    = path.join(AUDIT_DIR, "restart-flag");   // watched by claude-loop
const CONFIG_FILE     = path.join(AUDIT_DIR, "config.json");
const SHADOW_LOG      = path.join(AUDIT_DIR, "shadow_log.jsonl");
const FIRE_STATE_FILE = path.join(AUDIT_DIR, "session-fire-state.json");
const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const CLAUDE_HISTORY  = path.join(os.homedir(), ".claude", "history.jsonl");
const PROJECTS_DIR    = path.join(os.homedir(), ".claude", "projects");

const DEFAULTS = {
  threshold:      5,   // waste factor that triggers session kill + restart (5x = each turn costs 5x session start)
  saveThreshold:  3,   // waste factor that triggers git savepoint + warning (early signal)
  minTurns:      15,   // minimum turns before enforcing
  baselineTurns:  5,   // turns used to establish baseline
  windowTurns:    5,   // turns used for current average
  mode:      "enforce", // "enforce" = block at threshold | "shadow" = warn only, never block
};

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch (_) { return { ...DEFAULTS }; }
}

function saveConfig(patch) {
  ensureAuditDir();
  const current = loadConfig();
  const updated  = { ...current, ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

// ── Anthropic billing API ────────────────────────────────────────────────────

/**
 * Fetch real usage data from Anthropic's API.
 * Returns { ok, days: [{date, inputTokens, outputTokens, cacheRead, cacheWrite, models:{}}], error }
 *
 * Anthropic usage endpoint: GET /v1/usage (paginated, per-day, per-model breakdown)
 * Requires API key with org read permissions.
 */
async function fetchAnthropicUsage(apiKey, days = 30) {
  const https   = require("https");
  const since   = new Date(Date.now() - days * 86_400_000);
  const startDate = since.toISOString().slice(0, 10);

  // Model pricing ($/MTok) — input / output
  const PRICES = {
    "claude-opus-4":         { in: 15,    out: 75   },
    "claude-sonnet-4":       { in: 3,     out: 15   },
    "claude-sonnet-4-5":     { in: 3,     out: 15   },
    "claude-haiku-4":        { in: 0.80,  out: 4    },
    "claude-haiku-4-5":      { in: 0.80,  out: 4    },
    "claude-opus-3-5":       { in: 15,    out: 75   },
    "claude-sonnet-3-5":     { in: 3,     out: 15   },
    "claude-haiku-3":        { in: 0.25,  out: 1.25 },
    // fallback
    "default":               { in: 3,     out: 15   },
  };

  function priceForModel(modelId) {
    for (const [k, v] of Object.entries(PRICES)) {
      if (k !== "default" && modelId && modelId.toLowerCase().includes(k.replace(/-/g, ""))) return v;
      if (k !== "default" && modelId && modelId.toLowerCase().startsWith(k)) return v;
    }
    return PRICES["default"];
  }

  function calcCost(model, inputTok, outputTok, cacheReadTok, cacheWriteTok) {
    const p = priceForModel(model);
    const inp  = (inputTok   || 0) / 1_000_000 * p.in;
    const out  = (outputTok  || 0) / 1_000_000 * p.out;
    const cr   = (cacheReadTok || 0) / 1_000_000 * (p.in * 0.1);   // cache read ~10% of input
    const cw   = (cacheWriteTok || 0) / 1_000_000 * (p.in * 1.25); // cache write ~125% of input
    return inp + out + cr + cw;
  }

  const get = (url, headers) => new Promise((resolve, reject) => {
    const req = https.request(url, { headers }, res => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });

  try {
    // Try Anthropic's usage endpoint
    const headers = {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };

    // Paginate through all usage records
    const allRows = [];
    let nextPage = null;
    let page = 0;

    do {
      const url = new URL("https://api.anthropic.com/v1/usage");
      url.searchParams.set("start_time", since.toISOString());
      if (nextPage) url.searchParams.set("after_id", nextPage);

      const res = await get(url.toString(), headers);

      if (res.status === 404 || res.status === 405) {
        // Endpoint not available — try alternate path
        break;
      }

      if (res.status === 401) {
        return { ok: false, error: "Invalid API key. Check ~/.entient-spend/config.json" };
      }
      if (res.status !== 200) {
        return { ok: false, error: `Anthropic API error ${res.status}: ${res.body.slice(0, 200)}` };
      }

      let data;
      try { data = JSON.parse(res.body); } catch (_) { break; }

      const rows = data.data || data.usage || data.results || [];
      allRows.push(...rows);
      nextPage = data.next_page || data.next_cursor || null;
      page++;
    } while (nextPage && page < 20);

    if (allRows.length === 0) {
      return { ok: false, error: "No usage data returned. Your API key may not have billing read access." };
    }

    // Aggregate by day
    const byDay = {};
    let totalCost = 0;

    for (const row of allRows) {
      const date = (row.date || row.timestamp || "").slice(0, 10);
      if (!date || date < startDate) continue;

      if (!byDay[date]) byDay[date] = { date, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: {} };

      const inp = row.input_tokens || row.input || 0;
      const out = row.output_tokens || row.output || 0;
      const cr  = row.cache_read_input_tokens || 0;
      const cw  = row.cache_creation_input_tokens || 0;
      const model = row.model || "unknown";

      byDay[date].inputTokens += inp;
      byDay[date].outputTokens += out;
      byDay[date].cacheRead    += cr;
      byDay[date].cacheWrite   += cw;

      const rowCost = calcCost(model, inp, out, cr, cw);
      byDay[date].cost += rowCost;
      totalCost        += rowCost;

      if (!byDay[date].models[model]) byDay[date].models[model] = { tokens: 0, cost: 0 };
      byDay[date].models[model].tokens += inp + out;
      byDay[date].models[model].cost   += rowCost;
    }

    const days_arr = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
    return { ok: true, days: days_arr, totalCost, rowCount: allRows.length };

  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * POST /v1/messages/count_tokens — Anthropic's free pre-flight token counter.
 * Counts tokens in a Message (including tools, system, images, docs) WITHOUT creating it.
 * Use this to measure deflection savings instead of estimating at AVG_TOKENS_PER_INFERENCE.
 *
 * Returns { ok, input_tokens, error }.
 */
async function countTokens(apiKey, { model = "claude-sonnet-4-5", messages, system, tools }) {
  const https = require("https");
  if (!apiKey) return { ok: false, error: "No API key. Run: entient-spend setup" };
  if (!messages || !Array.isArray(messages)) {
    return { ok: false, error: "messages array is required" };
  }
  const body = JSON.stringify({
    model,
    messages,
    ...(system ? { system } : {}),
    ...(tools ? { tools } : {}),
  });
  return new Promise(resolve => {
    const req = https.request("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, res => {
      let buf = "";
      res.on("data", d => buf += d);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return resolve({ ok: false, error: `HTTP ${res.statusCode}: ${buf.slice(0, 200)}` });
        }
        try {
          const parsed = JSON.parse(buf);
          resolve({ ok: true, input_tokens: parsed.input_tokens });
        } catch (e) { resolve({ ok: false, error: "Bad JSON: " + e.message }); }
      });
    });
    req.on("error", err => resolve({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

/**
 * Admin API — authoritative cost report in dollars (no client-side price-table estimation).
 * Requires an ADMIN API key (starts with `sk-ant-admin...` or `apikey_...`), not a regular `sk-ant-...` key.
 * Endpoint: GET /v1/organizations/cost_report
 *
 * Returns { ok, totalCost, byDay: [{date, cost}], byWorkspace: {...}, error }.
 */
async function fetchAnthropicCostReport(adminKey, days = 30) {
  const https = require("https");
  if (!adminKey) {
    return { ok: false, error: "No admin key. Run: entient-spend setup --admin" };
  }
  const since = new Date(Date.now() - days * 86_400_000);
  const startDate = since.toISOString().slice(0, 10);

  const get = (url, headers) => new Promise((resolve, reject) => {
    const req = https.request(url, { headers }, res => {
      let body = ""; res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject); req.end();
  });

  try {
    const headers = {
      "x-api-key": adminKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", since.toISOString());

    const res = await get(url.toString(), headers);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Admin key rejected (need apikey_... or sk-ant-admin...)" };
    }
    if (res.status === 404) {
      return { ok: false, error: "cost_report endpoint unavailable for this org" };
    }
    if (res.status !== 200) {
      return { ok: false, error: `Admin API error ${res.status}: ${res.body.slice(0, 200)}` };
    }

    let data;
    try { data = JSON.parse(res.body); } catch (_) {
      return { ok: false, error: "Bad JSON from cost_report" };
    }

    const rows = data.data || [];
    const byDay = {};
    let totalCost = 0;
    for (const row of rows) {
      const date = (row.starting_at || row.date || "").slice(0, 10);
      if (!date || date < startDate) continue;
      const cost = parseFloat(row.amount?.value || row.cost || 0);
      byDay[date] = (byDay[date] || 0) + cost;
      totalCost += cost;
    }
    const byDayArr = Object.entries(byDay).map(([date, cost]) => ({ date, cost }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return { ok: true, totalCost, byDay: byDayArr, rowCount: rows.length, source: "admin_api" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Setup command — prompt for API key and monthly budget, save to config. */
async function setup() {
  const readline = require("readline");
  const ask = (q) => new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, ans => { rl.close(); resolve(ans.trim()); });
  });

  console.log("");
  console.log(bold("  entient-spend setup"));
  console.log(`  ${SL}`);
  console.log("");
  console.log("  This connects entient-spend to your real Anthropic billing data.");
  console.log("  Your API key is stored locally in ~/.entient-spend/config.json");
  console.log("  Nothing is uploaded anywhere.");
  console.log("");

  const cfg = loadConfig();

  const key = await ask(`  Anthropic API key (sk-ant-...)${cfg.anthropicApiKey ? " [Enter to keep existing]" : ""}: `);
  const apiKey = key || cfg.anthropicApiKey || "";

  if (!apiKey) {
    console.log("\n  No key entered. Setup cancelled.\n");
    return;
  }

  // Validate the key
  process.stdout.write("  Verifying key... ");
  const result = await fetchAnthropicUsage(apiKey, 7);
  if (!result.ok) {
    console.log(`\n  ${yl("Could not verify:")} ${result.error}`);
    console.log("  Key saved anyway — usage data may not be available.\n");
  } else {
    console.log(`OK  (${result.rowCount} usage records found in last 7 days)`);
  }

  const budgetStr = await ask(`  Monthly budget / what you pay Anthropic ($)${cfg.monthlyBudget ? ` [${cfg.monthlyBudget}]` : ""}: `);
  const budget = parseFloat(budgetStr) || cfg.monthlyBudget || null;

  console.log("");
  console.log("  " + dim("Optional: Admin API key (apikey_... or sk-ant-admin...)"));
  console.log("  " + dim("If you paste one, entient-spend uses the authoritative /v1/organizations/cost_report"));
  console.log("  " + dim("endpoint instead of estimating cost from the client-side price table."));
  const adminKey = await ask(`  Admin API key${cfg.anthropicAdminKey ? " [Enter to keep existing, 'clear' to remove]" : " [Enter to skip]"}: `);
  let finalAdminKey = cfg.anthropicAdminKey || "";
  if (adminKey === "clear") finalAdminKey = "";
  else if (adminKey) finalAdminKey = adminKey;

  if (finalAdminKey && finalAdminKey !== cfg.anthropicAdminKey) {
    process.stdout.write("  Verifying admin key... ");
    const adminRes = await fetchAnthropicCostReport(finalAdminKey, 7);
    if (!adminRes.ok) {
      console.log(`\n  ${yl("Could not verify:")} ${adminRes.error}`);
      console.log("  Key saved anyway.\n");
    } else {
      console.log(`OK  ($${adminRes.totalCost.toFixed(2)} reported for last 7 days)`);
    }
  }

  saveConfig({ anthropicApiKey: apiKey, anthropicAdminKey: finalAdminKey, monthlyBudget: budget });

  console.log("");
  console.log(`  Saved to ${CONFIG_FILE}`);
  console.log("  Run entient-spend to see your real spend.");
  console.log("");
}

function ensureAuditDir() {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

function logShadowEvent(event, file, w, cfg) {
  ensureAuditDir();
  // Extract project name from session file path
  const parts = (file || "").replace(/\\/g, "/").split("/");
  const projIdx = parts.indexOf("projects");
  const project = projIdx >= 0 ? decodeURIComponent(parts[projIdx + 1] || "unknown") : "unknown";
  const sessionFile = parts[parts.length - 1] || "unknown";

  const record = {
    ts:        new Date().toISOString(),
    event,                               // "would_block_prompt" | "would_block_tool" | "approaching"
    factor:    w.factor,
    threshold: cfg.threshold,
    turns:     w.turns,
    baseline:  w.baseline,
    current:   w.current,
    project:   project.slice(0, 60),
    session:   sessionFile.replace(".jsonl", "").slice(0, 20),
  };
  try {
    fs.appendFileSync(SHADOW_LOG, JSON.stringify(record) + "\n", "utf8");
  } catch (_) {}
}

// ── Session JSONL reader ─────────────────────────────────────────────────────

/**
 * Read a session JSONL file and return per-turn token counts.
 * A "turn" = one user→assistant exchange.
 * Returns array of { inputTokens, outputTokens, totalTokens } per turn.
 */
function readSessionTurns(sessionFile) {
  if (!fs.existsSync(sessionFile)) return [];

  const turns = [];
  let currentTurn = null;

  try {
    const lines = fs.readFileSync(sessionFile, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (_) { continue; }

      const type = rec.type || (rec.message && rec.message.role);

      if (type === "user" || rec.message?.role === "user") {
        if (currentTurn) turns.push(currentTurn);
        currentTurn = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      }

      if ((type === "assistant" || rec.message?.role === "assistant") && currentTurn) {
        const usage = rec.message?.usage || rec.usage || {};
        const inp = (usage.input_tokens || 0)
                  + (usage.cache_creation_input_tokens || 0)
                  + (usage.cache_read_input_tokens || 0);
        const out = usage.output_tokens || 0;
        currentTurn.inputTokens  += inp;
        currentTurn.outputTokens += out;
        currentTurn.totalTokens  += inp + out;
      }
    }
    if (currentTurn && currentTurn.totalTokens > 0) turns.push(currentTurn);
  } catch (_) {}

  return turns.filter(t => t.totalTokens > 0);
}

/**
 * Compute waste factor for a session file.
 * Returns { turns, baseline, current, factor, blocked } or null.
 */
function computeWasteFactor(sessionFile, cfg = DEFAULTS) {
  const turns = readSessionTurns(sessionFile);
  if (turns.length < cfg.minTurns) return { turns: turns.length, factor: 1, blocked: false };

  const baseline = avg(turns.slice(0, cfg.baselineTurns).map(t => t.totalTokens));
  const current  = avg(turns.slice(-cfg.windowTurns).map(t => t.totalTokens));
  if (baseline === 0) return { turns: turns.length, factor: 1, blocked: false };

  const factor = current / baseline;
  return {
    turns:    turns.length,
    baseline: Math.round(baseline),
    current:  Math.round(current),
    factor:   Math.round(factor * 10) / 10,
    blocked:  factor >= cfg.threshold,
  };
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Read Claude Code's hook JSON payload from stdin, once, cached.
 * Claude Code pipes { session_id, transcript_path, cwd, hook_event_name, ... }
 * as JSON on stdin for every hook invocation. Returns parsed object or null.
 * Guarded against interactive (TTY) stdin so CLI invocations don't block.
 */
let _cachedHookInput = undefined;
function readHookInput() {
  if (_cachedHookInput !== undefined) return _cachedHookInput;
  _cachedHookInput = null;
  try {
    if (process.stdin.isTTY) return null;
    const raw = fs.readFileSync(0, "utf8");
    if (raw && raw.trim()) _cachedHookInput = JSON.parse(raw);
  } catch (_) {}
  return _cachedHookInput;
}

/** Find the JSONL file for the current session.
 *  Prefers transcript_path from Claude Code's stdin hook payload (real contract);
 *  falls back to CLAUDE_SESSION_ID env + PROJECTS_DIR walk.
 */
function currentSessionFile() {
  const hi = readHookInput();

  // 1. Claude Code's real contract: transcript_path points directly at the JSONL.
  if (hi && typeof hi.transcript_path === "string" && fs.existsSync(hi.transcript_path)) {
    return hi.transcript_path;
  }

  // 2. Fall back to env + sid walk (kept for shells that set CLAUDE_SESSION_ID).
  const sessionId  = process.env.CLAUDE_SESSION_ID || (hi && hi.session_id) || null;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || (hi && hi.cwd) || process.cwd();

  if (!sessionId || !fs.existsSync(PROJECTS_DIR)) return null;

  // Encode project path the same way Claude Code does
  const encoded = projectDir.replace(/[:\\/]/g, "-").replace(/^-+/, "");
  const variants = [
    path.join(PROJECTS_DIR, encoded, `${sessionId}.jsonl`),
    // Try all project dirs if encoding differs
    ...( fs.existsSync(PROJECTS_DIR)
          ? fs.readdirSync(PROJECTS_DIR)
              .map(d => path.join(PROJECTS_DIR, d, `${sessionId}.jsonl`))
          : [] ),
  ];

  for (const f of variants) {
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** Resolve the current session id (for keying fire-state, shadow log, etc.)
 *  Prefers stdin payload, then env, then null. Must be called after
 *  readHookInput has had a chance to cache (or inside a hook path).
 */
function currentSessionId() {
  const hi = readHookInput();
  return (hi && hi.session_id) || process.env.CLAUDE_SESSION_ID || null;
}

// ── Hook handlers ────────────────────────────────────────────────────────────

/**
 * Scan Desktop git repos for uncommitted changes and commit + push each one.
 * Called at saveThreshold (early warning) and again just before the kill.
 * Uses --no-verify to skip ENTIENT provenance check on auto-savepoints.
 * Returns list of repo names that were saved.
 */
function gitSavepoint() {
  const { execSync } = require("child_process");
  const desktopDir = path.join(os.homedir(), "Desktop");
  const saved = [];

  let entries = [];
  try { entries = fs.readdirSync(desktopDir, { withFileTypes: true }); } catch (_) { return saved; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoPath = path.join(desktopDir, entry.name);
    try {
      // Is it a git repo?
      execSync(`git -C "${repoPath}" rev-parse --git-dir`, { stdio: "ignore" });
      // Any uncommitted changes?
      const status = execSync(`git -C "${repoPath}" status --porcelain`, {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      if (!status.trim()) continue;

      // Stage + commit
      execSync(`git -C "${repoPath}" add -A`, { stdio: "ignore" });
      execSync(
        `git -C "${repoPath}" commit --no-verify -m "wip: auto-savepoint (session rotation)"`,
        { stdio: "ignore" }
      );
      // Push best-effort (10s timeout)
      try {
        execSync(`git -C "${repoPath}" push`, { stdio: "ignore", timeout: 10_000 });
        saved.push(`${entry.name} (committed+pushed)`);
      } catch (_) {
        saved.push(`${entry.name} (committed, push failed)`);
      }
    } catch (_) { /* not a git repo or already clean — skip */ }
  }

  return saved;
}

function triggerRestart(w) {
  // Save any uncommitted git work before killing (belt-and-suspenders — the
  // early warning at saveThreshold should have already done this).
  gitSavepoint();

  // Write restart flag for claude-loop to detect
  ensureAuditDir();
  fs.writeFileSync(RESTART_FLAG, JSON.stringify({
    triggeredAt: new Date().toISOString(),
    factor: w ? w.factor : 0,
    turns:  w ? w.turns  : 0,
  }), "utf8");

  // Kill the claude process so the loop wrapper detects the exit and relaunches.
  // Process chain when running via claude-loop.ps1:
  //   PowerShell (claude-loop) -> cmd.exe -> node.exe (claude) -> [hook shell] -> node.exe (this hook)
  // Claude Code spawns hooks via a shell intermediary on Windows, so process.ppid is that
  // intermediate shell, not the Claude Code node.exe itself.  We walk up to the grandparent.
  try {
    const { execSync } = require("child_process");
    if (process.platform === "win32") {
      // Try ppid first (works if Claude Code spawns hooks directly without a shell).
      // If ppid is cmd.exe/powershell.exe, also kill its parent to reach the claude node.exe.
      const ppid = process.ppid;
      execSync(`taskkill /F /PID ${ppid}`, { stdio: "ignore" });
      try {
        // Walk one level higher: get the parent of ppid via WMIC.
        const out = execSync(
          `wmic process where processid=${ppid} get parentprocessid /format:value`,
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        );
        const m = out.match(/ParentProcessId=(\d+)/i);
        if (m) {
          const grandpid = parseInt(m[1], 10);
          if (grandpid > 4) {   // skip PID 4 (System) and 0
            execSync(`taskkill /F /PID ${grandpid}`, { stdio: "ignore" });
          }
        }
      } catch (_) { /* grandparent walk failed, ppid kill was enough */ }
    } else {
      // POSIX: SIGTERM to our direct parent (claude's node process)
      process.kill(process.ppid, "SIGTERM");
    }
  } catch (_) {
    // Fail silently — worst case the user sees the block message and types `exit`
  }
}

function hookPrompt() {
  const cfg  = loadConfig();
  const file = currentSessionFile();
  if (!file) { process.exit(0); }

  const w = computeWasteFactor(file, cfg);
  if (!w) { process.exit(0); }

  // Warning-light banner (stderr — the user-visible hook channel in Claude Code).
  // Suppressed when we're about to emit a block-decision JSON so the user sees
  // the full block banner instead of a redundant one-line warning beforehand.
  const willBlock = w.blocked && cfg.mode !== "shadow" && !process.env.ENTIENT_SPEND_SKIP;
  if (!willBlock) emitWarningLight(file);

  // Early warning: approaching threshold — run git savepoint now while Claude
  // is still alive and can finish any in-progress task cleanly.
  const saveThreshold = cfg.saveThreshold ?? 7;
  if (!w.blocked && w.factor >= saveThreshold && !process.env.ENTIENT_SPEND_SKIP) {
    if (cfg.mode === "shadow") logShadowEvent("approaching", file, w, cfg);
    const saved = gitSavepoint();
    if (saved.length > 0) {
      process.stderr.write(
        `[entient-spend] WARNING: session at ${w.factor}x waste — rotation approaching (threshold ${cfg.threshold}x).\n` +
        `[entient-spend] Auto-saved: ${saved.join(", ")}\n`
      );
    }
    process.exit(0);  // don't block yet
  }

  if (!w.blocked) { process.exit(0); }

  // Shadow mode: warn but never block
  if (cfg.mode === "shadow") {
    logShadowEvent("would_block_prompt", file, w, cfg);
    process.stderr.write(
      `[entient-spend] SHADOW: session at ${w.factor}x waste after ${w.turns} turns` +
      ` (enforce threshold: ${cfg.threshold}x). Observing only.\n`
    );
    process.exit(0);
  }

  // Save context before blocking
  saveSessionContext(file, w);

  const autoRestart = !!process.env.ENTIENT_SPEND_AUTORESTART;

  const msg = [
    `+${"-".repeat(60)}+`,
    `|  entient-spend: Session using ${w.factor}x more quota than start  `.padEnd(62) + "|",
    `+${"-".repeat(60)}+`,
    ``,
    `Your turns started at ~${w.baseline.toLocaleString()} tokens.`,
    `They're now at ~${w.current.toLocaleString()} tokens (${w.factor}x more per turn).`,
    `After ${w.turns} turns, each prompt costs ${w.factor}x what it did at session start.`,
    ``,
    autoRestart
      ? `Auto-restart is ON. Rotating session now...`
      : `Session context saved. Start fresh: run \`claude\``,
    `entient-spend will inject your previous context automatically.`,
    ``,
    `To continue anyway: set ENTIENT_SPEND_SKIP=1 in your environment.`,
  ].join("\n");

  if (process.env.ENTIENT_SPEND_SKIP) { process.exit(0); }

  // Output block decision first (so claude sees it before we kill the process)
  process.stdout.write(JSON.stringify({ decision: "block", reason: msg }) + "\n");

  // Auto-restart: write flag + kill claude so the loop wrapper relaunches it
  if (autoRestart) {
    triggerRestart(w);
  }

  process.exit(0);
}

function hookTool() {
  const cfg  = loadConfig();
  const file = currentSessionFile();
  if (!file || process.env.ENTIENT_SPEND_SKIP) { process.exit(0); }

  const w = computeWasteFactor(file, cfg);
  if (!w || !w.blocked) { process.exit(0); }

  // Shadow mode: warn but never block
  if (cfg.mode === "shadow") {
    logShadowEvent("would_block_tool", file, w, cfg);
    process.stderr.write(
      `[entient-spend] SHADOW: session at ${w.factor}x waste after ${w.turns} turns` +
      ` (enforce threshold: ${cfg.threshold}x). Observing only.\n`
    );
    process.exit(0);
  }

  saveSessionContext(file, w);

  const autoRestart = !!process.env.ENTIENT_SPEND_AUTORESTART;

  process.stderr.write(
    `[entient-spend] Session at ${w.factor}x waste (${w.turns} turns). ` +
    (autoRestart ? `Auto-restarting...\n` : `Start fresh: run \`claude\`. Context saved to ${LAST_SESSION}\n`)
  );

  if (autoRestart) triggerRestart(w);

  process.exit(2);  // exit code 2 = blocking error for PostToolUse
}

function hookCompact() {
  const file = currentSessionFile();
  if (!file) { process.exit(0); }
  const w = computeWasteFactor(file);
  saveSessionContext(file, w);
  process.exit(0);
}

function hookStart() {
  const parts = [];

  // Inject previous session context if recent
  if (fs.existsSync(LAST_SESSION)) {
    const age = Date.now() - fs.statSync(LAST_SESSION).mtimeMs;
    if (age <= 48 * 3_600_000) {
      parts.push(fs.readFileSync(LAST_SESSION, "utf8"));
    }
  }

  // Model recommendation — score last 7 days and advise on start model
  try {
    const { since } = parseWindow("7d");
    const sub = readSubscriptionActivity(since);
    if (sub.available && sub.totalPrompts >= 20) {
      const haikuPct = Math.round(sub.haikuEligible / sub.totalPrompts * 100);
      if (haikuPct >= 40) {
        parts.push(
          `## Model advisory (entient-spend)\n` +
          `${haikuPct}% of your last 7 days of prompts were Haiku-eligible — ` +
          `simple questions, confirmations, one-liners that ran on ${sub.configuredModel} unnecessarily.\n` +
          `Consider starting this session with \`/model haiku\` and escalating to Sonnet only when the task gets complex.\n` +
          `This could cut your token spend by 40–60% for light work.`
        );
      }
    }
  } catch (_) {}

  if (parts.length === 0) { process.exit(0); }

  process.stdout.write(JSON.stringify({ additionalContext: parts.join("\n\n---\n\n") }) + "\n");
  process.exit(0);
}

// Claude Code statusLine — one-line spend indicator rendered above the input box.
// Must be fast (≤ ~50ms) and fail-silent (a broken statusline hides itself).
function hookStatus() {
  try {
    const file = currentSessionFile();
    if (!file) { process.exit(0); }
    const cfg = loadConfig();
    const w = computeWasteFactor(file, cfg);
    const turns = _readSessionTurnsPriced(file);
    const cost = turns.length ? _sessionCostUSD(turns) : 0;

    const blockAt = cfg.threshold ?? 5;

    // Silent below both waste-2× AND cost-$2 — don't pollute statusline when nothing's happening.
    if ((!w || w.factor < 2) && cost < 2) { process.exit(0); }

    let indicator = "·";
    if ((w && w.factor >= blockAt) || cost >= 10) indicator = "⛔";
    else if ((w && w.factor >= 3) || cost >= 5)   indicator = "⚠";

    const segs = [`${indicator} spend`];
    if (w) segs.push(`${w.factor}×`, `${w.turns}t`);
    if (cost > 0) segs.push(`$${cost.toFixed(2)}`);

    process.stdout.write(segs.join(" · "));
  } catch (_) { /* fail silent */ }
  process.exit(0);
}

// ── Context preservation ─────────────────────────────────────────────────────

/**
 * Extract the last N assistant text blocks from a session JSONL file.
 * Returns a trimmed string, or null if nothing useful found.
 */
function getLastActivity(sessionFile, maxEntries = 2, maxCharsEach = 1200) {
  try {
    const raw   = fs.readFileSync(sessionFile, "utf8").trim();
    const lines = raw.split("\n").filter(Boolean);
    const excerpts = [];

    for (let i = lines.length - 1; i >= 0 && excerpts.length < maxEntries; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch (_) { continue; }

      // Claude Code session JSONL: messages have role "assistant" or wrapped in message.role
      const role = entry.role || entry.message?.role;
      if (role !== "assistant") continue;

      const content = entry.content ?? entry.message?.content ?? "";
      let text = "";
      if (Array.isArray(content)) {
        text = content
          .filter(c => c.type === "text")
          .map(c => c.text || "")
          .join("\n")
          .trim();
      } else {
        text = String(content).trim();
      }

      if (text.length < 20) continue;  // skip trivial ack messages
      excerpts.unshift(text.slice(0, maxCharsEach) + (text.length > maxCharsEach ? "…" : ""));
    }

    return excerpts.length > 0 ? excerpts.join("\n\n---\n\n") : null;
  } catch (_) { return null; }
}

function saveSessionContext(sessionFile, waste) {
  ensureAuditDir();

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const project    = path.basename(projectDir);
  const branch     = getGitBranch(projectDir);
  const modified   = getModifiedFiles(projectDir);
  const lastWork   = sessionFile ? getLastActivity(sessionFile) : null;

  const lines = [
    `# Previous Session (saved by entient-spend)`,
    ``,
    `- **Project:** ${project}`,
    `- **Directory:** ${projectDir}`,
    branch ? `- **Branch:** ${branch}` : null,
    `- **Saved:** ${new Date().toISOString()}`,
    waste ? `- **Session size:** ${waste.turns} turns, ~${(waste.current / 1000).toFixed(0)}k tokens/turn` : null,
    waste ? `- **Waste factor:** ${waste.factor}x (started at ~${(waste.baseline / 1000).toFixed(0)}k/turn)` : null,
    modified.length ? `- **Files modified:** ${modified.slice(0, 10).join(", ")}` : null,
    ``,
    `## Resume`,
    `Continue where you left off. The session was rotated to save quota.`,
    `Check git status for open changes.`,
    lastWork ? `\n## Last Activity\n${lastWork}` : null,
  ].filter(l => l !== null).join("\n");

  fs.writeFileSync(LAST_SESSION, lines, "utf8");
}

function getGitBranch(dir) {
  try {
    const headFile = path.join(dir, ".git", "HEAD");
    if (!fs.existsSync(headFile)) return null;
    const head = fs.readFileSync(headFile, "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 8);
  } catch (_) { return null; }
}

function getModifiedFiles(dir) {
  try {
    const { execSync } = require("child_process");
    return execSync("git diff --name-only HEAD 2>/dev/null", { cwd: dir, encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch (_) { return []; }
}

// ── Install / uninstall ──────────────────────────────────────────────────────

const HOOK_CMD = `node ${path.resolve(__filename)}`;

const HOOKS_TO_INSTALL = {
  UserPromptSubmit: `${HOOK_CMD} --hook prompt`,
  PostToolUse:      `${HOOK_CMD} --hook tool`,
  PreCompact:       `${HOOK_CMD} --hook compact`,
  SessionStart:     `${HOOK_CMD} --hook start`,
};

function install() {
  ensureAuditDir();

  let settings = {};
  if (fs.existsSync(CLAUDE_SETTINGS)) {
    try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8")); } catch (_) {}
  }
  if (!settings.hooks) settings.hooks = {};

  let added = 0;
  for (const [event, cmd] of Object.entries(HOOKS_TO_INSTALL)) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    // Don't double-install
    const already = settings.hooks[event].some(h =>
      (h.hooks || []).some(hh => (hh.command || "").includes("entient-spend"))
    );
    if (already) { console.log(`  ${event}: already installed`); continue; }

    settings.hooks[event].push({ hooks: [{ type: "command", command: cmd }] });
    console.log(`  ${event}: installed`);
    added++;
  }

  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), "utf8");

  if (added > 0) {
    console.log(`\n✓ entient-spend installed (${added} hooks added)`);
    console.log(`  Threshold: ${DEFAULTS.threshold}x waste factor`);
    console.log(`  Config:    ${CONFIG_FILE}`);
    console.log(`  Context:   ${LAST_SESSION}`);
    console.log(`\n  To skip enforcement on a session: set ENTIENT_SPEND_SKIP=1`);
  } else {
    console.log("\n✓ Already installed.");
  }
}

function installAutorestart() {
  // 1. Install base hooks (idempotent)
  install();

  // 2. Patch hooks to include ENTIENT_SPEND_AUTORESTART=1 in the env
  let settings = {};
  if (fs.existsSync(CLAUDE_SETTINGS)) {
    try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8")); } catch (_) {}
  }
  if (!settings.hooks) { console.log("  Base hooks not found. Run entient-spend install first."); return; }

  let patched = 0, alreadyPatched = 0;
  for (const event of ["UserPromptSubmit", "PostToolUse"]) {
    const hooks = settings.hooks[event] || [];
    for (const group of hooks) {
      for (const h of (group.hooks || [])) {
        if ((h.command || "").includes("entient-spend")) {
          if (!h.env || !h.env.ENTIENT_SPEND_AUTORESTART) {
            h.env = { ...(h.env || {}), ENTIENT_SPEND_AUTORESTART: "1" };
            patched++;
          } else {
            alreadyPatched++;
          }
        }
      }
    }
  }
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), "utf8");

  // 3. Write the loop script next to this file
  const loopScript = _claudeLoopScript();
  const loopPath   = path.join(path.dirname(path.resolve(__filename)), "claude-loop.ps1");
  fs.writeFileSync(loopPath, loopScript, "utf8");

  const patchNote = patched > 0
    ? `${patched} hooks patched`
    : `hooks already configured (${alreadyPatched} with AUTORESTART=1)`;
  console.log(`\n✓ Auto-restart enabled (${patchNote})`);
  console.log(`  Loop script: ${loopPath}`);
  console.log(`\n  USAGE:`);
  console.log(`    powershell -ExecutionPolicy Bypass -File "${loopPath}"`);
  console.log(`\n  Run that instead of 'claude'.`);
  console.log(`  When a session hits ${DEFAULTS.threshold}x waste, it will rotate automatically.`);
  console.log(`  Context is saved and injected into the fresh session.`);
  console.log(`\n  To revert: entient-spend uninstall`);
}

function _claudeLoopScript() {
  // PowerShell loop wrapper — runs claude inline (proper TTY, no Start-Process).
  // claude is an npm .cmd shim; cmd /c resolves it correctly and inherits the console.
  // The hook kills its parent node PID and writes the restart-flag.
  // When claude exits, check flag and relaunch.
  return String.raw`# claude-loop.ps1 -- generated by entient-spend install-autorestart
# Run this instead of 'claude'. Sessions rotate automatically when waste hits threshold.
# Usage: .\claude-loop.ps1

$flagPath    = Join-Path $HOME ".entient-spend\restart-flag"
$maxRestarts = 50
$restarts    = 0

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host "[claude-loop] ERROR: 'claude' not found in PATH." -ForegroundColor Red
    exit 1
}

Write-Host "[claude-loop] Starting. Auto-restart ON." -ForegroundColor Cyan
Write-Host "[claude-loop] Sessions rotate at waste threshold. Context injected on each start." -ForegroundColor DarkCyan
Write-Host ""

while ($restarts -lt $maxRestarts) {
    # cmd /c handles .cmd shims and inherits the current console (proper interactive TUI)
    cmd /c claude

    if (Test-Path $flagPath) {
        Remove-Item $flagPath -Force -ErrorAction SilentlyContinue
        $restarts++
        Write-Host ""
        Write-Host "[claude-loop] Session rotated ($restarts/$maxRestarts). Restarting..." -ForegroundColor Cyan
        Start-Sleep -Milliseconds 800
    } else {
        Write-Host ""
        Write-Host "[claude-loop] Session ended normally." -ForegroundColor Green
        break
    }
}

if ($restarts -ge $maxRestarts) {
    Write-Host "[claude-loop] Safety ceiling reached ($maxRestarts restarts). Exiting." -ForegroundColor Yellow
}
`;
}

function shadowReport() {
  if (!fs.existsSync(SHADOW_LOG)) {
    console.log("\n  No shadow events yet. Keep working — data accumulates as sessions run.\n");
    return;
  }

  const lines = fs.readFileSync(SHADOW_LOG, "utf8").split("\n").filter(Boolean);
  const events = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);

  if (events.length === 0) {
    console.log("\n  No shadow events logged yet.\n");
    return;
  }

  const byType   = {};
  const byFactor = {};
  const byProj   = {};
  let minFactor = Infinity, maxFactor = 0, sumFactor = 0;

  for (const e of events) {
    byType[e.event] = (byType[e.event] || 0) + 1;
    byProj[e.project] = (byProj[e.project] || 0) + 1;
    const bucket = Math.floor(e.factor);
    byFactor[bucket] = (byFactor[bucket] || 0) + 1;
    if (e.factor < minFactor) minFactor = e.factor;
    if (e.factor > maxFactor) maxFactor = e.factor;
    sumFactor += e.factor;
  }

  const avgFactor = (sumFactor / events.length).toFixed(1);
  const threshold = events[0]?.threshold ?? 10;
  const first = events[0]?.ts?.slice(0, 10) ?? "?";
  const last  = events[events.length - 1]?.ts?.slice(0, 10) ?? "?";

  console.log("");
  console.log(bold("  CLAUDE-AUDIT — SHADOW MODE REPORT"));
  console.log(`  ${SL}`);
  console.log(`  Period: ${first} → ${last}    Events: ${events.length}    Threshold: ${threshold}x`);
  console.log("");

  console.log(`  EVENT TYPES`);
  for (const [t, n] of Object.entries(byType).sort((a,b) => b[1]-a[1])) {
    const label = t === "would_block_prompt" ? "Would have blocked prompt" :
                  t === "would_block_tool"   ? "Would have blocked tool"  :
                  t === "approaching"        ? "Approaching (early warning)" : t;
    console.log(`    ${label.padEnd(32)}  ${n}`);
  }
  console.log("");

  console.log(`  WASTE FACTOR DISTRIBUTION  (when events fired)`);
  console.log(`    Min: ${minFactor}x    Avg: ${avgFactor}x    Max: ${maxFactor}x`);
  const buckets = Object.entries(byFactor).map(([k,v]) => [parseInt(k),v]).sort((a,b)=>a[0]-b[0]);
  for (const [f, n] of buckets) {
    const bar = "█".repeat(Math.min(n, 30));
    console.log(`    ${(f+"x–"+(f+1)+"x").padEnd(10)}  ${String(n).padStart(3)}  ${dim(bar)}`);
  }
  console.log("");

  // Threshold recommendation
  const wouldBlock = events.filter(e => e.event !== "approaching");
  const lowFires = wouldBlock.filter(e => e.factor < 5).length;
  const medFires = wouldBlock.filter(e => e.factor >= 5 && e.factor < 10).length;
  console.log(`  THRESHOLD SIGNAL`);
  if (wouldBlock.length === 0) {
    console.log(`    No full-block events yet — only early warnings. Current ${threshold}x threshold hasn't been hit.`);
  } else if (avgFactor < 6) {
    console.log(`    Avg factor at fire: ${avgFactor}x — threshold ${threshold}x is TOO HIGH.`);
    console.log(`    Recommend: lower to 5x-6x to catch sessions earlier.`);
  } else if (avgFactor > threshold * 0.9) {
    console.log(`    Avg factor at fire: ${avgFactor}x — sessions were already deep when caught.`);
    console.log(`    Recommend: lower threshold to ${Math.round(avgFactor * 0.6)}x-${Math.round(avgFactor * 0.7)}x.`);
  } else {
    console.log(`    Avg factor at fire: ${avgFactor}x — threshold ${threshold}x looks reasonable.`);
  }
  console.log("");

  console.log(`  TOP PROJECTS`);
  for (const [proj, n] of Object.entries(byProj).sort((a,b) => b[1]-a[1]).slice(0, 5)) {
    console.log(`    ${proj.slice(0, 40).padEnd(40)}  ${n} event(s)`);
  }
  console.log("");
  console.log(`  Log: ${SHADOW_LOG}`);
  console.log(`  To reset: delete the log file and start fresh.`);
  console.log("");
}

function installShadow() {
  // 1. Install base hooks (idempotent)
  install();

  // 2. Write mode: shadow to config
  const cfg = saveConfig({ mode: "shadow" });
  console.log(`\n  Shadow mode ON.`);
  console.log(`  Hooks will warn (stderr) when waste threshold is exceeded, but will NOT block.`);
  console.log(`  To upgrade to full enforcement: entient-spend install`);
  console.log(`  Config: ${CONFIG_FILE}  (mode: "${cfg.mode}", threshold: ${cfg.threshold}x)`);
}

function uninstall() {
  if (!fs.existsSync(CLAUDE_SETTINGS)) {
    console.log("No settings.json found.");
    return;
  }
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8")); } catch (_) {}
  if (!settings.hooks) { console.log("No hooks installed."); return; }

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(h =>
      !(h.hooks || []).some(hh => (hh.command || "").includes("entient-spend"))
    );
    removed += before - settings.hooks[event].length;
  }
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), "utf8");
  console.log(`✓ Removed ${removed} entient-spend hook(s).`);
}

function status() {
  console.log("── entient-spend status ──\n");

  // Hook installation
  let hooksInstalled = 0;
  if (fs.existsSync(CLAUDE_SETTINGS)) {
    try {
      const s = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8"));
      for (const event of Object.keys(HOOKS_TO_INSTALL)) {
        const hooks = s.hooks?.[event] || [];
        const found = hooks.some(h => (h.hooks || []).some(hh => (hh.command || "").includes("entient-spend")));
        console.log(`  ${event.padEnd(22)} ${found ? "✓ installed" : "✗ not installed"}`);
        if (found) hooksInstalled++;
      }
    } catch (_) {}
  }

  // Current session waste
  const file = currentSessionFile();
  if (file) {
    const w = computeWasteFactor(file);
    console.log(`\n  Current session:`);
    console.log(`    Turns:         ${w.turns}`);
    if (w.baseline) {
      console.log(`    Baseline:      ~${(w.baseline/1000).toFixed(0)}k tokens/turn`);
      console.log(`    Current:       ~${(w.current/1000).toFixed(0)}k tokens/turn`);
      const cfg2 = loadConfig();
      console.log(`    Waste factor:  ${w.factor}x ${w.factor >= cfg2.threshold ? "⚠ WOULD BLOCK" : w.factor >= cfg2.saveThreshold ? "⚠ APPROACHING" : "✓ ok"}`);
    }
  }

  // Saved context
  if (fs.existsSync(LAST_SESSION)) {
    const age = Math.round((Date.now() - fs.statSync(LAST_SESSION).mtimeMs) / 60000);
    console.log(`\n  Saved context:   ${LAST_SESSION} (${age}min ago)`);
  }

  const cfg = loadConfig();
  const modeLabel = cfg.mode === "shadow" ? "shadow (warn only, no blocking)" : "enforce (blocks at threshold)";
  console.log(`\n  Mode: ${modeLabel}`);
  console.log(`  ${hooksInstalled === 4 ? "✓ Fully installed" : `⚠ Run 'entient-spend install' to enable enforcement`}`);
}

// ── Analytics (original report) ─────────────────────────────────────────────

// Classifier v2 (2026-04-17) — mirror in audit/run_audit.js and bump AUDIT_SPEC.md.
// v1 over-called "continuation" via ACK prefix ("ok but I want to...") and
// under-called "low" because LOW_RE vocab was too narrow. v2 strips a leading
// ACK ("ok,"/"good"/"sure",...) before the lookup check and requires word count
// ≤ SHORT_ACK on the stripped remainder for continuation.
const CONTINUATION_RE = /^(proceed|continue|do it|go ahead|yes|no|ok|good|both|all|now do|next|great|sounds|done|sure|right|correct|perfect|got it|makes sense|agreed)\b/i;
const ACK_PREFIX_RE   = /^(ok|yeah|yes|no|sure|good|great|alright|perfect|right|cool|nice|got it)[,.:\s]+/i;
const SHORT_ACK       = 8;
const HIGH_RE         = /traceback|error:|exception:|nameerror|typeerror|assertionerror|```|architect|implement|refactor|generate code|write.*test|update.*spec/i;
const LOW_RE          = /^(where is|what is|what are|what was|whats|did you|do we|do i|does the|does it|how do|how many|can you show|rename it|it wasn.t)\b/i;
const LOW_MAX_WORDS   = 15;

function stripAckPrefix(t) {
  let core = t;
  for (let i = 0; i < 2; i++) {
    const s = core.replace(ACK_PREFIX_RE, "");
    if (s === core) break;
    core = s;
  }
  return core;
}

function classifyPromptComplexity(text) {
  const t = (text || "").trim();
  if (!t) return "empty";
  if (HIGH_RE.test(t)) return "high";
  const core = stripAckPrefix(t);
  const wc = core.split(/\s+/).length;
  // `low` is a narrow lookup — cap word count so multi-part questions that
  // happen to start "do i have to ..." fall through to medium.
  if (LOW_RE.test(core) && wc <= LOW_MAX_WORDS) return "low";
  if (wc <= SHORT_ACK) return "continuation";
  return "medium";
}

function readConfiguredModel() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8")).model || "sonnet";
  } catch (_) { return "sonnet"; }
}

function readSubscriptionActivity(since) {
  if (!fs.existsSync(CLAUDE_HISTORY)) {
    return { available: false, reason: "~/.claude/history.jsonl not found" };
  }
  const sinceMs  = since.getTime();
  const sessions = {}, daily = {}, projects = {};
  const complexity = { continuation: 0, low: 0, medium: 0, high: 0, empty: 0 };
  let total = 0;

  try {
    for (const line of fs.readFileSync(CLAUDE_HISTORY, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (_) { continue; }
      const ts = rec.timestamp || 0;
      if (ts < sinceMs) continue;

      const sid  = rec.sessionId || "unknown";
      const proj = path.basename(rec.project || "unknown");
      const day  = new Date(ts).toISOString().slice(0, 10);
      const cat  = classifyPromptComplexity(rec.display || "");

      if (!sessions[sid]) sessions[sid] = { project: proj, prompts: 0, firstTs: ts, lastTs: ts, complexity: {}, firstHighTurn: -1, first5: [] };
      const turnIdx = sessions[sid].prompts;
      if (sessions[sid].first5.length < 5) sessions[sid].first5.push(cat);
      if (cat === "high" && sessions[sid].firstHighTurn === -1) sessions[sid].firstHighTurn = turnIdx;
      sessions[sid].prompts++;
      sessions[sid].lastTs = Math.max(sessions[sid].lastTs, ts);
      sessions[sid].complexity[cat] = (sessions[sid].complexity[cat] || 0) + 1;

      daily[day]      = (daily[day]     || 0) + 1;
      projects[proj]  = (projects[proj] || 0) + 1;
      complexity[cat] = (complexity[cat] || 0) + 1;
      total++;
    }
  } catch (e) { return { available: false, reason: e.message }; }

  const configuredModel = readConfiguredModel();
  const topSessions = Object.entries(sessions).map(([sid, s]) => ({ sid, ...s })).sort((a, b) => b.prompts - a.prompts);
  const haikuEligible = (complexity.continuation || 0) + (complexity.low || 0);
  const wasteAnalysis = analyzeSessionWaste(topSessions.slice(0, 10), configuredModel);

  return { available: true, totalPrompts: total, configuredModel, complexity, haikuEligible, dailyCounts: daily, topProjects: Object.entries(projects).sort((a, b) => b[1] - a[1]).slice(0, 8), topSessions: topSessions.slice(0, 10), wasteAnalysis };
}

const MODEL_COST_PER_M = { opus: 15.00, sonnet: 3.00, haiku: 0.80 };

function analyzeSessionWaste(topSessions, configuredModel) {
  return topSessions.map(session => {
    const t  = session.prompts;
    const cx = session.complexity || {};
    const ackCount = cx.continuation || 0, lowCount = cx.low || 0, highCount = cx.high || 0;
    const haikuCount = ackCount + lowCount;
    const ackPct = t > 0 ? ackCount / t : 0, highPct = t > 0 ? highCount / t : 0, haikuPct = t > 0 ? haikuCount / t : 0;
    const durationHrs = (session.lastTs - session.firstTs) / 3_600_000;
    const longContextRisk = t > 40 || durationHrs > 2 ? "high" : t > 15 || durationHrs > 0.5 ? "medium" : "low";
    const first5High = (session.first5 || []).filter(c => c === "high").length;
    const firstHighTurn = session.firstHighTurn != null ? session.firstHighTurn : -1;
    const opensHard = first5High >= 2 || (firstHighTurn >= 0 && firstHighTurn < 5);

    let recommendedStartModel, escalation;
    if (firstHighTurn === -1)     { recommendedStartModel = "haiku";  escalation = "no escalation needed"; }
    else if (opensHard)           { recommendedStartModel = "sonnet"; escalation = `sonnet from start (complexity at turn ${firstHighTurn})`; }
    else if (firstHighTurn > 10)  { recommendedStartModel = "haiku";  escalation = `haiku → sonnet at turn ${firstHighTurn}`; }
    else                          { recommendedStartModel = "sonnet"; escalation = `sonnet from turn ${firstHighTurn}`; }

    const wasteTypes = [];
    if (haikuPct >= 0.50 && configuredModel !== "haiku") wasteTypes.push("wrong_model");
    if (ackPct  >= 0.35 && t > 12)                       wasteTypes.push("session_bloat");
    if (longContextRisk === "high")                       wasteTypes.push("context_replay");

    const configCostPerM = MODEL_COST_PER_M[configuredModel] || MODEL_COST_PER_M["sonnet"];
    const estimatedWaste = haikuCount * 300 / 1_000_000 * (configCostPerM - MODEL_COST_PER_M["haiku"]);

    return { sid: session.sid, project: session.project, prompts: t, firstTs: session.firstTs, lastTs: session.lastTs, durationHrs: Math.round(durationHrs * 10) / 10, ackPct: Math.round(ackPct * 100), highPct: Math.round(highPct * 100), haikuPct: Math.round(haikuPct * 100), longContextRisk, recommendedStartModel, escalation, wasteTypes, estimatedWaste: Math.round(estimatedWaste * 10000) / 10000 };
  });
}

// ── Token-based billing computation ─────────────────────────────────────────
//
// Reads every session JSONL file and sums actual token usage.
// Applies Anthropic's current pricing to produce per-day, per-project cost.
// This matches what Anthropic bills for API/overage charges (±5%).
//
// Sonnet 3.5 / 4.x pricing (per million tokens):
//   Input:          $3.00
//   Output:        $15.00
//   Cache create:   $3.75  (1.25× input)
//   Cache read:     $0.30  (0.1× input)

const TOKEN_PRICES = {
  // model substring → { in, out, cacheCreate, cacheRead }
  "opus":   { in: 15.00, out: 75.00, cacheCreate: 18.75, cacheRead: 1.50  },
  "sonnet": { in:  3.00, out: 15.00, cacheCreate:  3.75, cacheRead: 0.30  },
  "haiku":  { in:  0.80, out:  4.00, cacheCreate:  1.00, cacheRead: 0.08  },
};

function priceForModel(modelStr) {
  if (!modelStr) return TOKEN_PRICES.sonnet;
  const m = modelStr.toLowerCase();
  if (m.includes("opus"))   return TOKEN_PRICES.opus;
  if (m.includes("haiku"))  return TOKEN_PRICES.haiku;
  return TOKEN_PRICES.sonnet;
}

function tokCost(p, inp, out, cc, cr) {
  return (inp / 1e6 * p.in) + (out / 1e6 * p.out) +
         (cc  / 1e6 * p.cacheCreate) + (cr / 1e6 * p.cacheRead);
}

// ── Warning-light banner (v1: edge-triggered, max 3 fires per session) ──────
// Fire 1: session cost crosses $5  (warn)
// Fire 2: session cost crosses $10 (alarm)
// Fire 3: model tier bumps upward mid-session (haiku<sonnet<opus), once
// State persisted at FIRE_STATE_FILE, keyed by CLAUDE_SESSION_ID.
// Fail-silent: any error returns without writing stdout.

function _modelTier(modelStr) {
  if (!modelStr) return 0;
  const m = modelStr.toLowerCase();
  if (m.includes("opus"))   return 3;
  if (m.includes("sonnet")) return 2;
  if (m.includes("haiku"))  return 1;
  return 0;
}

function _tierName(tier) {
  return ({1:"Haiku",2:"Sonnet",3:"Opus"})[tier] || "?";
}

function _readSessionTurnsPriced(sessionFile) {
  if (!fs.existsSync(sessionFile)) return [];
  const turns = [];
  let cur = null;
  try {
    const lines = fs.readFileSync(sessionFile, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec; try { rec = JSON.parse(line); } catch (_) { continue; }
      const type = rec.type || (rec.message && rec.message.role);
      if (type === "user" || rec.message?.role === "user") {
        if (cur) turns.push(cur);
        cur = { model: null, inp: 0, out: 0, cc: 0, cr: 0 };
      }
      if ((type === "assistant" || rec.message?.role === "assistant") && cur) {
        const u = rec.message?.usage || rec.usage || {};
        cur.model = rec.message?.model || rec.model || cur.model;
        cur.inp += u.input_tokens || 0;
        cur.out += u.output_tokens || 0;
        cur.cc  += u.cache_creation_input_tokens || 0;
        cur.cr  += u.cache_read_input_tokens || 0;
      }
    }
    if (cur && (cur.inp + cur.out + cur.cc + cur.cr) > 0) turns.push(cur);
  } catch (_) {}
  return turns.filter(t => t.model);
}

function _sessionCostUSD(turns) {
  let total = 0;
  for (const t of turns) {
    const p = priceForModel(t.model);
    total += tokCost(p, t.inp, t.out, t.cc, t.cr);
  }
  return total;
}

function _loadFireState() {
  try {
    if (!fs.existsSync(FIRE_STATE_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(FIRE_STATE_FILE, "utf8"));
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) { return {}; }
}

function _saveFireState(all) {
  try {
    ensureAuditDir();
    const tmp = FIRE_STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, FIRE_STATE_FILE);
  } catch (_) {}
}

function _pruneFireState(all) {
  const now = Date.now(), TTL = 48 * 3600 * 1000;
  for (const sid of Object.keys(all)) {
    if (now - (all[sid]._ts || 0) > TTL) delete all[sid];
  }
  return all;
}

function emitWarningLight(sessionFile) {
  try {
    const sid = currentSessionId();
    if (!sid) return;
    const turns = _readSessionTurnsPriced(sessionFile);
    if (!turns.length) return;

    const cost = _sessionCostUSD(turns);
    const firstTier = _modelTier(turns[0].model);
    let maxTier = firstTier;
    for (const t of turns) {
      const tier = _modelTier(t.model);
      if (tier > maxTier) maxTier = tier;
    }

    const all = _pruneFireState(_loadFireState());
    const st = all[sid] || { warn5: false, alarm10: false, bump: false, _ts: Date.now() };

    let line = null;
    if (!st.alarm10 && cost >= 10) {
      line = `SPEND⛔ session $${cost.toFixed(2)} (alarm)`;
      st.alarm10 = true;
      st.warn5   = true; // suppress warn if we crossed both in one step
    } else if (!st.warn5 && cost >= 5) {
      line = `SPEND⚠ session $${cost.toFixed(2)} (warn)`;
      st.warn5 = true;
    } else if (!st.bump && maxTier > firstTier && firstTier > 0) {
      line = `SPEND⚠ model bumped ${_tierName(firstTier)}→${_tierName(maxTier)}`;
      st.bump = true;
    }

    if (line) {
      st._ts = Date.now();
      all[sid] = st;
      _saveFireState(all);
      // stderr = user-visible channel in Claude Code (matches existing waste-factor warnings).
      process.stderr.write(line + "\n");
    }
  } catch (_) { /* fail silent */ }
}

/**
 * Scan all session JSONL files and produce a real token-based billing report.
 * Returns { ok, days, projects, sessions, totalCost, totalTokens }
 */
function computeTokenBilling(since) {
  if (!fs.existsSync(PROJECTS_DIR)) return { ok: false, reason: "no projects dir" };

  const sinceMs = since.getTime();
  const byDay     = {};  // date → { cost, inp, out, cc, cr, projects:{} }
  const byProject = {};  // project → { cost, sessions: 0 }
  const bySid     = {};  // sessionId → { project, date, cost, inp, out, turns }

  for (const dir of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const projDir  = path.join(PROJECTS_DIR, dir.name);
    // Decode project name from encoded dir (replace leading/trailing dashes, unescape)
    const projName = path.basename(
      dir.name.replace(/^-+/, "").replace(/-([A-Z]):/g, "$1:").replace(/-/g, path.sep)
    ).slice(0, 32) || dir.name.slice(0, 20);

    let files;
    try { files = fs.readdirSync(projDir).filter(f => f.endsWith(".jsonl")); }
    catch (_) { continue; }

    for (const fname of files) {
      const fpath = path.join(projDir, fname);
      try {
        const stat = fs.statSync(fpath);
        // Skip files that haven't been touched since our window opened
        if (stat.mtimeMs < sinceMs) continue;
      } catch (_) { continue; }

      const sid = fname.replace(".jsonl", "");
      let sidCost = 0, sidInp = 0, sidOut = 0, sidCC = 0, sidCR = 0;
      let sidDate = null, sidTs = 0, turns = 0;
      let firstTurnInput = 0, lastTurnInput = 0;

      // Use file mtime as the date anchor — most reliable for session files
      const fileMtime = fs.statSync(fpath).mtimeMs;
      sidDate = new Date(fileMtime).toISOString().slice(0, 10);

      try {
        for (const line of fs.readFileSync(fpath, "utf8").split("\n")) {
          if (!line.trim()) continue;
          let rec; try { rec = JSON.parse(line); } catch (_) { continue; }

          const usage = rec.message?.usage || rec.usage || {};
          const inp = usage.input_tokens || 0;
          const out = usage.output_tokens || 0;
          const cc  = usage.cache_creation_input_tokens || 0;
          const cr  = usage.cache_read_input_tokens || 0;

          if (!inp && !out && !cc && !cr) continue;

          // Refine date from record timestamp if available
          const ts = rec.timestamp || rec.message?.timestamp || 0;
          if (ts > sinceMs && ts > sidTs) {
            sidTs = ts;
            sidDate = new Date(ts).toISOString().slice(0, 10);
          }

          const model = rec.message?.model || rec.model || "";
          const p     = priceForModel(model);
          const cost  = tokCost(p, inp, out, cc, cr);

          sidCost += cost; sidInp += inp; sidOut += out; sidCC += cc; sidCR += cr;
          if (inp || out || cc || cr) {
            turns++;
            // Track startup (first turn) and last turn total input for overhead computation
            // Total input = new tokens + cache_creation + cache_read (all paid on this turn)
            const totalInp = inp + cc + cr;
            if (turns === 1 && totalInp > 0) firstTurnInput = totalInp;
            if (totalInp > 0) lastTurnInput = totalInp;
          }
        }
      } catch (_) { continue; }

      if (sidCost === 0) continue;

      // Accumulate into day bucket
      if (!byDay[sidDate]) byDay[sidDate] = { date: sidDate, cost: 0, inp: 0, out: 0, cc: 0, cr: 0, projects: {} };
      byDay[sidDate].cost += sidCost;
      byDay[sidDate].inp  += sidInp;
      byDay[sidDate].out  += sidOut;
      byDay[sidDate].cc   += sidCC;
      byDay[sidDate].cr   += sidCR;
      byDay[sidDate].projects[projName] = (byDay[sidDate].projects[projName] || 0) + sidCost;

      // Project totals
      if (!byProject[projName]) byProject[projName] = { cost: 0, sessions: 0, tokens: 0 };
      byProject[projName].cost     += sidCost;
      byProject[projName].sessions += 1;
      byProject[projName].tokens   += sidInp + sidOut + sidCC + sidCR;

      bySid[sid] = { project: projName, date: sidDate, cost: sidCost, inp: sidInp, out: sidOut, turns, firstTurnInput, lastTurnInput };
    }
  }

  const days     = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
  const projects = Object.entries(byProject).sort((a, b) => b[1].cost - a[1].cost).map(([name, v]) => ({ name, ...v }));
  const totalCost   = days.reduce((s, d) => s + d.cost, 0);
  const totalTokens = days.reduce((s, d) => s + d.inp + d.out + d.cc + d.cr, 0);

  // ── Startup overhead stats ───────────────────────────────────────────────
  // firstTurnInput = system prompt + tools + first message — the minimum you pay per session
  // avgGrowthPerTurn = (lastTurnInput - firstTurnInput) / (turns - 1) ≈ size of each new exchange
  // toolOverhead = firstTurnInput - avgGrowthPerTurn (excess over a single "blank" turn)
  const sidArr = Object.values(bySid).filter(s => s.turns >= 2 && s.firstTurnInput > 0);
  let startupStats = null;
  if (sidArr.length > 0) {
    const firstTurns = sidArr.map(s => s.firstTurnInput);
    const avgFirstTurn = Math.round(avg(firstTurns));
    const growths = sidArr
      .filter(s => s.turns > 1 && s.lastTurnInput > s.firstTurnInput)
      .map(s => (s.lastTurnInput - s.firstTurnInput) / (s.turns - 1));
    const avgGrowthPerTurn = growths.length ? Math.round(avg(growths)) : 0;
    // Overhead = first-turn cost minus what a single exchange would cost
    const overheadPerSession = Math.max(0, avgFirstTurn - avgGrowthPerTurn);
    const totalStartupTokens = firstTurns.reduce((a, b) => a + b, 0);
    const totalOverheadTokens = sidArr.reduce((sum, s) => {
      const growth = (s.turns > 1 && s.lastTurnInput > s.firstTurnInput)
        ? (s.lastTurnInput - s.firstTurnInput) / (s.turns - 1) : 0;
      return sum + Math.max(0, s.firstTurnInput - growth);
    }, 0);
    // Cost of startup overhead at Sonnet rates (most common model)
    const overheadCost = totalOverheadTokens / 1e6 * TOKEN_PRICES.sonnet.in;
    startupStats = {
      sessions: sidArr.length,
      avgFirstTurn,
      avgGrowthPerTurn,
      overheadPerSession: Math.round(overheadPerSession),
      totalStartupTokens: Math.round(totalStartupTokens),
      totalOverheadTokens: Math.round(totalOverheadTokens),
      overheadCost,
      // Flag if overhead is meaningful (>3k tokens per session = significant tool loading)
      significant: overheadPerSession > 3000,
    };
  }

  return { ok: true, days, projects, sessions: bySid, totalCost, totalTokens, startupStats };
}

// ── Doctor — version/cache bug check ────────────────────────────────────────

// Known bad versions with broken prompt caching (10-20x token burn)
// Source: community reports + clauditor detection
const CACHE_BUG_RANGE = { min: [2,1,69], max: [2,1,89] };

function parseVersion(v) {
  return (v || "").split(".").map(Number);
}

function versionInRange(v, min, max) {
  const [ma, mi, pa] = parseVersion(v);
  const [minA, minI, minP] = min;
  const [maxA, maxI, maxP] = max;
  const toInt = (a, i, p) => a * 1_000_000 + i * 1_000 + p;
  const n = toInt(ma, mi, pa);
  return n >= toInt(minA, minI, minP) && n <= toInt(maxA, maxI, maxP);
}

function doctor() {
  console.log("\n  entient-spend doctor\n");

  // Current version
  try {
    const { execSync } = require("child_process");
    const ver = execSync("claude --version 2>/dev/null || claude --version 2>&1", { encoding: "utf8" }).trim();
    const match = ver.match(/(\d+\.\d+\.\d+)/);
    const current = match ? match[1] : null;
    if (current) {
      const buggy = versionInRange(current, CACHE_BUG_RANGE.min, CACHE_BUG_RANGE.max);
      if (buggy) {
        console.log(`  ⚠ Current version: ${current}  — CACHE BUG ACTIVE`);
        console.log(`    Versions 2.1.69–2.1.89 have broken prompt caching.`);
        console.log(`    This causes 10-20x token burn. Run: claude update`);
      } else {
        console.log(`  ✓ Current version: ${current}  — no known cache bugs`);
      }
    }
  } catch (_) {
    console.log("  (could not detect claude version)");
  }

  // Scan historical sessions for buggy versions
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.log("\n  No session data found.");
    return;
  }

  let totalSessions = 0, buggedSessions = 0, buggedTokens = 0, cleanTokens = 0;
  const versionCounts = {};

  const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(PROJECTS_DIR, d.name));

  for (const pd of projectDirs) {
    const jsonls = fs.readdirSync(pd).filter(f => f.endsWith(".jsonl"));
    for (const jf of jsonls) {
      const fullPath = path.join(pd, jf);
      // Only scan recent files (last 14 days) for speed
      try {
        const stat = fs.statSync(fullPath);
        if (Date.now() - stat.mtimeMs > 14 * 86_400_000) continue;
      } catch (_) { continue; }

      let sessionVersion = null, sessionTokens = 0;
      try {
        const lines = fs.readFileSync(fullPath, "utf8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          let rec;
          try { rec = JSON.parse(line); } catch (_) { continue; }

          // Extract version
          if (!sessionVersion && rec.version) sessionVersion = rec.version;

          // Sum tokens
          const usage = rec.message?.usage || rec.usage || {};
          sessionTokens += (usage.input_tokens || 0)
            + (usage.cache_creation_input_tokens || 0)
            + (usage.cache_read_input_tokens || 0)
            + (usage.output_tokens || 0);
        }
      } catch (_) { continue; }

      if (sessionTokens === 0) continue;
      totalSessions++;

      if (sessionVersion) {
        versionCounts[sessionVersion] = (versionCounts[sessionVersion] || 0) + 1;
        if (versionInRange(sessionVersion, CACHE_BUG_RANGE.min, CACHE_BUG_RANGE.max)) {
          buggedSessions++;
          buggedTokens += sessionTokens;
        } else {
          cleanTokens += sessionTokens;
        }
      }
    }
  }

  console.log(`\n  Sessions scanned (last 14d): ${totalSessions}`);

  if (buggedSessions > 0) {
    const pct = Math.round(buggedSessions / totalSessions * 100);
    const buggedM = (buggedTokens / 1_000_000).toFixed(0);
    console.log(`\n  ⚠ CACHE BUG IMPACT`);
    console.log(`    ${buggedSessions} of ${totalSessions} sessions (${pct}%) ran on a buggy version`);
    console.log(`    ~${buggedM}M tokens consumed under broken caching`);
    console.log(`    Estimated real cost was 2-5x higher than it should have been`);
    console.log(`    These sessions cannot be recovered — the tokens are spent`);
  } else if (totalSessions > 0) {
    console.log(`  ✓ No sessions affected by the cache bug`);
  }

  // Version breakdown
  const versions = Object.entries(versionCounts).sort((a, b) => b[1] - a[1]);
  if (versions.length > 0) {
    console.log(`\n  Versions seen:`);
    for (const [v, count] of versions.slice(0, 6)) {
      const flag = versionInRange(v, CACHE_BUG_RANGE.min, CACHE_BUG_RANGE.max) ? "  ⚠ cache bug" : "";
      console.log(`    ${v.padEnd(12)} ${count} session(s)${flag}`);
    }
  }

  console.log(`\n  Fix: claude update  (installs latest, currently 2.1.91+)\n`);
}

// ── Report formatter ─────────────────────────────────────────────────────────

const W = 62;
const hr = (ch = "-") => ch.repeat(W);

function formatReport(sub, window) {
  const lines = [];
  lines.push(hr("="));
  lines.push(`  CLAUDE CODE WASTE REPORT  (last ${window})`);
  lines.push(hr("="));

  if (!sub.available) { lines.push(`  ERROR: ${sub.reason}`); lines.push(hr("=")); return lines.join("\n"); }

  const t = sub.totalPrompts, c = sub.complexity;
  const haiku = sub.haikuEligible, haikuPct = t > 0 ? (haiku / t * 100).toFixed(0) : 0;
  const model = sub.configuredModel;

  lines.push(`  Configured model:                 ${model}`);
  lines.push(`  Total prompts:                    ${t.toLocaleString()} (last ${window})`);
  lines.push(`  Haiku-eligible (ran on ${model}):  ${haiku} (${haikuPct}%)`);
  lines.push("");
  lines.push("  Prompt complexity breakdown:");
  for (const [key, label] of [["continuation","ACK / continuation  (Haiku-trivial)"],["low","Low complexity      (Haiku-ok)      "],["medium","Medium              (ambiguous)     "],["high","High complexity     (Sonnet needed) "]]) {
    const n = c[key] || 0, pct = t > 0 ? (n / t * 100).toFixed(1) : "0.0";
    lines.push(`    ${label}  ${String(n).padStart(4)}  (${pct}%)  ${"#".repeat(Math.round(n / (t||1) * 22))}`);
  }
  lines.push("");

  lines.push("  Daily activity:");
  for (const [day, count] of Object.entries(sub.dailyCounts).sort()) {
    lines.push(`    ${day}  ${String(count).padStart(4)}  ${"#".repeat(Math.min(Math.round(count / 5), 28))}`);
  }
  lines.push("");

  lines.push(hr());
  lines.push("  SESSION WASTE ANALYSIS  (top 10 sessions)");
  lines.push(hr());
  lines.push("");

  if (model === "opus") lines.push("  [!!] ALL SESSIONS RAN ON OPUS — even ACKs cost 5x Sonnet\n");

  for (const [idx, s] of (sub.wasteAnalysis || []).entries()) {
    const dt = new Date(s.lastTs).toISOString().slice(0, 16).replace("T", " ");
    lines.push(`  ${idx + 1}. ${s.project}  [${s.sid.slice(0, 8)}]  ${dt}`);
    lines.push(`     ${s.prompts} turns / ${s.durationHrs}h  |  ACK ${s.ackPct}%  High ${s.highPct}%  Haiku-ok ${s.haikuPct}%`);
    lines.push(`     Context risk: ${s.longContextRisk.toUpperCase()}  |  Recommend: ${s.recommendedStartModel.toUpperCase()} — ${s.escalation}`);
    if (s.wasteTypes.length) {
      const labels = { wrong_model: `wrong model (${s.haikuPct}% haiku-eligible)`, session_bloat: `session bloat (${s.ackPct}% ACKs)`, context_replay: `context replay (${s.durationHrs}h, 30+ turns)` };
      lines.push(`     ⚠ Waste: ${s.wasteTypes.map(w => labels[w]).join(" + ")}`);
    }
    lines.push("");
  }

  lines.push(hr());
  lines.push("  WHAT TO DO  (based on your actual data)");
  lines.push(hr());
  const wa2 = sub.wasteAnalysis || [];
  const hasWrongModel   = wa2.some(s => s.wasteTypes.includes("wrong_model"));
  const hasBloat        = wa2.some(s => s.wasteTypes.includes("session_bloat"));
  const hasReplay       = wa2.some(s => s.wasteTypes.includes("context_replay"));
  const enforced2       = hooksInstalled();
  const topBloatPct     = wa2.filter(s=>s.wasteTypes.includes("session_bloat")).reduce((m,s)=>Math.max(m,s.ackPct),0);
  const topReplayH      = wa2.filter(s=>s.wasteTypes.includes("context_replay")).reduce((m,s)=>Math.max(m,s.durationHrs),0);
  const worstModel      = wa2.find(s=>s.wasteTypes.includes("wrong_model"));
  let step = 1;
  if (hasWrongModel) {
    lines.push(`  ${step++}. Your biggest sessions ran ${model} on ${worstModel.haikuPct}% Haiku-eligible prompts.`);
    lines.push(`     Start those sessions with /model haiku.`);
    lines.push(`     Switch to sonnet only when you hit real complexity.`);
    lines.push("");
  }
  if (hasBloat) {
    lines.push(`  ${step++}. ${topBloatPct}% of your turns were one-word confirmations.`);
    lines.push(`     Each "ok" re-sent your full context. Batch your intent instead —`);
    lines.push(`     combine what would be 3 turns into 1.`);
    lines.push("");
  }
  if (hasReplay) {
    lines.push(`  ${step++}. Your longest session ran ${topReplayH}h. By turn 30 context costs`);
    lines.push(`     10-20x more per prompt than when it started.`);
    lines.push(`     Use /compact or start a fresh session after ~30 turns.`);
    lines.push("");
  }
  if (!enforced2) {
    lines.push(`  ${step++}. Run entient-spend install to enforce this automatically.`);
    lines.push(`     Sessions get blocked at 10x waste. Context saved. Injected on resume.`);
    lines.push("");
  } else {
    lines.push(`  ${step++}. Enforcement is ON. Sessions will be blocked at 10x waste.`);
    lines.push(`     Config: ~/.entient-spend/config.json`);
    lines.push("");
  }
  if (!hasWrongModel && !hasBloat && !hasReplay) {
    lines.push("  No significant waste patterns detected in this window.");
    lines.push("  Your sessions look clean.");
    lines.push("");
  }
  lines.push("  entient.com — routes each prompt to the right model, deflects repeats");
  lines.push("");
  lines.push(hr("="));
  lines.push(`  Generated ${new Date().toISOString().slice(0, 19).replace("T", " ")}`);
  lines.push(hr("="));

  return lines.join("\n");
}

// ── CLI dispatch ─────────────────────────────────────────────────────────────

// ── Redundancy analyzer — contract v1 consumer of ExecutionGate ─────────────
//
// Walks a session (or the last N days of sessions) and flags tool calls whose
// (tool_name, canonical_input, context) coordinate has been seen before.  The
// HIT/MISS decision is made by entient_agent.runtime.ExecutionGate via the
// gate_cli shim — same verdict vocabulary as the Agent hook.
//
// This is an OFFLINE observer.  It does not block, it does not run in the
// hot path.  It answers the question "which of my tool calls were wasted?"
// using the same receipt gate as the rest of the ENTIENT runtime.

function extractToolUses(sessionFile) {
  // Returns [{ ts, toolName, toolInput, turnIndex }]
  if (!fs.existsSync(sessionFile)) return [];
  const uses = [];
  let turnIndex = 0;
  let sawUserThisTurn = false;
  try {
    const lines = fs.readFileSync(sessionFile, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (_) { continue; }
      const role = rec.type || (rec.message && rec.message.role);
      if (role === "user") {
        if (sawUserThisTurn) turnIndex += 1;
        sawUserThisTurn = true;
      }
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block && block.type === "tool_use") {
          uses.push({
            ts: rec.timestamp || rec.message?.timestamp || null,
            toolName: block.name || "unknown",
            toolInput: block.input || {},
            turnIndex,
          });
        }
      }
    }
  } catch (_) {}
  return uses;
}

function readGitHead(dir) {
  try {
    const headPath = path.join(dir || process.cwd(), ".git", "HEAD");
    if (!fs.existsSync(headPath)) return "";
    const head = fs.readFileSync(headPath, "utf8").trim();
    if (head.startsWith("ref: ")) {
      const refPath = path.join(dir || process.cwd(), ".git", head.slice(5));
      if (fs.existsSync(refPath)) {
        return fs.readFileSync(refPath, "utf8").trim().slice(0, 12);
      }
      return head.slice(5).slice(-12);
    }
    return head.slice(0, 12);
  } catch (_) { return ""; }
}

function redundancyReport(opts) {
  const ga = gateAdapter();
  if (!ga) {
    console.log("[entient-spend] gate_adapter unavailable — is entient_agent importable by python?");
    console.log("  Try: ENTIENT_PYTHON=/path/to/python entient-spend redundancy");
    process.exit(3);
  }

  const sessionFile = opts.sessionFile || currentSessionFile();
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    console.log("[entient-spend] no session file to analyze.");
    console.log("  Pass one explicitly: entient-spend redundancy <session.jsonl>");
    process.exit(2);
  }

  const uses = extractToolUses(sessionFile);
  if (!uses.length) {
    console.log(`[entient-spend] no tool uses found in ${sessionFile}`);
    process.exit(0);
  }

  const context = opts.context || readGitHead(process.cwd()) || "no_git";
  const results = [];
  let hits = 0, misses = 0, stale = 0, errors = 0;

  for (const u of uses) {
    const ob = ga.obligationForToolUse(u.toolName, u.toolInput);
    const decision = ga.gateCheck(ob, context);
    const verdict = (decision.verdict || "ERROR").toUpperCase();
    if (verdict === "HIT") hits += 1;
    else if (verdict === "MISS") misses += 1;
    else if (verdict === "STALE") stale += 1;
    else errors += 1;

    results.push({
      turn: u.turnIndex,
      ts: u.ts,
      tool: u.toolName,
      obligation: ob,
      verdict,
      reason: decision.reason,
    });

    // Record the receipt AFTER the check (contract I2: record after success).
    // For an offline analysis this models "I saw this call happen."  A HIT on
    // the next identical call is the redundancy signal.
    if (!opts.noRecord && verdict !== "ERROR") {
      ga.gateRecord(ob, u.toolName, context, { turn: u.turnIndex });
    }
  }

  const total = results.length;
  const redundantPct = total ? ((hits / total) * 100).toFixed(1) : "0.0";

  if (opts.json) {
    console.log(JSON.stringify({
      session: sessionFile,
      context,
      total, hits, misses, stale, errors,
      redundant_pct: parseFloat(redundantPct),
      gate_space: ga.GATE_SPACE,
      calls: opts.verbose ? results : results.filter(r => r.verdict === "HIT"),
    }, null, 2));
    return;
  }

  console.log(`\nRedundancy report — ${path.basename(sessionFile)}`);
  console.log(`  Context:        ${context}`);
  console.log(`  Gate space:     ${ga.GATE_SPACE}`);
  console.log(`  Tool calls:     ${total}`);
  console.log(`  HIT (redundant):${String(hits).padStart(5)}   ${redundantPct}%`);
  console.log(`  MISS (novel):   ${String(misses).padStart(5)}`);
  console.log(`  STALE:          ${String(stale).padStart(5)}`);
  console.log(`  ERROR:          ${String(errors).padStart(5)}`);
  if (hits > 0) {
    console.log(`\n  Redundant calls (same HIT definition as ENTIENT hooks):`);
    const seen = new Set();
    for (const r of results) {
      if (r.verdict !== "HIT") continue;
      const key = r.tool + ":" + r.obligation.slice(0, 16);
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`    turn ${String(r.turn).padStart(3)}  ${r.tool.padEnd(12)} ${r.obligation.slice(0, 24)}...`);
      if (seen.size >= 20) { console.log(`    ... (${hits - seen.size} more)`); break; }
    }
  }
  console.log("");
}

function gateStatsCmd() {
  const ga = gateAdapter();
  if (!ga) {
    console.log("[entient-spend] gate_adapter unavailable — python/entient_agent not importable.");
    process.exit(3);
  }
  const s = ga.gateStats();
  console.log(JSON.stringify(s, null, 2));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { last: "7d", json: false, report: false, command: null, hook: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "install" && args[i+1] === "--shadow") { opts.command = "install-shadow"; i++; }
    else if (args[i] === "install-shadow")   { opts.command = "install-shadow";    }
    else if (args[i] === "shadow-report" || args[i] === "shadow-log") { opts.command = "shadow-report"; }
    else if (args[i] === "install")               { opts.command = "install";           }
    else if (args[i] === "install-autorestart") { opts.command = "install-autorestart"; }
    else if (args[i] === "uninstall")        { opts.command = "uninstall";         }
    else if (args[i] === "status")           { opts.command = "status";            }
    else if (args[i] === "doctor")           { opts.command = "doctor";            }
    else if (args[i] === "setup")            { opts.command = "setup";             }
    else if (args[i] === "billing")          { opts.command = "billing";           }
    else if (args[i] === "reconcile") { opts.command = "reconcile"; opts.reconcileFile = args[i+1] && !args[i+1].startsWith("--") ? args[++i] : null; }
    else if (args[i] === "redundancy") {
      opts.command = "redundancy";
      if (args[i+1] && !args[i+1].startsWith("--")) opts.sessionFile = args[++i];
    }
    else if (args[i] === "gate-stats") { opts.command = "gate-stats"; }
    else if (args[i] === "hud")              { opts.command = "hud";               }
    else if (args[i] === "count-tokens")     { opts.command = "count-tokens";      }
    else if (args[i] === "cost-report")      { opts.command = "cost-report";       }
    else if (args[i] === "--model" && args[i + 1]) { opts.model = args[++i]; }
    else if (args[i] === "--text" && args[i + 1])  { opts.text = args[++i]; }
    else if (args[i] === "--context" && args[i + 1]) { opts.context = args[++i]; }
    else if (args[i] === "--no-record")     { opts.noRecord = true; }
    else if (args[i] === "--verbose" || args[i] === "-v") { opts.verbose = true; }
    else if (args[i] === "--hook" && args[i + 1]) { opts.hook = args[++i]; }
    else if ((args[i] === "--last" || args[i] === "-l") && args[i + 1]) opts.last = args[++i];
    else if (args[i].startsWith("--last=")) opts.last = args[i].slice(7);
    else if (args[i] === "--json")   opts.json = true;
    else if (args[i] === "--report") opts.report = true;
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: entient-spend [install|install --shadow|uninstall|status] [--last 7d] [--json]");
      console.log("  install --shadow   Install hooks in observe-only mode (warn, never block)");
      console.log("  install            Install hooks in enforce mode (blocks at 10x waste)");
      process.exit(0);
    }
  }
  return opts;
}

function parseWindow(s) {
  const m = s.match(/^(\d+)(h|d|w)$/i);
  if (!m) throw new Error(`Invalid --last: ${s}`);
  const n = parseInt(m[1], 10), unit = m[2].toLowerCase();
  const hours = unit === "h" ? n : unit === "d" ? n * 24 : n * 168;
  return { hours, since: new Date(Date.now() - hours * 3_600_000) };
}

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  yellow: "\x1b[33m",
};
const bold   = s => `${C.bold}${s}${C.reset}`;
const dim    = s => `${C.dim}${s}${C.reset}`;
const yl     = s => `${C.yellow}${s}${C.reset}`;   // yellow — key numbers only
// keep these as no-ops so existing code that calls them still compiles
const red    = s => s;
const yellow = s => yl(s);
const green  = s => s;
const cyan   = s => s;

// ── Interactive menu ──────────────────────────────────────────────────────────

const W2  = 64;
const HL = "═".repeat(W2);
const SL = "─".repeat(W2);

function hooksInstalled() {
  try {
    const s = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8"));
    return Object.values(s.hooks || {}).flat()
      .some(h => (h.hooks || []).some(hh => (hh.command || "").includes("entient-spend")));
  } catch (_) { return false; }
}

function scanCacheBugFast() {
  // Quick version of doctor — just counts, no console output
  if (!fs.existsSync(PROJECTS_DIR)) return { total: 0, bugged: 0, buggedTokens: 0 };
  let total = 0, bugged = 0, buggedTokens = 0;
  for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory())) {
    const pd = path.join(PROJECTS_DIR, d.name);
    for (const jf of fs.readdirSync(pd).filter(f => f.endsWith(".jsonl"))) {
      const fp = path.join(pd, jf);
      try {
        if (Date.now() - fs.statSync(fp).mtimeMs > 14 * 86_400_000) continue;
        let ver = null, tok = 0;
        for (const line of fs.readFileSync(fp, "utf8").split("\n")) {
          if (!line.trim()) continue;
          let r; try { r = JSON.parse(line); } catch (_) { continue; }
          if (!ver && r.version) ver = r.version;
          const u = r.message?.usage || r.usage || {};
          tok += (u.input_tokens||0)+(u.cache_creation_input_tokens||0)+(u.cache_read_input_tokens||0)+(u.output_tokens||0);
        }
        if (!tok) continue;
        total++;
        if (ver && versionInRange(ver, CACHE_BUG_RANGE.min, CACHE_BUG_RANGE.max)) { bugged++; buggedTokens += tok; }
      } catch (_) {}
    }
  }
  return { total, bugged, buggedTokens };
}

function clearScreen() { process.stdout.write("\x1b[2J\x1b[H"); }

function printDashboard(sub, bug, enforced, window, billing) {
  clearScreen();
  const label = window === "30d" ? "30 days" : "7 days";
  const t   = sub.available ? sub.totalPrompts : 0;
  const c   = sub.available ? (sub.complexity || {}) : {};
  const wa  = sub.available ? (sub.wasteAnalysis || []) : [];
  const model = sub.available ? sub.configuredModel : "sonnet";

  // Needed = high complexity only. Not needed = everything else.
  const needed    = c.high || 0;
  const notNeeded = t - needed;
  const neededPct = t > 0 ? Math.round(needed / t * 100) : 0;
  const wastePct  = t > 0 ? 100 - neededPct : 0;

  // Per-category counts
  const ackN    = c.continuation || 0;
  const simpleN = c.low || 0;
  const medN    = c.medium || 0;
  const ackPct  = t > 0 ? Math.round(ackN / t * 100) : 0;

  // Bloated sessions = context_replay waste type
  const bloatedN = wa.filter(s => s.wasteTypes.includes("context_replay")).length;

  // Dynamic: top 3 problems
  const problems = [];
  if (wastePct >= 20) {
    problems.push({
      title: `${yl(wastePct + "%")} of prompts ran on ${model} but didn't need it`,
      fix:   `Start light sessions with /model haiku  —  switch to Sonnet when work gets complex`,
    });
  }
  if (ackPct >= 20) {
    problems.push({
      title: `${yl(ackPct + "%")} of turns were one-word replies  ("ok", "proceed", "continue")`,
      fix:   `Each re-sent your full conversation at full price.  Batch your intent into one prompt`,
    });
  }
  if (bloatedN > 0) {
    problems.push({
      title: `${yl(bloatedN)} session${bloatedN > 1 ? "s" : ""} ran past 30 turns  —  context cost grew 10x by end`,
      fix:   `Use /compact or start a fresh session after 30 turns`,
    });
  }
  if (problems.length === 0 && t > 0) {
    problems.push({ title: "No significant waste patterns detected", fix: "Sessions look clean for this period" });
  }

  // Worst sessions (top 3 with issues)
  const worst = wa.filter(s => s.wasteTypes.length > 0).slice(0, 3);

  const hasBilling = billing && billing.ok && billing.totalCost > 0;
  const realSpend  = hasBilling ? billing.totalCost : 0;
  const budget     = (billing && billing.budget) || null;

  console.log("");
  console.log(bold(`  Entient Spend`) + dim(`  —  last ${label}`));
  console.log(`  ${SL}`);
  console.log("");

  // ── Billing header ──────────────────────────────────────────
  if (hasBilling && realSpend > 0) {
    const spendStr  = `$${realSpend.toFixed(2)}`;
    const budgetStr = budget ? `  (Max plan $${budget}/mo + overages)` : "";
    const wasteAmt  = realSpend * (wastePct / 100);

    console.log(`  Estimated charges  ${yl(spendStr)}${dim(budgetStr)}`);
    console.log(`  Recoverable waste  ${yl("$" + wasteAmt.toFixed(2))}  ${dim("— prompts that didn't need " + model)}`);
    console.log("");

    // Daily breakdown — the thing missing from their email receipts
    if (billing.days && billing.days.length > 0) {
      const maxDay = Math.max(...billing.days.map(d => d.cost));
      console.log(`  ${SL}`);
      console.log(`  DAILY CHARGES  ${dim("(what caused your overage receipts)")}`);
      console.log(`  ${SL}`);
      for (const day of billing.days) {
        const bar      = "█".repeat(Math.min(Math.round(day.cost / maxDay * 20), 20));
        const topProj  = Object.entries(day.projects).sort((a,b) => b[1]-a[1]).slice(0,2).map(([k]) => k).join(", ");
        console.log(`  ${day.date}  ${yl(("$" + day.cost.toFixed(2)).padStart(7))}  ${dim(bar)}  ${dim(topProj)}`);
      }
      console.log("");

      // Project totals
      if (billing.projects && billing.projects.length > 0) {
        console.log(`  ${SL}`);
        console.log(`  BY PROJECT`);
        console.log(`  ${SL}`);
        for (const p of billing.projects.slice(0, 6)) {
          const pct = realSpend > 0 ? Math.round(p.cost / realSpend * 100) : 0;
          const bar = "█".repeat(Math.round(pct / 5));
          console.log(`  ${p.name.padEnd(26)}  ${yl(("$" + p.cost.toFixed(2)).padStart(7))}  ${String(pct) + "%"}  ${dim(bar)}`);
        }
        console.log("");
      }
    }
  } else if (budget) {
    console.log(`  Max plan $${budget}/mo  ${dim("(token billing computing...)")}`);
    console.log("");
  } else {
    console.log(`  ${dim("Token-based cost estimate loading from session files...")}`);
    console.log("")
  }

  // ── Startup overhead ─────────────────────────────────────────
  const ss = billing && billing.startupStats;
  if (ss && ss.sessions > 0 && ss.significant) {
    const overheadK  = (ss.overheadPerSession / 1000).toFixed(0);
    const totalK     = (ss.totalOverheadTokens / 1000).toFixed(0);
    const costStr    = ss.overheadCost >= 0.01 ? ` = ${yl("$" + ss.overheadCost.toFixed(2))} overhead` : "";
    console.log(`  ${SL}`);
    console.log(`  STARTUP OVERHEAD  ${dim("(tool + system prompt loading per session)")}`);
    console.log(`  ${SL}`);
    console.log(`  Each new session loads ~${yl(overheadK + "k")} tokens of tools/system prompt before you type a word.`);
    console.log(`  Across ${ss.sessions} sessions: ${yl(totalK + "k")} tokens burned on startup${costStr}.`);
    console.log(`  ${dim('This is the "loaded tools" problem — re-injected cold every session.')}`);
    console.log(`  ${dim("entient.com collapses repeated tool loading to near-zero after the first run.")}`);
    console.log("");
  }

  // ── Prompt breakdown ─────────────────────────────────────────
  if (!sub.available) {
    console.log(`  No Claude data found.  Run Claude Code first then try again.`);
    console.log("");
  } else {
    console.log(`  You ran ${yl(t.toLocaleString())} prompts.`);
    console.log(`  ${yl(needed.toLocaleString())} (${yl(neededPct + "%")}) actually needed the model you paid for.`);
    console.log(`  ${yl(notNeeded.toLocaleString())} (${yl(wastePct + "%")}) did not.`);
    console.log("");
    console.log(`  ${SL}`);
    console.log(`  ${"WHERE YOUR PROMPTS WENT".padEnd(38)}  ${"COUNT".padStart(6)}  ${"NEEDED?"}`);
    console.log(`  ${SL}`);
    console.log(`  ${"Complex work  (required " + model + ")".padEnd(38)}  ${String(needed).padStart(6)}  yes`);
    console.log(`  ${"Medium tasks  (ambiguous)".padEnd(38)}  ${String(medN).padStart(6)}  ${dim("maybe")}`);
    console.log(`  ${"Simple work   (Haiku was enough)".padEnd(38)}  ${String(simpleN).padStart(6)}  ${dim("no")}`);
    console.log(`  ${"Confirmations (\"ok\", \"go ahead\", \"yes\")".padEnd(38)}  ${String(ackN).padStart(6)}  ${dim("no")}`);
    console.log(`  ${SL}`);
    console.log(`  ${"Total".padEnd(38)}  ${String(t).padStart(6)}`);
    console.log("");
  }

  if (problems.length > 0) {
    console.log(`  ${SL}`);
    console.log(`  WHAT IS DRAINING YOUR BUDGET`);
    console.log(`  ${SL}`);
    console.log("");
    for (const [i, p] of problems.entries()) {
      console.log(`  ${i + 1}.  ${p.title}`);
      console.log(`      ${dim("Fix:")} ${p.fix}`);
      console.log("");
    }
  }

  console.log(`  ${SL}`);
  console.log(`  STATUS`);
  console.log(`  ${SL}`);
  const enfLabel = enforced ? "ON" : yl("OFF");
  const enfNote  = enforced ? dim("  (sessions blocked at 5x waste, context auto-saved)") : dim("  →  type 4 to install");
  console.log(`  Auto-enforcement    ${enfLabel}${enfNote}`);
  const bugLabel = bug.bugged > 0 ? yl(`AFFECTED  (${Math.round(bug.bugged/bug.total*100)}% of recent sessions)`) : "CLEAR";
  const bugNote  = bug.bugged > 0 ? dim("  →  type 3 for details") : dim("  (you're on a clean version)");
  console.log(`  Cache bug           ${bugLabel}${bugNote}`);
  console.log("");

  if (worst.length > 0) {
    console.log(`  ${SL}`);
    console.log(`  WORST SESSIONS`);
    console.log(`  ${SL}`);
    console.log(`  ${"Project".padEnd(24)}  ${"Date".padEnd(8)}  ${"Turns".padStart(5)}  Problem`);
    console.log(`  ${SL}`);
    for (const s of worst) {
      const dt      = new Date(s.lastTs).toISOString().slice(5, 10);
      const issues  = [];
      if (s.wasteTypes.includes("wrong_model"))    issues.push(`${s.haikuPct}% simple on ${model}`);
      if (s.wasteTypes.includes("session_bloat"))  issues.push(`${s.ackPct}% confirmations`);
      if (s.wasteTypes.includes("context_replay")) issues.push(`ran ${s.durationHrs}h`);
      console.log(`  ${s.project.slice(0,24).padEnd(24)}  ${dt.padEnd(8)}  ${String(s.prompts).padStart(5)}  ${dim(issues.join(" + "))}`);
    }
    console.log("");
  }

  console.log(`  ${SL}`);
  console.log(`  ${bold("1.")} detail   ${bold("2.")} sessions   ${bold("3.")} cache bug   ${bold("4.")} enforcement   ${bold("5.")} export   ${bold("q.")} quit`);
  console.log("");
}

function showMoneyScreen(sub) {
  clearScreen();
  const t     = sub.totalPrompts;
  const c     = sub.complexity;
  const model = sub.configuredModel;
  const wa    = sub.wasteAnalysis || [];

  const highPct   = t > 0 ? Math.round((c.high||0)         / t * 100) : 0;
  const medPct    = t > 0 ? Math.round((c.medium||0)        / t * 100) : 0;
  const simPct    = t > 0 ? Math.round((c.low||0)           / t * 100) : 0;
  const ackPct    = t > 0 ? Math.round((c.continuation||0)  / t * 100) : 0;
  const wastePct  = 100 - highPct;
  const bloatedN  = wa.filter(s => s.wasteTypes.includes("context_replay")).length;

  console.log("");
  console.log(bold("  DETAIL — WHERE YOUR BUDGET GOES"));
  console.log(`  ${SL}`);
  console.log("");
  console.log(`  Of your ${yl(t.toLocaleString())} prompts, only ${yl(highPct + "%")} actually required ${model}.`);
  console.log(`  The other ${yl(wastePct + "%")} ran on ${model} for no reason.`);
  console.log("");
  console.log(`  ${SL}`);
  console.log(`  ${"TYPE".padEnd(38)}  ${"SHARE".padStart(6)}  ${"COUNT".padStart(6)}`);
  console.log(`  ${SL}`);

  const rows = [
    ["Confirmations  (\"ok\", \"proceed\", \"yes\")",  ackPct,  c.continuation||0,
     `Each re-sent your full conversation. Zero new info.`],
    ["Simple work    (one-liners, lookups)",          simPct,  c.low||0,
     `Haiku handles these fine at ~5x lower cost.`],
    ["Medium tasks   (ambiguous complexity)",         medPct,  c.medium||0,
     `May need Sonnet. Depends on output quality required.`],
    ["Complex work   (required " + model + ")",       highPct, c.high||0,
     `This is where the subscription earns its cost.`],
  ];

  for (const [label, pct, count, note] of rows) {
    console.log(`  ${label.padEnd(38)}  ${yl(String(pct) + "%").padStart(9)}  ${String(count).padStart(6)}`);
    console.log(`  ${dim("  " + note)}`);
    console.log("");
  }

  console.log(`  ${SL}`);
  console.log(`  WHAT TO DO`);
  console.log(`  ${SL}`);
  console.log("");
  if (wastePct >= 20) {
    console.log(`  1.  Start light sessions with ${yl("/model haiku")}`);
    console.log(`      ${dim("Switch to Sonnet only when the task actually gets complex.")}`);
    console.log(`      ${dim("You'll know — responses will start to feel shallow.")}`);
    console.log("");
  }
  if (ackPct >= 20) {
    console.log(`  2.  Stop sending one-word replies`);
    console.log(`      ${dim(`${ackPct}% of your turns were confirmations. Each one re-sent`)}`);
    console.log(`      ${dim("your full conversation history. Write one complete prompt")}`);
    console.log(`      ${dim("instead of three short ones.")}`);
    console.log("");
  }
  if (bloatedN > 0) {
    console.log(`  3.  Rotate sessions after 30 turns`);
    console.log(`      ${dim(`${bloatedN} sessions ran long enough for context to balloon.`)}`);
    console.log(`      ${dim("Use /compact or start fresh and paste a one-paragraph summary.")}`);
    console.log("");
  }
  if (wastePct < 20 && ackPct < 20 && bloatedN === 0) {
    console.log(`  Sessions look clean. No significant waste in this window.`);
    console.log("");
  }

  console.log(dim("  Press Enter to go back."));
}

function showSessionsScreen(sub) {
  clearScreen();
  const wa    = (sub.wasteAnalysis || []).slice(0, 10);
  const model = sub.configuredModel;

  console.log("");
  console.log(bold("  SESSIONS — LAST 7 DAYS"));
  console.log(`  ${SL}`);
  console.log(`  ${"Project".padEnd(24)}  ${"Date".padEnd(10)}  ${"Turns".padStart(5)}  ${"Start model".padEnd(14)}  Problems`);
  console.log(`  ${SL}`);

  if (wa.length === 0) {
    console.log("  No session data.");
    console.log("");
    console.log(dim("  Press Enter to go back."));
    return;
  }

  for (const s of wa) {
    const dt      = new Date(s.lastTs).toISOString().slice(5, 10);
    const issues  = [];
    if (s.wasteTypes.includes("wrong_model"))    issues.push(`${s.haikuPct}% simple on ${model}`);
    if (s.wasteTypes.includes("session_bloat"))  issues.push(`${s.ackPct}% confirmations`);
    if (s.wasteTypes.includes("context_replay")) issues.push(`ran ${s.durationHrs}h`);
    const issueStr = issues.length ? yl(issues.join(" + ")) : dim("clean");
    const startMod = s.recommendedStartModel.toUpperCase().padEnd(14);

    console.log(`  ${s.project.slice(0,24).padEnd(24)}  ${dt.padEnd(10)}  ${String(s.prompts).padStart(5)}  ${dim(startMod)}  ${issueStr}`);
  }

  console.log("");
  console.log(`  ${SL}`);
  console.log(`  WHAT THESE MEAN`);
  console.log(`  ${SL}`);
  console.log("");
  console.log(`  "simple on ${model}"     ${dim(`That % of prompts didn't need ${model}. Use /model haiku to start.`)}`);
  console.log(`  "confirmations"       ${dim("That % were one-word replies that re-sent full context.")}`);
  console.log(`  "ran Xh"              ${dim("Session ran long — context cost grew 10x per prompt by end.")}`);
  console.log(`  Start model column    ${dim("What model this session should have opened on.")}`);
  console.log("");
  console.log(dim("  Press Enter to go back."));
}

function showCacheScreen(bug) {
  clearScreen();
  const pct  = bug.total > 0 ? Math.round(bug.bugged / bug.total * 100) : 0;
  const bugM = (bug.buggedTokens / 1_000_000).toFixed(0);
  const bugG = (bug.buggedTokens / 1_000_000_000).toFixed(1);
  const bigNum = parseFloat(bugG) >= 1 ? bugG + "B" : bugM + "M";

  console.log("");
  console.log(bold("  CACHE BUG"));
  console.log(`  ${SL}`);
  console.log("");
  console.log(`  Claude Code versions 2.1.69 – 2.1.89 had a broken prompt cache.`);
  console.log(`  Instead of reusing cached context, every turn re-processed`);
  console.log(`  the full conversation from scratch.`);
  console.log(`  Effect: 10–20x token burn on sessions longer than 10 turns.`);
  console.log("");
  console.log(`  ${SL}`);
  console.log(`  YOUR STATUS`);
  console.log(`  ${SL}`);
  console.log("");

  if (bug.bugged > 0) {
    console.log(`  Affected sessions    ${yl(bug.bugged + " of " + bug.total)}  (${yl(pct + "%")} of your last 14 days)`);
    console.log(`  Tokens burned        ${yl("~" + bigNum)}  (estimated — cannot be recovered)`);
    console.log(`  Current version      CLEAR  (caching is working correctly now)`);
    console.log("");
    console.log(`  The tokens are gone. Going forward you are on a clean version.`);
  } else {
    console.log(`  Affected sessions    0  (none of your recent sessions hit this bug)`);
    console.log(`  Current version      CLEAR`);
    console.log("");
    console.log(`  You were not affected. No action needed.`);
  }

  console.log("");
  console.log(`  ${dim("To update: claude update")}`);
  console.log("");
  console.log(dim("  Press Enter to go back."));
}

function showEnforceScreen(enforced) {
  clearScreen();
  console.log("");
  console.log(bold("  AUTO-ENFORCEMENT"));
  console.log(`  ${SL}`);
  console.log("");

  if (enforced) {
    console.log(`  Status    ON`);
    console.log("");
    console.log(`  What it does:`);
    console.log(`    When a session uses ${yl("10x")} more tokens per turn than it started,`);
    console.log(`    Claude is blocked before the next prompt burns any more.`);
    console.log(`    Your session state is saved — branch, open files, what you were doing.`);
    console.log(`    Start a fresh session and context is injected automatically.`);
    console.log("");
    console.log(`  Config     ~/.entient-spend/config.json`);
    console.log(`  ${dim("Threshold, min turns, baseline window — all adjustable.")}`);
    console.log("");
    console.log(`  ${dim("To turn off: entient-spend uninstall")}`);
  } else {
    console.log(`  Status    ${yl("OFF")}`);
    console.log("");
    console.log(`  With enforcement on:`);
    console.log(`    Sessions that bloat past ${yl("10x")} waste are blocked automatically.`);
    console.log(`    Context is saved before the block — branch, files, what you were doing.`);
    console.log(`    Next session opens with that context injected. You pick up where you left off.`);
    console.log(`    Nothing to monitor. It runs in the background.`);
    console.log("");
    console.log(`  Type ${yl("y")} to install now, or press Enter to go back.`);
  }
  console.log("");
}

// ── HTML report ──────────────────────────────────────────────────────────────

function generateHTML(sub, bug, enforced) {
  const t = sub.available ? sub.totalPrompts : 0;
  const c = sub.available ? (sub.complexity || {}) : {};
  const model = sub.available ? sub.configuredModel : "unknown";
  const haiku = sub.available ? sub.haikuEligible : 0;
  const haikuPct = t > 0 ? Math.round(haiku / t * 100) : 0;
  const highPct  = t > 0 ? Math.round((c.high||0) / t * 100) : 0;
  const ackPct   = t > 0 ? Math.round((c.continuation||0) / t * 100) : 0;
  const wa = sub.available ? (sub.wasteAnalysis || []) : [];
  const badSessions = wa.filter(s => s.wasteTypes.length > 0).length;
  const bugPct = bug.total > 0 ? Math.round(bug.bugged / bug.total * 100) : 0;
  const bugM   = (bug.buggedTokens / 1_000_000).toFixed(0);

  const wasteColor = haikuPct >= 50 ? "#e74c3c" : haikuPct >= 30 ? "#f39c12" : "#27ae60";
  const now = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const sessionRows = wa.slice(0, 8).map((s, i) => {
    const dt = new Date(s.lastTs).toISOString().slice(0, 10);
    const issues = [];
    if (s.wasteTypes.includes("wrong_model"))    issues.push(`${s.haikuPct}% ran on ${model} unnecessarily`);
    if (s.wasteTypes.includes("session_bloat"))  issues.push(`${s.ackPct}% confirmation loops`);
    if (s.wasteTypes.includes("context_replay")) issues.push(`${s.durationHrs}h session — context ballooned`);
    const badgeColor = s.wasteTypes.length >= 2 ? "#e74c3c" : s.wasteTypes.length === 1 ? "#f39c12" : "#27ae60";
    const badgeText  = s.wasteTypes.length >= 2 ? "⚠ triple-cost" : s.wasteTypes.length === 1 ? "! issue" : "✓ ok";
    return `
      <tr>
        <td style="color:#888;font-size:12px">${dt}</td>
        <td><strong>${s.project}</strong></td>
        <td>${s.prompts} turns / ${s.durationHrs}h</td>
        <td><span style="color:${badgeColor};font-weight:600">${badgeText}</span></td>
        <td style="font-size:13px;color:#aaa">${issues.join(" · ") || "—"}</td>
        <td style="font-size:12px;color:#7fb3f5">${s.recommendedStartModel.toUpperCase()} — ${s.escalation}</td>
      </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Entient — Claude Audit Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 32px 24px; max-width: 900px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
  .brand { font-size: 22px; font-weight: 700; color: #58a6ff; letter-spacing: -0.5px; }
  .brand span { color: #8b949e; font-weight: 400; font-size: 14px; margin-left: 8px; }
  .date { color: #8b949e; font-size: 13px; margin-top: 4px; }
  .tagline { color: #8b949e; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 28px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; }
  .card-label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .card-value { font-size: 32px; font-weight: 700; line-height: 1; }
  .card-sub { font-size: 13px; color: #8b949e; margin-top: 6px; }
  .section { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; margin-bottom: 20px; }
  .section-title { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #8b949e; margin-bottom: 20px; }
  .bar-row { display: flex; align-items: center; margin-bottom: 10px; gap: 12px; }
  .bar-label { font-size: 13px; color: #e6edf3; width: 180px; flex-shrink: 0; }
  .bar-track { flex: 1; background: #21262d; border-radius: 4px; height: 8px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; }
  .bar-pct { font-size: 13px; color: #8b949e; width: 40px; text-align: right; }
  .bar-count { font-size: 12px; color: #555; width: 50px; text-align: right; }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #8b949e; text-align: left; padding: 0 12px 12px 0; border-bottom: 1px solid #21262d; }
  td { font-size: 13px; padding: 10px 12px 10px 0; border-bottom: 1px solid #161b22; vertical-align: top; }
  .status-row { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .badge { padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; }
  .badge-red { background: rgba(231,76,60,0.15); color: #e74c3c; border: 1px solid rgba(231,76,60,0.3); }
  .badge-green { background: rgba(39,174,96,0.15); color: #27ae60; border: 1px solid rgba(39,174,96,0.3); }
  .badge-yellow { background: rgba(243,156,18,0.15); color: #f39c12; border: 1px solid rgba(243,156,18,0.3); }
  .insight { background: #0d1117; border-left: 3px solid #58a6ff; padding: 14px 16px; margin-top: 16px; font-size: 14px; line-height: 1.6; color: #c9d1d9; }
  .insight strong { color: #e6edf3; }
  .cta { background: linear-gradient(135deg, #1a2744 0%, #162032 100%); border: 1px solid #30363d; border-radius: 8px; padding: 24px; text-align: center; margin-top: 24px; }
  .cta-title { font-size: 18px; font-weight: 700; color: #58a6ff; margin-bottom: 8px; }
  .cta-sub { font-size: 14px; color: #8b949e; line-height: 1.6; }
  .cta-url { color: #58a6ff; font-weight: 600; text-decoration: none; font-size: 15px; }
  .footer { text-align: center; color: #555; font-size: 12px; margin-top: 32px; }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="brand">Entient Spend</div>
    <div class="date">Report generated ${now} · Last 7 days</div>
  </div>
  <div class="tagline">entient.com — AI cost enforcement</div>
</div>

<div class="status-row">
  ${bug.bugged > 0
    ? `<span class="badge badge-yellow">⚠ Cache bug: ${bugPct}% of sessions affected</span>`
    : `<span class="badge badge-green">✓ No cache bug exposure</span>`}
  ${enforced
    ? `<span class="badge badge-green">✓ Enforcement active</span>`
    : `<span class="badge badge-red">✗ Enforcement off — sessions can burn freely</span>`}
  <span class="badge ${haikuPct >= 40 ? "badge-red" : "badge-green"}">${haikuPct}% of prompts wasted on wrong model</span>
</div>

<div class="grid">
  <div class="card">
    <div class="card-label">Total prompts</div>
    <div class="card-value">${t.toLocaleString()}</div>
    <div class="card-sub">last 7 days, on ${model}</div>
  </div>
  <div class="card">
    <div class="card-label">Wasted on wrong model</div>
    <div class="card-value" style="color:${wasteColor}">${haikuPct}%</div>
    <div class="card-sub">${haiku} prompts that didn't need ${model}</div>
  </div>
  <div class="card">
    <div class="card-label">Problem sessions</div>
    <div class="card-value" style="color:${badSessions > 0 ? "#e74c3c" : "#27ae60"}">${badSessions}</div>
    <div class="card-sub">of ${wa.length} analysed — wrong model, bloat, or replay</div>
  </div>
</div>

<div class="section">
  <div class="section-title">What your prompts actually were</div>
  <div class="bar-row">
    <div class="bar-label">ACKs &amp; one-liners</div>
    <div class="bar-track"><div class="bar-fill" style="width:${ackPct}%;background:#e74c3c"></div></div>
    <div class="bar-pct">${ackPct}%</div>
    <div class="bar-count">${(c.continuation||0).toLocaleString()}</div>
  </div>
  <div class="bar-row">
    <div class="bar-label">Simple questions</div>
    <div class="bar-track"><div class="bar-fill" style="width:${t>0?Math.round((c.low||0)/t*100):0}%;background:#f39c12"></div></div>
    <div class="bar-pct">${t>0?Math.round((c.low||0)/t*100):0}%</div>
    <div class="bar-count">${(c.low||0).toLocaleString()}</div>
  </div>
  <div class="bar-row">
    <div class="bar-label">Medium complexity</div>
    <div class="bar-track"><div class="bar-fill" style="width:${t>0?Math.round((c.medium||0)/t*100):0}%;background:#8b949e"></div></div>
    <div class="bar-pct">${t>0?Math.round((c.medium||0)/t*100):0}%</div>
    <div class="bar-count">${(c.medium||0).toLocaleString()}</div>
  </div>
  <div class="bar-row">
    <div class="bar-label">Actually needed ${model}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${highPct}%;background:#27ae60"></div></div>
    <div class="bar-pct">${highPct}%</div>
    <div class="bar-count">${(c.high||0).toLocaleString()}</div>
  </div>
  <div class="insight">
    <strong>${haikuPct}% of your prompts</strong> were simple enough for Haiku but ran on ${model}.
    Only <strong>${highPct}%</strong> actually required ${model}-level reasoning.
    ${ackPct >= 40 ? `<br><br><strong>${ackPct}% were one-word confirmations</strong> ("ok", "proceed", "continue") — each one re-sent your entire conversation history at full price.` : ""}
  </div>
</div>

${bug.bugged > 0 ? `
<div class="section">
  <div class="section-title">Cache bug exposure</div>
  <p style="color:#c9d1d9;font-size:14px;line-height:1.7">
    Claude Code versions <strong>2.1.69–2.1.89</strong> had a broken prompt cache that caused
    <strong>10–20x token burn</strong> on long sessions. Instead of reusing cached context,
    every turn paid full price to re-process the entire conversation history.
  </p>
  <br>
  <p style="font-size:14px;color:#e6edf3">
    <strong style="color:#f39c12">${bug.bugged} of ${bug.total} sessions (${bugPct}%)</strong> ran under this bug.
    Approximately <strong>${bugM}M tokens</strong> were consumed under broken caching.
    These cannot be recovered — but you're now on a clean version.
  </p>
</div>` : ""}

<div class="section">
  <div class="section-title">Top sessions by waste</div>
  <table>
    <tr>
      <th>Date</th><th>Project</th><th>Size</th><th>Status</th><th>Issues</th><th>Fix</th>
    </tr>
    ${sessionRows}
  </table>
</div>

${(() => {
  const wa3 = sub.available ? (sub.wasteAnalysis || []) : [];
  const hasWM  = wa3.some(s => s.wasteTypes.includes("wrong_model"));
  const hasBl  = wa3.some(s => s.wasteTypes.includes("session_bloat"));
  const hasRep = wa3.some(s => s.wasteTypes.includes("context_replay"));
  const topBl  = wa3.filter(s=>s.wasteTypes.includes("session_bloat")).reduce((m,s)=>Math.max(m,s.ackPct),0);
  const topRH  = wa3.filter(s=>s.wasteTypes.includes("context_replay")).reduce((m,s)=>Math.max(m,s.durationHrs),0);
  const wm     = wa3.find(s=>s.wasteTypes.includes("wrong_model"));
  const items  = [];
  if (hasWM)  items.push({ title: `Switch to Haiku for ${wm.haikuPct}% of your work`, body: `Your sessions ran ${model} on prompts that didn't need it. Start with <code style="color:#79c0ff">/model haiku</code>. Escalate to Sonnet only when the task gets complex.` });
  if (hasBl)  items.push({ title: `Stop the confirmation loop (${topBl}% of your turns)`, body: `"ok", "proceed", "continue" — each one re-sent your full context at full price. Batch your intent. Say what you want in one prompt instead of three.` });
  if (hasRep) items.push({ title: `Rotate sessions after 30 turns (you ran ${topRH}h)`, body: `Context cost compounds. By turn 30+, you're paying 10-20x more per prompt just to carry history. Use <code style="color:#79c0ff">/compact</code> or start fresh and paste a one-paragraph summary.` });
  if (!enforced) items.push({ title: "Enable auto-enforcement", body: `Run <code style="color:#79c0ff">entient-spend install</code> to block sessions at 10x waste automatically. Context is saved before each block and injected when you resume.` });
  if (items.length === 0) items.push({ title: "Looking clean", body: "No significant waste patterns in this window. Keep sessions short, match the model to the work." });
  const cols = items.map(item => `<div><div style="font-weight:600;margin-bottom:6px;color:#58a6ff">${item.title}</div><div style="font-size:13px;color:#8b949e;line-height:1.6">${item.body}</div></div>`).join("");
  return `<div class="section"><div class="section-title">What to do — based on your data</div><div style="display:grid;grid-template-columns:${items.length > 1 ? "1fr 1fr" : "1fr"};gap:16px">${cols}</div></div>`;
})()}

<div class="cta">
  <div class="cta-title">Want this enforced automatically?</div>
  <div class="cta-sub">
    Entient routes each prompt to the right model and deflects repeated patterns entirely.<br>
    No manual switching. No session rotation. No wasted tokens.
  </div>
  <br>
  <a class="cta-url" href="https://entient.com">entient.com →</a>
</div>

<div class="footer">
  Generated by <strong>Entient Spend</strong> · Data read locally, nothing uploaded · <a href="https://entient.com" style="color:#555">entient.com</a>
</div>

</body>
</html>`;
}

function exportReport(sub, bug, enforced) {
  const html = generateHTML(sub, bug, enforced);
  const outPath = path.join(os.homedir(), "entient-spend-report.html");
  fs.writeFileSync(outPath, html, "utf8");
  console.log(`\n  ${green("✓")} Report saved: ${bold(outPath)}`);
  console.log(`  Open in your browser to view and share.`);
  // Try to open in default browser
  try {
    const { execSync } = require("child_process");
    const cmd = process.platform === "win32" ? `start "" "${outPath}"`
              : process.platform === "darwin" ? `open "${outPath}"`
              : `xdg-open "${outPath}"`;
    execSync(cmd, { stdio: "ignore" });
  } catch (_) {}
}

// ── count-tokens command ────────────────────────────────────────────────────
// Reads a prompt from stdin (or --text), calls /v1/messages/count_tokens,
// and prints measured tokens + projected cost at the requested model's rate.
async function countTokensCmd(opts) {
  const cfg = loadConfig();
  if (!cfg.anthropicApiKey) {
    console.log(`\n  ${yl("No API key configured.")} Run: entient-spend setup\n`);
    process.exit(1);
  }
  const model = opts.model || "claude-sonnet-4-5";

  let text = opts.text;
  if (!text && !process.stdin.isTTY) {
    text = await new Promise(resolve => {
      let b = ""; process.stdin.setEncoding("utf8");
      process.stdin.on("data", d => b += d);
      process.stdin.on("end", () => resolve(b));
    });
  }
  if (!text || !text.trim()) {
    console.log("\n  Usage: echo 'your prompt' | entient-spend count-tokens [--model claude-opus-4-7]");
    console.log("         entient-spend count-tokens --text 'your prompt'\n");
    process.exit(1);
  }

  const result = await countTokens(cfg.anthropicApiKey, {
    model,
    messages: [{ role: "user", content: text }],
  });
  if (!result.ok) {
    console.log(`\n  ${yl("count_tokens failed:")} ${result.error}\n`);
    process.exit(1);
  }

  // Price projection at input rate (count_tokens only returns input_tokens).
  const PRICES = {
    "claude-opus":    { in: 15 },
    "claude-sonnet":  { in: 3  },
    "claude-haiku":   { in: 0.80 },
  };
  let inRate = 3;
  for (const [k, v] of Object.entries(PRICES)) {
    if (model.toLowerCase().startsWith(k)) { inRate = v.in; break; }
  }
  const inputCost = (result.input_tokens / 1_000_000) * inRate;

  if (opts.json) {
    console.log(JSON.stringify({
      model, input_tokens: result.input_tokens, input_cost_usd: inputCost,
    }));
    return;
  }
  console.log("");
  console.log(`  model:        ${bold(model)}`);
  console.log(`  input_tokens: ${bold(String(result.input_tokens))}`);
  console.log(`  input cost:   ${yl("$" + inputCost.toFixed(6))}  ${dim("(output not counted — count_tokens is input-only)")}`);
  console.log("");
}

// ── cost-report command ────────────────────────────────────────────────────
// Authoritative $ figures from the Admin API. Requires apikey_... or sk-ant-admin...
async function costReportCmd(windowStr = "30d") {
  const cfg = loadConfig();
  if (!cfg.anthropicAdminKey) {
    console.log(`\n  ${yl("No admin key configured.")} Run: entient-spend setup`);
    console.log(`  Paste an Admin API key (apikey_... or sk-ant-admin...) when prompted.\n`);
    process.exit(1);
  }
  const { hours } = parseWindow(windowStr);
  const days = Math.max(1, Math.round(hours / 24));
  const res = await fetchAnthropicCostReport(cfg.anthropicAdminKey, days);

  console.log("");
  console.log(bold(`  entient-spend — AUTHORITATIVE COST REPORT`));
  console.log(`  Last ${windowStr}  |  Source: /v1/organizations/cost_report  (Anthropic Admin API)`);
  console.log(`  ${SL}`);
  console.log("");

  if (!res.ok) {
    console.log(`  ${yl("Error:")} ${res.error}\n`);
    process.exit(1);
  }
  if (res.byDay.length === 0) {
    console.log(`  No cost rows returned. Either no usage in window, or admin key scope excludes this org.\n`);
    return;
  }

  const maxCost = Math.max(...res.byDay.map(d => d.cost));
  const budget = cfg.monthlyBudget;
  if (budget) {
    console.log(`  Max plan budget      $${budget.toFixed(2)}/mo`);
    console.log(`  Authoritative total  ${yl("$" + res.totalCost.toFixed(2))}`);
    const overage = Math.max(0, res.totalCost - budget);
    if (overage > 0) {
      console.log(`  Overage              ${yl("$" + overage.toFixed(2))}  ${dim("← actual separate billing")}`);
    }
  } else {
    console.log(`  Authoritative total  ${yl("$" + res.totalCost.toFixed(2))}`);
  }
  console.log("");
  console.log(bold(`  DAILY BREAKDOWN`));
  for (const day of res.byDay) {
    const frac = maxCost > 0 ? day.cost / maxCost : 0;
    const bars = "█".repeat(Math.round(frac * 30));
    console.log(`  ${day.date}  ${bars.padEnd(30)}  $${day.cost.toFixed(2)}`);
  }
  console.log("");
  console.log(dim(`  These are actual dollars billed by Anthropic — not estimated client-side.`));
  console.log("");
}

async function menu() {
  const readline = require("readline");

  let window = "7d";
  process.stdout.write("  Loading...\r");
  let sub      = readSubscriptionActivity(parseWindow(window).since);
  let bug      = scanCacheBugFast();
  let enforced = hooksInstalled();
  const cfg    = loadConfig();

  // Compute token-based billing from local session files
  let billing = computeTokenBilling(parseWindow(window).since);
  // Attach budget from config
  if (cfg.monthlyBudget) billing.budget = cfg.monthlyBudget;

  const ask = (prompt) => new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, ans => { rl.close(); resolve(ans.trim().toLowerCase()); });
  });

  while (true) {
    printDashboard(sub, bug, enforced, window, billing);
    const choice = await ask("  Choice: ");

    if (choice === "1") {
      showMoneyScreen(sub);
      await ask("");
    } else if (choice === "2") {
      showSessionsScreen(sub);
      await ask("");
    } else if (choice === "3") {
      showCacheScreen(bug);
      await ask("");
    } else if (choice === "4") {
      if (enforced) {
        showEnforceScreen(true);
        await ask("");
      } else {
        showEnforceScreen(false);
        const ans = await ask("  Choice: ");
        if (ans === "y") {
          install();
          enforced = true;
          console.log("");
          console.log(`  Enforcement installed. Restart Claude Code to activate.`);
          console.log("");
          await ask("  Press Enter to continue.");
        }
      }
    } else if (choice === "5") {
      exportReport(sub, bug, enforced);
      await ask("  Press Enter to continue.");
    } else if (choice === "30d" || choice === "30") {
      window = "30d";
      sub     = readSubscriptionActivity(parseWindow(window).since);
      billing = computeTokenBilling(parseWindow(window).since);
      if (cfg.monthlyBudget) billing.budget = cfg.monthlyBudget;
    } else if (choice === "7d" || choice === "7") {
      window = "7d";
      sub     = readSubscriptionActivity(parseWindow(window).since);
      billing = computeTokenBilling(parseWindow(window).since);
      if (cfg.monthlyBudget) billing.budget = cfg.monthlyBudget;
    } else if (choice === "q" || choice === "quit" || choice === "exit") {
      clearScreen();
      break;
    }
  }
}

function billingReport(windowStr = "30d") {
  const cfg    = loadConfig();
  const { since } = parseWindow(windowStr);
  const b      = computeTokenBilling(since);
  const budget = cfg.monthlyBudget || null;

  console.log("");
  console.log(bold(`  Entient Spend — BILLING RECONCILIATION`));
  console.log(`  Last ${windowStr}  |  Based on session token counts at Anthropic API rates`);
  console.log(`  ${SL}`);
  console.log("");

  if (!b.ok || b.totalCost === 0) {
    console.log(`  No session token data found. Make sure Claude Code session files exist.`);
    console.log(`  Expected location: ~/.claude/projects/`);
    console.log("");
    return;
  }

  const total = b.totalCost;
  if (budget) {
    console.log(`  Max plan budget      $${budget.toFixed(2)}/mo`);
    console.log(`  Estimated usage      ${yl("$" + total.toFixed(2))}`);
    const overage = Math.max(0, total - budget);
    if (overage > 0) {
      console.log(`  Estimated overage    ${yl("$" + overage.toFixed(2))}  ${dim("← this is what Anthropic billed separately")}`);
    }
    console.log("");
  } else {
    console.log(`  Estimated total      ${yl("$" + total.toFixed(2))}`);
    console.log(`  ${dim("Set your plan cost: entient-spend setup (enter monthly budget)")}`);
    console.log("");
  }

  console.log(`  ${SL}`);
  console.log(`  DAILY BREAKDOWN  ${dim("— compare to your email receipts")}`);
  console.log(`  ${SL}`);
  const maxDay = b.days.length > 0 ? Math.max(...b.days.map(d => d.cost)) : 1;
  let running = 0;
  for (const day of b.days) {
    running += day.cost;
    const bar     = "█".repeat(Math.min(Math.round(day.cost / maxDay * 16), 16));
    const topProj = Object.entries(day.projects).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([k,v])=>`${k} $${v.toFixed(2)}`).join("  ");
    console.log(`  ${day.date}   ${yl(("$"+day.cost.toFixed(2)).padStart(7))}   ${dim("running: $"+running.toFixed(2).padStart(7))}   ${dim(bar)}   ${dim(topProj)}`);
  }
  console.log("");

  console.log(`  ${SL}`);
  console.log(`  BY PROJECT  ${dim("— who spent the budget")}`);
  console.log(`  ${SL}`);
  for (const p of b.projects) {
    const pct = total > 0 ? Math.round(p.cost / total * 100) : 0;
    const mtok = ((p.tokens) / 1e6).toFixed(1);
    console.log(`  ${p.name.padEnd(28)}  ${yl(("$"+p.cost.toFixed(2)).padStart(7))}  ${String(pct)+"%"}  ${dim(mtok+"M tok  "+p.sessions+" sessions")}`);
  }
  console.log("");

  // ── Startup overhead ────────────────────────────────────────
  const ss2 = b.startupStats;
  if (ss2 && ss2.sessions > 0 && ss2.significant) {
    const overheadK = (ss2.overheadPerSession / 1000).toFixed(0);
    const totalK    = (ss2.totalOverheadTokens / 1000).toFixed(0);
    console.log(`  ${SL}`);
    console.log(`  STARTUP OVERHEAD  ${dim("(system prompt + tool definitions per session)")}`);
    console.log(`  ${SL}`);
    console.log(`  Sessions analyzed        ${ss2.sessions}`);
    console.log(`  Avg startup cost         ~${yl(overheadK + "k")} tokens/session  ${dim("(before first prompt)")}`);
    console.log(`  Total startup tokens     ~${yl(totalK + "k")} tokens  ${dim("= $" + ss2.overheadCost.toFixed(2) + " at Sonnet rates")}`);
    console.log(`  ${dim("Fix: entient.com collapses tool loading — first run witnesses it, every run after is free.")}`);
    console.log("");
  }

  console.log(`  ${SL}`);
  console.log(`  HOW TO READ THIS`);
  console.log(`  ${SL}`);
  console.log(`  The "running" column shows your cumulative spend by day.`);
  console.log(`  When the running total crosses your plan limit, Anthropic`);
  console.log(`  starts billing overages — those become the email receipts you receive.`);
  console.log(`  The day your running total first exceeded your plan is the day`);
  console.log(`  you started incurring charges.`);
  console.log("");
  console.log(`  ${dim("Accuracy: ±10-15% vs actual bill (token count approximation)")}`);
  console.log(`  ${dim("Pricing: Sonnet $3/MTok in, $15/MTok out, Haiku $0.80/$4, Opus $15/$75")}`);
  console.log("");
}

// ── Reconcile command ────────────────────────────────────────────────────────
// Reads claude-audit-billing.json (from the entient-spend extension export) and cross-references
// with metering.db to explain every Anthropic email receipt.

function reconcile(exportFile) {
  const defaultFile = path.join(os.homedir(), "Downloads", "claude-audit-billing.json");
  const filePath = exportFile || defaultFile;

  // Load entient-spend extension export
  if (!fs.existsSync(filePath)) {
    console.log("");
    console.log(bold("  RECONCILE — No export file found"));
    console.log(`  Expected: ${filePath}`);
    console.log("");
    console.log("  Steps to export from the entient-spend extension:");
    console.log("  1. Open Chrome → click the entient-spend extension icon");
    console.log("  2. Click  Export to entient-spend");
    console.log("  3. Save as  claude-audit-billing.json  in your Downloads folder");
    console.log("  4. Run  node audit.js reconcile  again");
    console.log("");
    return;
  }

  let exportData;
  try {
    exportData = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.log(`  Error reading ${filePath}: ${e.message}`);
    return;
  }

  const invoices   = (exportData.anthropic && exportData.anthropic.invoices)   || [];
  const dailyUsage = (exportData.anthropic && exportData.anthropic.dailyUsage) || [];

  // Load metering.db if available
  let meteringRows = [];
  let meteringAvail = false;
  const meteringPath = path.join(os.homedir(), ".entient", "v2", "metering.db");
  if (fs.existsSync(meteringPath)) {
    try {
      // Use sqlite3 via child_process if available
      const { execSync } = require("child_process");
      const query = `SELECT DATE(timestamp_utc) as d, model, SUM(total_tokens) as tok, SUM(cost_usd) as cost, COUNT(*) as calls FROM usage WHERE cached=0 GROUP BY DATE(timestamp_utc), model ORDER BY d DESC;`;
      const out = execSync(`python3 -c "
import sqlite3, json, sys
conn = sqlite3.connect('${meteringPath.replace(/\\/g, "/")}')
rows = conn.execute('''${query}''').fetchall()
print(json.dumps([{'date':r[0],'model':r[1],'tokens':r[2],'cost':r[3],'calls':r[4]} for r in rows]))
"`, { encoding: "utf8", timeout: 10000 });
      meteringRows = JSON.parse(out.trim());
      meteringAvail = true;
    } catch (_) {
      meteringAvail = false;
    }
  }

  // Group metering rows by date
  const meteringByDate = {};
  for (const r of meteringRows) {
    if (!meteringByDate[r.date]) meteringByDate[r.date] = { cost: 0, tokens: 0, calls: 0, models: {} };
    meteringByDate[r.date].cost   += r.cost   || 0;
    meteringByDate[r.date].tokens += r.tokens || 0;
    meteringByDate[r.date].calls  += r.calls  || 0;
    if (!meteringByDate[r.date].models[r.model]) meteringByDate[r.date].models[r.model] = 0;
    meteringByDate[r.date].models[r.model] += r.cost || 0;
  }

  // Build daily API cost from metering (running total to find invoice trigger days)
  const allMeteringDates = Object.keys(meteringByDate).sort();
  let runningGateway = 0;
  const runningByDate = {};
  for (const d of allMeteringDates) {
    runningGateway += meteringByDate[d].cost;
    runningByDate[d] = runningGateway;
  }

  console.log("");
  console.log(bold("  Entient Spend — RECEIPT RECONCILIATION"));
  console.log(`  Export: ${filePath}  |  Exported: ${exportData.exported_at || "unknown"}`);
  console.log(`  ${SL}`);
  console.log("");

  // ── Invoices section ──────────────────────────────────────────────────────
  if (invoices.length === 0) {
    console.log("  No Anthropic invoices found in export.");
    console.log(`  ${dim("Visit console.anthropic.com/settings/billing while the entient-spend extension is active,")}`);
    console.log(`  ${dim("then re-export.")}`);
    console.log("");
  } else {
    console.log(`  INVOICES  (${invoices.length} found)`);
    console.log(`  ${SL}`);
    for (const inv of invoices) {
      const amtStr = inv.amount != null ? yl(`$${Number(inv.amount).toFixed(2)}`) : yl("$?.??");
      const status = inv.status ? `  ${dim(inv.status)}` : "";
      console.log(`  ${(inv.id || "?").padEnd(24)}  ${(inv.date || "?").padEnd(12)}  ${amtStr}${status}`);

      // Find matching gateway activity within ±3 days of invoice date
      if (inv.date && meteringAvail) {
        const invDate = new Date(inv.date);
        const windowDays = 3;
        let windowCost = 0;
        let windowCalls = 0;
        const topModels = {};
        for (let di = -windowDays; di <= 0; di++) {
          const d = new Date(invDate.getTime() + di * 86400000).toISOString().slice(0, 10);
          const m = meteringByDate[d];
          if (m) {
            windowCost  += m.cost;
            windowCalls += m.calls;
            for (const [mdl, c] of Object.entries(m.models)) {
              topModels[mdl] = (topModels[mdl] || 0) + c;
            }
          }
        }
        if (windowCost > 0) {
          const topMdl = Object.entries(topModels).sort((a,b)=>b[1]-a[1])[0];
          const mdlStr = topMdl ? `  ${dim("top model: " + topMdl[0].replace("claude-","") + " $" + topMdl[1].toFixed(2))}` : "";
          console.log(`    ${dim("└ ENTIENT gateway ±3d:")}  ${yl("$"+windowCost.toFixed(2))}  ${dim(windowCalls+" calls")}${mdlStr}`);
        } else {
          console.log(`    ${dim("└ No ENTIENT gateway activity found ±3d of invoice date")}`);
        }
      } else if (!meteringAvail) {
        console.log(`    ${dim("└ metering.db not found — install ENTIENT gateway to track API calls")}`);
      }
    }
    console.log("");
  }

  // ── Daily API usage from entient-spend extension ──────────────────────────
  if (dailyUsage.length > 0) {
    console.log(`  DAILY USAGE FROM ANTHROPIC CONSOLE  (${dailyUsage.length} rows)`);
    console.log(`  ${SL}`);
    for (const row of dailyUsage.slice(0, 30)) {
      const costStr = row.cost != null ? yl(`$${Number(row.cost).toFixed(4)}`) : dim("$-");
      const tokStr  = row.tokens != null ? dim(`${Number(row.tokens).toLocaleString()} tok`) : "";
      const mdl     = row.model ? dim(row.model.replace("claude-","").slice(0,20).padEnd(22)) : dim("".padEnd(22));
      console.log(`  ${(row.date||"?").padEnd(12)}  ${mdl}  ${costStr.padEnd(12)}  ${tokStr}`);
    }
    if (dailyUsage.length > 30) console.log(`  ${dim("... and " + (dailyUsage.length-30) + " more rows")}`);
    console.log("");
  }

  // ── Gateway summary ────────────────────────────────────────────────────────
  if (meteringAvail && allMeteringDates.length > 0) {
    console.log(`  ENTIENT GATEWAY — METERED API SPEND  (metering.db)`);
    console.log(`  ${SL}`);
    const last30 = allMeteringDates.slice(-30);
    for (const d of last30.reverse()) {
      const m = meteringByDate[d];
      const bar = "█".repeat(Math.min(Math.round(m.cost / 0.5 * 8), 16));
      const topMdl = Object.entries(m.models).sort((a,b)=>b[1]-a[1])[0];
      const mdlStr = topMdl ? dim(topMdl[0].replace("claude-","").slice(0,18)) : "";
      console.log(`  ${d}   ${yl(("$"+m.cost.toFixed(4)).padStart(9))}   ${dim(m.calls+" calls")}   ${mdlStr}   ${dim(bar)}`);
    }
    const totalGateway = allMeteringDates.reduce((s, d) => s + meteringByDate[d].cost, 0);
    console.log(`  ${SL}`);
    console.log(`  Total (metering.db, all time):  ${yl("$"+totalGateway.toFixed(2))}`);
    console.log("");
  }

  // ── Coverage gaps ──────────────────────────────────────────────────────────
  console.log(`  ${SL}`);
  console.log(`  COVERAGE GAPS`);
  console.log(`  ${SL}`);
  console.log(`  These API callers are NOT logged to metering.db:`);
  const untracked = [
    "bulk_synthesize.py", "gpu_worker_notebook.py", "haiku_router.py",
    "label_worker.py", "lightning_worker.py", "mine_eye_bulk.py",
    "openclaw_operators.py", "operator_mill.py", "operator_synthesizer.py",
  ];
  for (const f of untracked) console.log(`    ${dim("• entient-interceptor/tools/" + f)}`);
  console.log(`  To close this gap: add _log_to_metering() wrapper to each file.`);
  console.log(`  Until then, estimated untracked spend: $2-5/month (labeling/synthesis).`);
  console.log("");
  console.log(`  ${dim("To get full billing data: visit console.anthropic.com/settings/billing")}`);
  console.log(`  ${dim("and console.anthropic.com/settings/usage while the entient-spend extension is active.")}`);
  console.log("");
}

// ── Live HUD ────────────────────────────────────────────────────────────────
// Ports the data sources the tray icon already polls (entient-agent/tools/entient_tray.ps1):
//   ~/.entient/governance/governance_events.jsonl  — deflect / forward events
//   ~/.entient/forwards/forwards.jsonl             — intake pipeline
// Customer-framed output: inferences deferred, tokens saved, $ saved, session waste factor.

const ENTIENT_GOV_LOG  = path.join(os.homedir(), ".entient", "governance", "governance_events.jsonl");
const ENTIENT_FWD_LOG  = path.join(os.homedir(), ".entient", "forwards", "forwards.jsonl");
const ENTIENT_PID_FILE = path.join(os.homedir(), ".entient", "watcher.pid");
const AVG_TOKENS_PER_INFERENCE = 1500;   // conservative rule-of-thumb for deferral value
const AVG_USD_PER_INFERENCE    = 0.008;  // sonnet-ish blended rate on 1.5k tokens

function tailBytes(filePath, maxBytes) {
  try {
    const st = fs.statSync(filePath);
    const len = Math.min(st.size, maxBytes);
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch (_) { return ""; }
}

function countGovEvents() {
  // Tail ~32MB — ~80K events; cumulative counts over whatever window that spans.
  // "last active" is the freshness signal, not a hardcoded time window.
  const raw = tailBytes(ENTIENT_GOV_LOG, 32 * 1024 * 1024);
  if (!raw) return null;
  const lines = raw.split("\n");
  lines.shift();
  let deflect = 0, forward = 0, total = 0, firstTs = null, lastTs = null;
  // Measured-avoided-cost rollup (from deflect_measured events; see
  // entient-interceptor/deflect_cost_measurement.py). Parallel to the deflect
  // counter — always present, 0 if the interceptor hasn't measured anything.
  let measuredCount = 0, measuredErrors = 0;
  let measuredInputTokens = 0, measuredUsdAvoided = 0;
  for (const line of lines) {
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch (_) { continue; }
    const ts = rec.ts;
    if (ts) { if (firstTs === null || ts < firstTs) firstTs = ts; if (lastTs === null || ts > lastTs) lastTs = ts; }
    if (rec.type === "deflect") { deflect++; total++; }
    else if (rec.type === "forward") { forward++; total++; }
    else if (rec.type === "deflect_measured") {
      const d = rec.data || {};
      if (d.status === "ok") {
        measuredCount++;
        measuredInputTokens += d.input_tokens_measured || 0;
        measuredUsdAvoided  += d.input_cost_usd_avoided || 0;
      } else {
        measuredErrors++;
      }
    }
  }
  return {
    deflect, forward, total, firstTs, lastTs,
    measuredCount, measuredErrors, measuredInputTokens, measuredUsdAvoided,
  };
}

function watcherRunning() {
  try {
    const pidRaw = fs.readFileSync(ENTIENT_PID_FILE, "utf8").trim();
    const pid = parseInt(pidRaw, 10);
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (_) { return false; }
  } catch (_) { return false; }
}

function activityState(lastTs) {
  if (lastTs === null) return { label: "No recent traffic", color: dim };
  const hrs = (Date.now() / 1000 - lastTs) / 3600;
  if (hrs < 0.1) return { label: "Active now",       color: yl };
  if (hrs < 1)   return { label: "Active recently",  color: yl };
  if (hrs < 24)  return { label: "Idle",             color: dim };
  return                 { label: "No recent traffic", color: dim };
}

function countForwards() {
  const raw = tailBytes(ENTIENT_FWD_LOG, 1 * 1024 * 1024);
  if (!raw) return { total: 0, sources: {} };
  const lines = raw.split("\n");
  lines.shift();
  const sources = {};
  let total = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    total++;
    let rec; try { rec = JSON.parse(line); } catch (_) { continue; }
    const src = rec.source || "mcp";
    sources[src] = (sources[src] || 0) + 1;
  }
  return { total, sources };
}

function bar(pct, width = 24) {
  const fill = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "█".repeat(fill) + "░".repeat(width - fill);
}

function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function renderHud() {
  const gov = countGovEvents();
  const fwd = countForwards();
  const running = watcherRunning();

  // Session waste factor (reuse existing logic)
  let sessionLine = dim("no active session detected");
  try {
    const sf = currentSessionFile();
    if (sf) {
      const w = computeWasteFactor(sf);
      const factor = w.factor || 1;
      const thresh = DEFAULTS.threshold;
      const pct = Math.min(100, (factor / thresh) * 100);
      sessionLine = `waste factor ${bold(factor + "x")} / ${thresh}x kill  ${bar(pct, 20)}  turns=${w.turns}`;
    }
  } catch (_) {}

  const lines = [];
  lines.push("");
  lines.push(bold("  Entient Spend  live HUD") + dim("    (cumulative, refresh 2s, q to quit)"));
  lines.push("  " + SL);

  if (!gov) {
    lines.push("  " + dim("no ENTIENT governance log found at"));
    lines.push("  " + dim("  " + ENTIENT_GOV_LOG));
    lines.push("  " + dim("install the gateway at entient.com to unlock deferral metrics"));
  } else {
    const deflectPct  = gov.total ? (gov.deflect / gov.total) * 100 : 0;
    const per100      = Math.round(deflectPct);
    const state       = activityState(gov.lastTs);
    const runBadge    = running ? yl("● running") : dim("○ stopped");

    lines.push("");
    lines.push(bold("  LLM CALLS AVOIDED") + dim("  (ENTIENT caught these before the model)"));
    lines.push("    " + bar(deflectPct, 30) + "  " +
               yl(deflectPct.toFixed(0) + "%") + "   " +
               bold(String(gov.deflect)) + " / " + gov.total + " prompts");
    lines.push("    " + dim(per100 + " of every 100 prompts avoided · " + state.color(state.label) +
                            " · watcher " + runBadge));
    lines.push("");

    // Prefer measured numbers from deflect_measured events (backed by
    // Anthropic /v1/messages/count_tokens). Fall back to the rule-of-thumb
    // estimate when measurement is disabled or hasn't run yet.
    const measured      = gov.measuredCount || 0;
    const measurableMin = Math.max(measured, 1);
    const coveragePct   = gov.deflect > 0 ? Math.min(100, (measured / gov.deflect) * 100) : 0;

    if (measured > 0) {
      // Extrapolate: if we measured M of D deflects at avg $X/deflect,
      // projected total = X * D. Show both measured-so-far and projected.
      const avgUsdPerDeflect = gov.measuredUsdAvoided / measurableMin;
      const avgTokPerDeflect = gov.measuredInputTokens / measurableMin;
      const projUsd  = avgUsdPerDeflect * gov.deflect;
      const projTok  = avgTokPerDeflect * gov.deflect;

      lines.push(bold("  INPUT TOKENS AVOIDED") + dim("   (measured by count_tokens)"));
      lines.push("    " + yl(fmtNum(gov.measuredInputTokens) + " tok") +
                 dim("  measured across " + measured + " deflects"));
      lines.push("    " + dim("projected total: ~" + fmtNum(projTok) + " tok  (scaled to all " +
                 gov.deflect + " deflects)"));
      lines.push("");
      lines.push(bold("  INPUT $ AVOIDED") + "          " +
                 bold("$" + gov.measuredUsdAvoided.toFixed(4)) +
                 dim("  measured"));
      lines.push("    " + dim("projected total: ~$" + projUsd.toFixed(2) +
                 "  (coverage: " + coveragePct.toFixed(0) + "% of deflects measured)"));
      if (gov.measuredErrors > 0) {
        lines.push("    " + dim(gov.measuredErrors + " measurement errors (network/auth) — still deflected, just uncounted"));
      }
    } else {
      // Fallback: coarse estimate. Flag explicitly so nobody confuses this for measurement.
      const tokensSaved = gov.deflect * AVG_TOKENS_PER_INFERENCE;
      const usdSaved    = gov.deflect * AVG_USD_PER_INFERENCE;
      lines.push(bold("  ESTIMATED TOKENS SAVED") + "   " + yl("~" + fmtNum(tokensSaved) + " tok") +
                 dim("  (rule-of-thumb)"));
      lines.push(bold("  ESTIMATED $ SAVED") + "        " + bold("$" + usdSaved.toFixed(2)) +
                 dim("  (rule-of-thumb)"));
      lines.push("    " + dim("enable measured cost: setx ENTIENT_DEFLECT_COST_MEASUREMENT on"));
    }
    lines.push("");
    lines.push(bold("  FORWARDED TO LLM") + "         " + String(gov.forward) +
               dim("  (couldn't avoid — needed inference)"));
  }

  lines.push("");
  lines.push("  " + SL);
  lines.push(bold("  THIS CLAUDE SESSION") + "     " + sessionLine);
  lines.push("");
  lines.push("  " + dim("intake pipeline: " + fwd.total + " forwards  ") +
             Object.entries(fwd.sources).map(([k, v]) => `${k}=${v}`).join(" "));
  lines.push("");
  const footer = (gov && gov.measuredCount > 0)
    ? "input $ avoided = sum of Anthropic count_tokens × public input rate · entient.com"
    : "savings estimated from avoided forwarded tokens · entient.com";
  lines.push("  " + dim(footer));
  lines.push("");

  return lines.join("\n");
}

function hud() {
  const isTTY = process.stdout.isTTY;
  if (!isTTY) {
    // Non-TTY: single-shot render for scripting / piping.
    console.log(renderHud());
    return;
  }

  // TTY: clear + repaint every 2s.
  const hide = "\x1b[?25l", show = "\x1b[?25h", clear = "\x1b[2J\x1b[H";
  process.stdout.write(hide);

  const paint = () => { process.stdout.write(clear + renderHud() + "\n"); };
  paint();
  const timer = setInterval(paint, 2000);

  const cleanup = () => {
    clearInterval(timer);
    process.stdout.write(show + "\n");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", buf => {
      const k = buf.toString();
      if (k === "q" || k === "Q" || k === "\x03") cleanup();
    });
  }
}

function main() {
  const opts = parseArgs();

  // Hook modes — called by Claude Code
  if (opts.hook === "prompt")  { hookPrompt();  return; }
  if (opts.hook === "tool")    { hookTool();    return; }
  if (opts.hook === "compact") { hookCompact(); return; }
  if (opts.hook === "start")   { hookStart();   return; }
  if (opts.hook === "status")  { hookStatus();  return; }

  // Management commands
  if (opts.command === "install")            { install();            return; }
  if (opts.command === "install-shadow")     { installShadow();      return; }
  if (opts.command === "shadow-report")     { shadowReport();       return; }
  if (opts.command === "install-autorestart") { installAutorestart(); return; }
  if (opts.command === "uninstall")          { uninstall();          return; }
  if (opts.command === "status")    { status();    return; }
  if (opts.command === "doctor")    { doctor();    return; }
  if (opts.command === "setup")     { setup();     return; }
  if (opts.command === "billing")    { billingReport(opts.last); return; }
  if (opts.command === "count-tokens"){ countTokensCmd({ model: opts.model, text: opts.text, json: opts.json }); return; }
  if (opts.command === "cost-report") { costReportCmd(opts.last); return; }
  if (opts.command === "reconcile") { reconcile(opts.reconcileFile); return; }
  if (opts.command === "redundancy") { redundancyReport(opts); return; }
  if (opts.command === "gate-stats") { gateStatsCmd(); return; }
  if (opts.command === "hud")       { hud(); return; }

  // Non-interactive modes
  if (opts.json) {
    const { since } = parseWindow(opts.last);
    const sub     = readSubscriptionActivity(since);
    const billing = computeTokenBilling(since);
    console.log(JSON.stringify({ window: opts.last, subscription: sub, startupStats: billing.startupStats || null }, null, 2));
    return;
  }

  // HTML report export
  if (opts.report) {
    const { since } = parseWindow(opts.last);
    const sub = readSubscriptionActivity(since);
    const bug = scanCacheBugFast();
    const enforced = hooksInstalled();
    exportReport(sub, bug, enforced);
    return;
  }

  // Plain report if --last specified explicitly
  if (process.argv.slice(2).some(a => a.startsWith("--last") || a === "-l")) {
    const { since } = parseWindow(opts.last);
    const sub = readSubscriptionActivity(since);
    console.log(formatReport(sub, opts.last));
    return;
  }

  // Default: interactive menu
  menu().catch(e => { console.error(e.message); process.exit(1); });
}

main();
