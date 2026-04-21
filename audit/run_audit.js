#!/usr/bin/env node
// Evergreen numbers audit for Entient Spend.
// See AUDIT_SPEC.md for definitions and the publishing rule.
//
//   node audit/run_audit.js            # default 30-day window
//   node audit/run_audit.js --days 7   # custom window
//   node audit/run_audit.js --json     # machine-readable only

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const crypto = require("crypto");
const { execSync } = require("child_process");

// ── Config ──────────────────────────────────────────────────────────────────
const ROOT            = path.resolve(__dirname, "..");
const AUDIT_JS        = path.join(ROOT, "audit.js");
const SPEC_MD         = path.join(__dirname, "AUDIT_SPEC.md");
const SNAPSHOT_DIR    = path.join(__dirname, "snapshots");
const SAMPLE_DIR      = path.join(__dirname, "samples");
const LABELS_FILE     = path.join(__dirname, "labels.jsonl");
const CLAUDE_HISTORY  = path.join(os.homedir(), ".claude", "history.jsonl");

const argv = process.argv.slice(2);
const DAYS = (() => {
  const i = argv.indexOf("--days");
  return i >= 0 ? parseInt(argv[i + 1], 10) || 30 : 30;
})();
const JSON_ONLY = argv.includes("--json");

// ── Classifier v2 (frozen copy — must match audit.js) ──────────────────────
// v2 (2026-04-17): strip leading ACK, require short remainder for continuation,
// expanded LOW_RE vocab. If the constants in audit.js change, update these
// AND the liveClassifierMatchesFrozen expect[] AND bump the spec.
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

function classify(text) {
  const t = (text || "").trim();
  if (!t) return "empty";
  if (HIGH_RE.test(t)) return "high";
  const core = stripAckPrefix(t);
  const wc = core.split(/\s+/).length;
  if (LOW_RE.test(core) && wc <= LOW_MAX_WORDS) return "low";
  if (wc <= SHORT_ACK) return "continuation";
  return "medium";
}

// ── Drift check: does our frozen classifier still match audit.js? ──────────
function liveClassifierMatchesFrozen() {
  const js = fs.readFileSync(AUDIT_JS, "utf8");
  const expect = [
    "^(proceed|continue|do it|go ahead|yes|no|ok|good|both|all|now do|next|great|sounds|done|sure|right|correct|perfect|got it|makes sense|agreed)",
    "const ACK_PREFIX_RE   = /^(ok|yeah|yes|no|sure|good|great|alright|perfect|right|cool|nice|got it)",
    "const SHORT_ACK       = 8",
    "traceback|error:|exception:|nameerror|typeerror|assertionerror",
    "^(where is|what is|what are|what was|whats|did you|do we|do i|does the|does it|how do|how many|can you show|rename it|it wasn.t)",
  ];
  return expect.every(s => js.includes(s));
}

