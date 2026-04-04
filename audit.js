#!/usr/bin/env node
/**
 * claude-audit — Claude Code Waste Analyzer + Session Enforcer
 *
 * Two modes:
 *   1. REPORT   — reads ~/.claude and shows where quota went (no hooks needed)
 *   2. ENFORCE  — registers hooks that block sessions when waste factor gets too high
 *
 * Usage:
 *   claude-audit                        # waste report (last 7d)
 *   claude-audit --last 30d
 *   claude-audit install                # register enforcement hooks
 *   claude-audit uninstall              # remove hooks
 *   claude-audit status                 # show hook status + current waste factor
 *   claude-audit --json                 # machine-readable report
 *
 *   # Hook modes (called by Claude Code, not users):
 *   claude-audit --hook prompt          # UserPromptSubmit — block if waste too high
 *   claude-audit --hook tool            # PostToolUse — block autonomous work if waste high
 *   claude-audit --hook compact         # PreCompact — save session state
 *   claude-audit --hook start           # SessionStart — inject saved context
 *
 * Want automated enforcement?  entient.ai
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ── Config ──────────────────────────────────────────────────────────────────

const AUDIT_DIR       = path.join(os.homedir(), ".claude-audit");
const LAST_SESSION    = path.join(AUDIT_DIR, "last-session.md");
const CONFIG_FILE     = path.join(AUDIT_DIR, "config.json");
const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const CLAUDE_HISTORY  = path.join(os.homedir(), ".claude", "history.jsonl");
const PROJECTS_DIR    = path.join(os.homedir(), ".claude", "projects");

const DEFAULTS = {
  threshold:  10,    // waste factor (current/baseline) that triggers block
  minTurns:   20,    // minimum turns before enforcing
  baselineTurns: 5,  // turns used to establish baseline
  windowTurns: 5,    // turns used for current average
};

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch (_) { return { ...DEFAULTS }; }
}

function ensureAuditDir() {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
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

/** Find the JSONL file for the current session from env vars. */
function currentSessionFile() {
  const sessionId  = process.env.CLAUDE_SESSION_ID;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

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

// ── Hook handlers ────────────────────────────────────────────────────────────

function hookPrompt() {
  const cfg  = loadConfig();
  const file = currentSessionFile();
  if (!file) { process.exit(0); }

  const w = computeWasteFactor(file, cfg);
  if (!w || !w.blocked) { process.exit(0); }

  // Save context before blocking
  saveSessionContext(file, w);

  const msg = [
    `╔${"═".repeat(60)}╗`,
    `║  claude-audit: Session using ${w.factor}x more quota than start  `.padEnd(62) + "║",
    `╚${"═".repeat(60)}╝`,
    ``,
    `Your turns started at ~${w.baseline.toLocaleString()} tokens.`,
    `They're now at ~${w.current.toLocaleString()} tokens (${w.factor}x more per turn).`,
    `After ${w.turns} turns, each prompt costs ${w.factor}x what it did at session start.`,
    ``,
    `Session context saved. Start fresh: run \`claude\``,
    `claude-audit will inject your previous context automatically.`,
    ``,
    `To continue anyway: set CLAUDE_AUDIT_SKIP=1 in your environment.`,
  ].join("\n");

  if (process.env.CLAUDE_AUDIT_SKIP) { process.exit(0); }

  // Output block decision
  process.stdout.write(JSON.stringify({ decision: "block", reason: msg }) + "\n");
  process.exit(0);
}

function hookTool() {
  const cfg  = loadConfig();
  const file = currentSessionFile();
  if (!file || process.env.CLAUDE_AUDIT_SKIP) { process.exit(0); }

  const w = computeWasteFactor(file, cfg);
  if (!w || !w.blocked) { process.exit(0); }

  saveSessionContext(file, w);

  process.stderr.write(
    `[claude-audit] Session at ${w.factor}x waste (${w.turns} turns). ` +
    `Start fresh: run \`claude\`. Context saved to ${LAST_SESSION}\n`
  );
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
  if (!fs.existsSync(LAST_SESSION)) { process.exit(0); }

  const age = Date.now() - fs.statSync(LAST_SESSION).mtimeMs;
  if (age > 48 * 3_600_000) { process.exit(0); }  // ignore if >48h old

  const context = fs.readFileSync(LAST_SESSION, "utf8");
  process.stdout.write(JSON.stringify({ additionalContext: context }) + "\n");
  process.exit(0);
}

// ── Context preservation ─────────────────────────────────────────────────────

function saveSessionContext(sessionFile, waste) {
  ensureAuditDir();

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const project    = path.basename(projectDir);
  const branch     = getGitBranch(projectDir);
  const modified   = getModifiedFiles(projectDir);

  const lines = [
    `# Previous Session (saved by claude-audit)`,
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
      (h.hooks || []).some(hh => (hh.command || "").includes("claude-audit"))
    );
    if (already) { console.log(`  ${event}: already installed`); continue; }

    settings.hooks[event].push({ hooks: [{ type: "command", command: cmd }] });
    console.log(`  ${event}: installed`);
    added++;
  }

  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), "utf8");

  if (added > 0) {
    console.log(`\n✓ claude-audit installed (${added} hooks added)`);
    console.log(`  Threshold: ${DEFAULTS.threshold}x waste factor`);
    console.log(`  Config:    ${CONFIG_FILE}`);
    console.log(`  Context:   ${LAST_SESSION}`);
    console.log(`\n  To skip enforcement on a session: set CLAUDE_AUDIT_SKIP=1`);
  } else {
    console.log("\n✓ Already installed.");
  }
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
      !(h.hooks || []).some(hh => (hh.command || "").includes("claude-audit"))
    );
    removed += before - settings.hooks[event].length;
  }
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), "utf8");
  console.log(`✓ Removed ${removed} claude-audit hook(s).`);
}

function status() {
  console.log("── claude-audit status ──\n");

  // Hook installation
  let hooksInstalled = 0;
  if (fs.existsSync(CLAUDE_SETTINGS)) {
    try {
      const s = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8"));
      for (const event of Object.keys(HOOKS_TO_INSTALL)) {
        const hooks = s.hooks?.[event] || [];
        const found = hooks.some(h => (h.hooks || []).some(hh => (hh.command || "").includes("claude-audit")));
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
      console.log(`    Waste factor:  ${w.factor}x ${w.factor >= DEFAULTS.threshold ? "⚠ WOULD BLOCK" : "✓ ok"}`);
    }
  }

  // Saved context
  if (fs.existsSync(LAST_SESSION)) {
    const age = Math.round((Date.now() - fs.statSync(LAST_SESSION).mtimeMs) / 60000);
    console.log(`\n  Saved context:   ${LAST_SESSION} (${age}min ago)`);
  }

  console.log(`\n  ${hooksInstalled === 4 ? "✓ Fully installed" : `⚠ Run 'claude-audit install' to enable enforcement`}`);
}

// ── Analytics (original report) ─────────────────────────────────────────────

const CONTINUATION_RE = /^(proceed|continue|do it|go ahead|yes|no|ok|good|both|all|now do|next|great|sounds|done|sure|right|correct|perfect|got it|makes sense|agreed)\b/i;
const SHORT_ACK       = 8;
const HIGH_RE         = /traceback|error:|exception:|nameerror|typeerror|assertionerror|```|architect|implement|refactor|generate code|write.*test|update.*spec/i;
const LOW_RE          = /^(where is|what is|what are|what was|did you|does the|how do|can you show|rename it|it wasn.t)/i;

function classifyPromptComplexity(text) {
  const t = (text || "").trim();
  if (!t) return "empty";
  const wordCount = t.split(/\s+/).length;
  const hasHigh = HIGH_RE.test(t);
  if (hasHigh) return "high";
  if (CONTINUATION_RE.test(t) || (!hasHigh && wordCount <= SHORT_ACK)) return "continuation";
  if (LOW_RE.test(t)) return "low";
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
  console.log("\n  claude-audit doctor\n");

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
  lines.push("  HOW TO ACT");
  lines.push(hr());
  lines.push("  1. Start exploratory sessions on Haiku:  /model haiku");
  lines.push("  2. Switch to Sonnet when complexity arrives (see turn # above)");
  lines.push("  3. Use /compact before 30 turns to reset context");
  lines.push("  4. Run `claude-audit install` to enforce this automatically");
  lines.push("");
  lines.push("  entient.ai — routes each prompt to the right model, deflects repeats");
  lines.push("");
  lines.push(hr("="));
  lines.push(`  Generated ${new Date().toISOString().slice(0, 19).replace("T", " ")}`);
  lines.push(hr("="));

  return lines.join("\n");
}

// ── CLI dispatch ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { last: "7d", json: false, command: null, hook: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "install")        { opts.command = "install";   }
    else if (args[i] === "uninstall") { opts.command = "uninstall"; }
    else if (args[i] === "status")    { opts.command = "status";    }
    else if (args[i] === "doctor")    { opts.command = "doctor";    }
    else if (args[i] === "--hook" && args[i + 1]) { opts.hook = args[++i]; }
    else if ((args[i] === "--last" || args[i] === "-l") && args[i + 1]) opts.last = args[++i];
    else if (args[i].startsWith("--last=")) opts.last = args[i].slice(7);
    else if (args[i] === "--json") opts.json = true;
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: claude-audit [install|uninstall|status] [--last 7d] [--json]");
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
  red:    "\x1b[31m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  cyan:   "\x1b[36m",
  white:  "\x1b[37m",
  bgRed:  "\x1b[41m",
};
const bold   = s => `${C.bold}${s}${C.reset}`;
const dim    = s => `${C.dim}${s}${C.reset}`;
const red    = s => `${C.red}${s}${C.reset}`;
const yellow = s => `${C.yellow}${s}${C.reset}`;
const green  = s => `${C.green}${s}${C.reset}`;
const cyan   = s => `${C.cyan}${s}${C.reset}`;

// ── Interactive menu ──────────────────────────────────────────────────────────

function hooksInstalled() {
  try {
    const s = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8"));
    return Object.values(s.hooks || {}).flat()
      .some(h => (h.hooks || []).some(hh => (hh.command || "").includes("claude-audit")));
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

function printDashboard(sub, bug, enforced) {
  clearScreen();
  const t = sub.available ? sub.totalPrompts : 0;
  const haiku = sub.available ? sub.haikuEligible : 0;
  const haikuPct = t > 0 ? Math.round(haiku / t * 100) : 0;
  const wa = sub.available ? (sub.wasteAnalysis || []) : [];
  const badSessions = wa.filter(s => s.wasteTypes.length > 0).length;

  const W2 = 58;
  const line = "─".repeat(W2);

  console.log("");
  console.log(bold(`  ┌${"─".repeat(W2)}┐`));
  console.log(bold(`  │`) + cyan(bold("  CLAUDE AUDIT".padEnd(W2))) + bold("│"));
  console.log(bold(`  ├${line}┤`));
  console.log(bold("  │") + `  Last 7 days`.padEnd(W2) + bold("│"));
  console.log(bold("  │") + `  ${bold(t.toLocaleString())} prompts   ${haikuPct >= 40 ? red(bold(`${haikuPct}% wasted on wrong model`)) : green(`${haikuPct}% waste`)}   ${badSessions > 0 ? red(`${badSessions} problem sessions`) : green("0 problem sessions")}`.padEnd(W2 + 20) + bold("│"));
  console.log(bold("  │") + "".padEnd(W2) + bold("│"));

  // Cache bug line
  if (bug.bugged > 0) {
    const bugPct = Math.round(bug.bugged / bug.total * 100);
    const bugM   = (bug.buggedTokens / 1_000_000).toFixed(0);
    console.log(bold("  │") + `  ${yellow("⚠")} Cache bug: ${yellow(`${bugPct}% of recent sessions affected`)} (~${bugM}M tokens lost)`.padEnd(W2 + 20) + bold("│"));
  } else {
    console.log(bold("  │") + `  ${green("✓")} Cache bug: ${green("not affected")} (you're on a clean version)`.padEnd(W2 + 15) + bold("│"));
  }

  // Enforcement line
  if (enforced) {
    console.log(bold("  │") + `  ${green("✓")} Enforcement: ${green("active")} — blocking runaway sessions automatically`.padEnd(W2 + 15) + bold("│"));
  } else {
    console.log(bold("  │") + `  ${red("✗")} Enforcement: ${red("off")} — sessions can burn freely, no auto-stop`.padEnd(W2 + 20) + bold("│"));
  }

  console.log(bold(`  └${line}┘`));
  console.log("");
  console.log(`  ${bold("1.")} Where is my money going?`);
  console.log(`  ${bold("2.")} Worst sessions`);
  console.log(`  ${bold("3.")} Cache bug detail`);
  if (enforced) {
    console.log(`  ${bold("4.")} ${green("✓ Auto-enforcement is ON")}  ${dim("(turn off: claude-audit uninstall)")}`);
  } else {
    console.log(`  ${bold("4.")} ${yellow("Turn on auto-enforcement")}  ${dim("← blocks runaway sessions, saves context")}`);
  }
  console.log(`  ${bold("q.")} Quit`);
  console.log("");
}