// ── Load window ─────────────────────────────────────────────────────────────
function loadPrompts(days) {
  if (!fs.existsSync(CLAUDE_HISTORY)) {
    return { available: false, reason: `not found: ${CLAUDE_HISTORY}` };
  }
  const since = Date.now() - days * 86_400_000;
  const rows = [];
  for (const line of fs.readFileSync(CLAUDE_HISTORY, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (!rec.timestamp || rec.timestamp < since) continue;
    const text = (rec.display || "").trim();
    if (!text) continue;
    rows.push({
      ts: rec.timestamp,
      session: rec.sessionId || "unknown",
      project: path.basename(rec.project || "unknown"),
      text,
    });
  }
  return { available: true, rows };
}

function tally(rows) {
  const c = { empty: 0, continuation: 0, low: 0, medium: 0, high: 0 };
  for (const r of rows) c[classify(r.text)]++;
  const total = rows.length;
  const haikuEligible = c.continuation + c.low;
  return { total, counts: c, haikuEligible, haikuPct: total ? haikuEligible / total : 0 };
}

// ── Red-team probes ─────────────────────────────────────────────────────────

// Probe 2: "no, …" / "yes, …" with >8 words — false continuations.
const FALSE_CONT_PREFIX = /^(no|yes|ok|sure),\s+/i;
function probeFalseContinuations(rows) {
  const hits = [];
  for (const r of rows) {
    if (classify(r.text) !== "continuation") continue;
    const wc = r.text.split(/\s+/).length;
    if (wc <= 8) continue;
    if (FALSE_CONT_PREFIX.test(r.text)) {
      hits.push({ text: r.text.slice(0, 100), wc });
    }
  }
  return hits;
}

// Probe 3: short imperatives classified continuation — likely Sonnet-needed work.
const IMPERATIVE_HINT = /\b(fix|add|remove|rename|delete|build|run|check|test|commit|merge|revert|rollback|deploy|patch)\b/i;
const CODE_HINT       = /```|\.py\b|\.js\b|\.ts\b|\.go\b|\.rs\b|\.sh\b|\.md\b|\.json\b|\.sql\b/;
function probeShortSubstantive(rows) {
  const hits = [];
  for (const r of rows) {
    if (classify(r.text) !== "continuation") continue;
    const wc = r.text.split(/\s+/).length;
    if (wc < 5 || wc > 8) continue;
    if (IMPERATIVE_HINT.test(r.text) || CODE_HINT.test(r.text)) {
      hits.push({ text: r.text.slice(0, 100), wc });
    }
  }
  return hits;
}

// ── Stability ───────────────────────────────────────────────────────────────
function stabilityCheck(rows) {
  const a = JSON.stringify(tally(rows));
  const b = JSON.stringify(tally(rows));
  return a === b;
}

// ── Version pin ─────────────────────────────────────────────────────────────
function sha256File(p) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16); }
  catch (_) { return null; }
}
function gitHead() {
  try { return execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); }
  catch (_) { return "unknown"; }
}
function versionPin() {
  let historyStat = null;
  try {
    const s = fs.statSync(CLAUDE_HISTORY);
    historyStat = { bytes: s.size, mtime: s.mtime.toISOString() };
  } catch (_) {}
  return {
    git_head: gitHead(),
    audit_js_sha256_16: sha256File(AUDIT_JS),
    spec_md_sha256_16:  sha256File(SPEC_MD),
    history_file: historyStat,
    classifier_drift: liveClassifierMatchesFrozen(),
    utc: new Date().toISOString(),
  };
}

// ── Sample draw (deterministic) ─────────────────────────────────────────────
function seededPick(rows, n, seed = 42) {
  // Deterministic: sort by sha256(seed|idx|text)[:8], take first n.
  const scored = rows.map((r, i) => {
    const h = crypto.createHash("sha256")
      .update(`${seed}|${i}|${r.text}`).digest("hex").slice(0, 8);
    return { r, h };
  });
  scored.sort((a, b) => a.h.localeCompare(b.h));
  return scored.slice(0, n).map(x => x.r);
}

function ensureSample(rows, days) {
  if (!fs.existsSync(SAMPLE_DIR)) fs.mkdirSync(SAMPLE_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(SAMPLE_DIR, `sample_${date}_${days}d.jsonl`);
  if (fs.existsSync(file)) return { file, created: false };
  const pick = seededPick(rows, 50);
  const lines = pick.map(r => JSON.stringify({
    ts: r.ts,
    session: r.session,
    project: r.project,
    text: r.text,
    classifier_label: classify(r.text),
    human_label: null,
    notes: "",
  }));
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { file, created: true };
}

// ── Label agreement (if labels exist) ───────────────────────────────────────
function classifierAgreement() {
  if (!fs.existsSync(LABELS_FILE)) return null;
  const rows = fs.readFileSync(LABELS_FILE, "utf8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(r => r && r.human_label);
  if (rows.length < 30) return { insufficient: true, count: rows.length };

  const classes = ["empty", "continuation", "low", "medium", "high"];
  const perClass = {};
  for (const c of classes) {
    const tp = rows.filter(r => r.classifier_label === c && r.human_label === c).length;
    const fp = rows.filter(r => r.classifier_label === c && r.human_label !== c).length;
    const fn = rows.filter(r => r.classifier_label !== c && r.human_label === c).length;
    const precision = (tp + fp) ? tp / (tp + fp) : null;
    const recall    = (tp + fn) ? tp / (tp + fn) : null;
    perClass[c] = { tp, fp, fn, precision, recall };
  }
  const correct = rows.filter(r => r.classifier_label === r.human_label).length;
  return { count: rows.length, overall: correct / rows.length, perClass };
}

// ── Verdict ─────────────────────────────────────────────────────────────────
function computeVerdict(report) {
  const blockers = [];
  if (!report.available) blockers.push(`data unavailable: ${report.reason}`);
  if (report.available && !report.stable) blockers.push("stability check failed");
  if (!report.version.classifier_drift) blockers.push("classifier drifted from frozen spec");
  if (!report.agreement) blockers.push("no hand-labels");
  else if (report.agreement.insufficient) blockers.push(`<30 hand-labels (${report.agreement.count})`);
  else if (report.agreement.overall < 0.85) blockers.push(`overall agreement ${(report.agreement.overall * 100).toFixed(1)}% < 85%`);
  return { ok_to_cite: blockers.length === 0, blockers };
}

// ── Report ──────────────────────────────────────────────────────────────────
function renderMd(report) {
  const L = [];
  L.push(`# Entient Spend — Numbers Audit`);
  L.push(``);
  L.push(`UTC: ${report.version.utc}`);
  L.push(`Window: last ${report.window_days} days`);
  L.push(``);
  L.push(`## Version pin`);
  L.push(`- git HEAD: ${report.version.git_head}`);
  L.push(`- audit.js sha256:16: ${report.version.audit_js_sha256_16}`);
  L.push(`- AUDIT_SPEC.md sha256:16: ${report.version.spec_md_sha256_16}`);
  L.push(`- history.jsonl: ${report.version.history_file ? `${report.version.history_file.bytes} bytes, mtime ${report.version.history_file.mtime}` : "missing"}`);
  L.push(`- frozen classifier matches live audit.js: **${report.version.classifier_drift ? "YES" : "NO — FIX BEFORE CITING"}**`);
  L.push(``);
  if (!report.available) {
    L.push(`## Data`);
    L.push(`**unavailable**: ${report.reason}`);
    return L.join("\n");
  }
  const t = report.tally;
  L.push(`## Raw count`);
  L.push(`- prompts in window: **${t.total}**`);
  L.push(`- empty: ${t.counts.empty}`);
  L.push(`- continuation: ${t.counts.continuation}`);
  L.push(`- low: ${t.counts.low}`);
  L.push(`- medium: ${t.counts.medium}`);
  L.push(`- high: ${t.counts.high}`);
  L.push(`- Haiku-eligible (continuation + low): **${t.haikuEligible}** (${(t.haikuPct * 100).toFixed(1)}%)`);
  L.push(``);
  L.push(`## Stability`);
  L.push(`- two-run identical: ${report.stable ? "PASS" : "**FAIL**"}`);
  L.push(``);
  L.push(`## Fragility probes (lower bounds on classifier error)`);
  L.push(`- false-continuation "no,…"/"yes,…"/"ok,…"/"sure,…" >8 words: **${report.probes.falseContinuations.length}** instances`);
  if (report.probes.falseContinuations.length) {
    for (const h of report.probes.falseContinuations.slice(0, 5)) L.push(`    - (${h.wc}w) ${h.text}`);
  }
  L.push(`- short (5-8w) imperatives classified continuation: **${report.probes.shortSubstantive.length}** instances`);
  if (report.probes.shortSubstantive.length) {
    for (const h of report.probes.shortSubstantive.slice(0, 5)) L.push(`    - (${h.wc}w) ${h.text}`);
  }
  const floor = report.probes.falseContinuations.length + report.probes.shortSubstantive.length;
  if (t.total) {
    L.push(``);
    L.push(`Lower-bound classifier-error floor on continuation class: **≥ ${floor} / ${t.counts.continuation}** (${(floor / Math.max(1, t.counts.continuation) * 100).toFixed(1)}% of class).`);
  }
  L.push(``);
  L.push(`## Classifier agreement`);
  if (!report.agreement) {
    L.push(`No labels found at \`audit/labels.jsonl\`.`);
    L.push(`Sample drawn: \`${report.sample.file}\`${report.sample.created ? " (new)" : " (reused)"}`);
    L.push(`Hand-label this file, copy into \`audit/labels.jsonl\`, re-run. Target ≥30 labels.`);
  } else if (report.agreement.insufficient) {
    L.push(`Only ${report.agreement.count} labeled rows — need ≥30 for useful agreement.`);
  } else {
    L.push(`Labeled rows: ${report.agreement.count}`);
    L.push(`Overall agreement: **${(report.agreement.overall * 100).toFixed(1)}%**`);
    L.push(``);
    L.push(`| class | tp | fp | fn | precision | recall |`);
    L.push(`|---|---|---|---|---|---|`);
    for (const [k, v] of Object.entries(report.agreement.perClass)) {
      const p = v.precision == null ? "—" : (v.precision * 100).toFixed(0) + "%";
      const r = v.recall    == null ? "—" : (v.recall    * 100).toFixed(0) + "%";
      L.push(`| ${k} | ${v.tp} | ${v.fp} | ${v.fn} | ${p} | ${r} |`);
    }
  }
  L.push(``);
  L.push(`## Publishing verdict`);
  L.push(report.verdict.ok_to_cite
    ? `**OK to cite** the Haiku-eligible figure with the Claude-Max caveat.`
    : `**DO NOT cite** the Haiku-eligible figure in public positioning yet. Blockers:`);
  for (const b of report.verdict.blockers) L.push(`- ${b}`);
  L.push(``);
  L.push(`Caveat required with any Claude-Max number:`);
  L.push(`> On Claude Max (flat-rate subscription), these figures are capacity-equivalent waste, not directly billed cash. For API-billed agent operators running the same workload, the same pattern becomes real spend at the provider's per-token rate.`);
  return L.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  const version = versionPin();
  const load    = loadPrompts(DAYS);

  const report = {
    window_days: DAYS,
    version,
    available: load.available,
    reason: load.reason,
  };

  if (load.available) {
    report.tally   = tally(load.rows);
    report.stable  = stabilityCheck(load.rows);
    report.probes  = {
      falseContinuations: probeFalseContinuations(load.rows),
      shortSubstantive:   probeShortSubstantive(load.rows),
    };
    report.sample    = ensureSample(load.rows, DAYS);
    report.agreement = classifierAgreement();
  }
  report.verdict = computeVerdict(report);

  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const snapDate = version.utc.slice(0, 10);
  const snapFile = path.join(SNAPSHOT_DIR, `audit_${snapDate}_${DAYS}d.json`);
  fs.writeFileSync(snapFile, JSON.stringify(report, null, 2));

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderMd(report) + "\n");
    process.stdout.write(`\nSnapshot written: ${snapFile}\n`);
  }
}

main();