function showMoneyScreen(sub) {
  clearScreen();
  const t = sub.totalPrompts, c = sub.complexity, model = sub.configuredModel;
  const haiku = sub.haikuEligible;
  const haikuPct = t > 0 ? Math.round(haiku / t * 100) : 0;
  const ackPct  = t > 0 ? Math.round((c.continuation||0) / t * 100) : 0;
  const highPct = t > 0 ? Math.round((c.high||0) / t * 100) : 0;
  const wa = sub.wasteAnalysis || [];
  const replaySessions = wa.filter(s => s.wasteTypes.includes("context_replay")).length;

  console.log("");
  console.log(bold(cyan("  WHERE IS MY MONEY GOING?")));
  console.log("  " + "─".repeat(54));
  console.log("");
  console.log(`  ${bold("Wrong model")}  ${red(bold(`${haikuPct}% of your prompts`))} didn't need ${model}.`);
  console.log(`  They were simple questions, confirmations, one-liners.`);
  console.log(`  All of them ran on ${model} anyway.`);
  console.log("");
  console.log(`  ${bold("Confirmation loops")}  ${ackPct}% of your prompts were:`);
  console.log(`  "ok" / "proceed" / "go ahead" / "continue" / "yes"`);
  console.log(`  Each one re-sent your ${dim("entire")} conversation history to the model.`);
  console.log(`  Zero new information. Full price.`);
  console.log("");
  console.log(`  ${bold("Context replay")}  ${replaySessions} sessions ran so long that`);
  console.log(`  by turn 30+, each prompt was carrying 10k–30k tokens`);
  console.log(`  of old conversation that the model had already seen.`);
  console.log("");
  console.log(`  ${bold("Only")} ${red(bold(`${highPct}%`))} of your prompts actually needed ${model}-level reasoning.`);
  console.log("");

  // Prompt complexity bar chart
  console.log(`  ${dim("Prompt breakdown:")}`);
  const order = [["continuation","ACKs / one-liners ",C.red],["low","Simple questions  ",C.yellow],["medium","Medium tasks      ",C.white],["high","Complex work      ",C.green]];
  for (const [key, label, color] of order) {
    const n = c[key] || 0, pct = t > 0 ? Math.round(n/t*100) : 0;
    const bar = "█".repeat(Math.round(pct / 3));
    console.log(`  ${label}  ${color}${bar}${C.reset}  ${String(pct).padStart(3)}%  (${n})`);
  }
  console.log("");
  console.log(dim("  Press Enter to go back."));
}

function showSessionsScreen(sub) {
  clearScreen();
  const wa = (sub.wasteAnalysis || []).slice(0, 8);
  const model = sub.configuredModel;

  console.log("");
  console.log(bold(cyan("  WORST SESSIONS")));
  console.log("  " + "─".repeat(54));
  console.log("");

  if (wa.length === 0) { console.log("  No session data."); console.log(""); return; }

  for (const [i, s] of wa.entries()) {
    const dt    = new Date(s.lastTs).toISOString().slice(5, 16).replace("T", " ");
    const badge = s.wasteTypes.length >= 2 ? red("⚠⚠ triple-cost") : s.wasteTypes.length === 1 ? yellow("⚠ issue") : green("✓ ok");

    console.log(`  ${bold(`${i+1}.`)} ${bold(s.project)}  ${dim(dt)}  ${badge}`);
    console.log(`     ${s.prompts} turns over ${s.durationHrs}h`);

    if (s.wasteTypes.includes("wrong_model")) {
      console.log(`     ${red("✗")} ${s.haikuPct}% of prompts were simple — ran on ${model} for no reason`);
      console.log(`       ${dim(`Fix: start this kind of session with /model haiku`)}`);
    }
    if (s.wasteTypes.includes("session_bloat")) {
      console.log(`     ${red("✗")} ${s.ackPct}% were confirmations — each one replayed full context`);
      console.log(`       ${dim("Fix: batch your intent, stop sending one-word replies")}`);
    }
    if (s.wasteTypes.includes("context_replay")) {
      console.log(`     ${red("✗")} Session ran ${s.durationHrs}h — context ballooned by turn 30+`);
      console.log(`       ${dim("Fix: /compact or start a fresh session after 30 turns")}`);
    }
    if (s.wasteTypes.length === 0) {
      console.log(`     ${green("No significant waste detected.")}`);
    }

    console.log(`     ${dim(`→ Should have started on: ${s.recommendedStartModel.toUpperCase()} — ${s.escalation}`)}`);
    console.log("");
  }
  console.log(dim("  Press Enter to go back."));
}

function showCacheScreen(bug) {
  clearScreen();
  console.log("");
  console.log(bold(cyan("  CACHE BUG")));
  console.log("  " + "─".repeat(54));
  console.log("");
  console.log(`  Claude Code versions ${bold("2.1.69 – 2.1.89")} had a broken prompt cache.`);
  console.log(`  Instead of reusing cached context, every turn paid full price`);
  console.log(`  to re-process the entire conversation history.`);
  console.log(`  Effect: ${bold("10–20x token burn")} on long sessions.`);
  console.log("");

  if (bug.bugged > 0) {
    const pct  = Math.round(bug.bugged / bug.total * 100);
    const bugG = (bug.buggedTokens / 1_000_000_000).toFixed(1);
    const bugM = (bug.buggedTokens / 1_000_000).toFixed(0);
    console.log(`  ${red(bold("YOUR IMPACT"))}`);
    console.log(`  ${red(`${bug.bugged} of ${bug.total}`)} sessions (${red(`${pct}%`)}) ran under this bug.`);
    console.log(`  ~${bold(bugG > "1.0" ? bugG + "B" : bugM + "M")} tokens consumed with broken caching.`);
    console.log(`  These tokens are spent. They cannot be recovered.`);
    console.log("");
    console.log(`  ${yellow("You're now on a clean version.")} The bug is behind you.`);
    console.log(`  Going forward, caching works correctly.`);
  } else {
    console.log(`  ${green(bold("You were not affected."))} Your sessions ran on clean versions.`);
  }

  console.log("");
  console.log(`  ${dim("Run: claude update  (if you haven't already)")}`);
  console.log("");
  console.log(dim("  Press Enter to go back."));
}

function showEnforceScreen(enforced) {
  clearScreen();
  console.log("");
  console.log(bold(cyan("  AUTO-ENFORCEMENT")));
  console.log("  " + "─".repeat(54));
  console.log("");

  if (enforced) {
    console.log(`  ${green(bold("✓ Active."))} Enforcement hooks are installed.`);
    console.log("");
    console.log(`  When a session hits ${bold("10x waste factor:")} `);
    console.log(`    · Claude is blocked before the next prompt burns tokens`);
    console.log(`    · Your session state is saved (branch, files, what you were doing)`);
    console.log(`    · Start a fresh session — context is injected automatically`);
    console.log("");
    console.log(`  ${dim("To turn off: claude-audit uninstall")}`);
    console.log(`  ${dim("To configure threshold: edit ~/.claude-audit/config.json")}`);
  } else {
    console.log(`  ${yellow("Not installed.")} Your sessions can run indefinitely.`);
    console.log("");
    console.log(`  With enforcement on:`);
    console.log(`    · Sessions that hit ${bold("10x waste")} are automatically blocked`);
    console.log(`    · Context saved before compaction so you never lose your place`);
    console.log(`    · Fresh session starts with full awareness of the previous one`);
    console.log(`    · Works silently in the background — no manual monitoring`);
    console.log("");
    console.log(`  ${bold("Install now?")}  Type ${cyan("y")} to install, or Enter to go back.`);
  }
  console.log("");
}

async function menu() {
  const readline = require("readline");

  const { since } = parseWindow("7d");
  process.stdout.write("  Loading...\r");
  const sub = readSubscriptionActivity(since);
  const bug = scanCacheBugFast();
  const enforced = hooksInstalled();

  const ask = (prompt) => new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, ans => { rl.close(); resolve(ans.trim().toLowerCase()); });
  });

  while (true) {
    printDashboard(sub, bug, enforced);
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
          console.log("");
          console.log(green("  ✓ Enforcement installed. Restart Claude Code to activate."));
          console.log("");
          await ask("  Press Enter to continue.");
        }
      }
    } else if (choice === "q" || choice === "quit" || choice === "exit") {
      clearScreen();
      break;
    }
  }
}

function main() {
  const opts = parseArgs();

  // Hook modes — called by Claude Code
  if (opts.hook === "prompt")  { hookPrompt();  return; }
  if (opts.hook === "tool")    { hookTool();    return; }
  if (opts.hook === "compact") { hookCompact(); return; }
  if (opts.hook === "start")   { hookStart();   return; }

  // Management commands
  if (opts.command === "install")   { install();   return; }
  if (opts.command === "uninstall") { uninstall(); return; }
  if (opts.command === "status")    { status();    return; }
  if (opts.command === "doctor")    { doctor();    return; }

  // Non-interactive modes
  if (opts.json) {
    const { since } = parseWindow(opts.last);
    const sub = readSubscriptionActivity(since);
    console.log(JSON.stringify({ window: opts.last, subscription: sub }, null, 2));
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
