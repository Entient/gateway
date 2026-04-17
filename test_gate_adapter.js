#!/usr/bin/env node
/**
 * Smoke/unit tests for gate_adapter.js.
 *
 * Runs the live Python CLI against a temp gate space so the Node wrapper
 * is exercised end-to-end (not mocked).  Fails loud on first assertion.
 */

"use strict";

const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const { execSync } = require("child_process");

const ga = require("./gate_adapter.js");

// Use a unique space name per run so we don't collide with prior state.
const TEST_SPACE = "claude_audit_test_" + Date.now();

// Monkey-patch GATE_SPACE for this run by overriding module exports.
// (Export is read-only; we hack the module by re-require after setting env
// — or by calling runCli directly via the adapter's functions, which already
// accept the space internally.  Since the space is module-scoped, we'll
// shell out directly to the CLI for these tests using the same interpreter.)
const PY = process.env.ENTIENT_PYTHON || "python";

function runCli(args) {
  const { spawnSync } = require("child_process");
  const proc = spawnSync(
    PY,
    ["-m", "entient_agent.runtime.gate_cli", ...args, "--space", TEST_SPACE],
    { encoding: "utf8", timeout: 10000 },
  );
  if (proc.status !== 0) {
    throw new Error(`CLI failed rc=${proc.status} err=${proc.stderr} out=${proc.stdout}`);
  }
  return JSON.parse(proc.stdout.trim());
}

// ── Tests ────────────────────────────────────────────────────────────────

function testObligationIsStable() {
  const a = ga.obligationForToolUse("Read", { file_path: "/tmp/x" });
  const b = ga.obligationForToolUse("Read", { file_path: "/tmp/x" });
  assert.strictEqual(a, b, "obligation must be stable for identical input");
  assert(a.startsWith("tool:"), "obligation must be namespaced");
  console.log("  ok: obligationForToolUse is stable");
}

function testObligationDiffersOnInput() {
  const a = ga.obligationForToolUse("Read", { file_path: "/tmp/x" });
  const b = ga.obligationForToolUse("Read", { file_path: "/tmp/y" });
  assert.notStrictEqual(a, b, "different input must differ");
  const c = ga.obligationForToolUse("Write", { file_path: "/tmp/x" });
  assert.notStrictEqual(a, c, "different tool must differ");
  console.log("  ok: obligationForToolUse differs by input and tool");
}

function testCanonicalizationIgnoresKeyOrder() {
  const a = ga.obligationForToolUse("T", { a: 1, b: 2 });
  const b = ga.obligationForToolUse("T", { b: 2, a: 1 });
  assert.strictEqual(a, b, "key order must not affect canonicalization");
  console.log("  ok: canonicalize is key-order-independent");
}

function testCanonicalizationTrimsStrings() {
  const a = ga.canonicalize("  hello  ");
  const b = ga.canonicalize("hello");
  assert.strictEqual(a, b, "strings must be trimmed");
  console.log("  ok: canonicalize trims strings");
}

function testCliMissThenHit() {
  // Direct CLI round-trip at the TEST_SPACE so we don't touch the live claude_audit space.
  const miss = runCli(["check", "--obligation", "ob:x", "--context", "ctxA"]);
  assert.strictEqual(miss.verdict, "MISS", `expected MISS got ${JSON.stringify(miss)}`);

  const rec = runCli(["record", "--obligation", "ob:x",
                      "--receipt", "rc:x", "--context", "ctxA"]);
  assert.strictEqual(rec.ok, true);

  const hit = runCli(["check", "--obligation", "ob:x", "--context", "ctxA"]);
  assert.strictEqual(hit.verdict, "HIT");
  console.log("  ok: CLI MISS -> record -> HIT round-trips");
}

function testCliContextScoping() {
  runCli(["record", "--obligation", "ob:ctx",
          "--receipt", "rc:a", "--context", "ctxA"]);
  const other = runCli(["check", "--obligation", "ob:ctx", "--context", "ctxB"]);
  assert.strictEqual(other.verdict, "MISS",
    `different context must MISS: ${JSON.stringify(other)}`);
  console.log("  ok: CLI enforces context scoping (contract I5)");
}

function testGateCheckFailsClosedOnBadPython() {
  // Temporarily force a bogus interpreter — verdict must be ERROR, not HIT.
  const prev = process.env.ENTIENT_PYTHON;
  process.env.ENTIENT_PYTHON = "definitely_not_a_real_python_xyz";
  try {
    // Clear require cache so the adapter picks up the new env on its own
    // fallback — actually adapter reads env lazily via resolvePython, so
    // we only need to invoke.
    const r = ga.gateCheck("ob:failclosed", "ctx");
    assert.strictEqual(r.verdict, "ERROR",
      `bad interpreter must produce ERROR, got ${JSON.stringify(r)}`);
    console.log("  ok: gateCheck fails closed to ERROR when CLI unreachable");
  } finally {
    if (prev === undefined) delete process.env.ENTIENT_PYTHON;
    else process.env.ENTIENT_PYTHON = prev;
  }
}

function testVerdictVocabularyFrozen() {
  const allowed = new Set(["HIT", "MISS", "STALE", "ERROR"]);
  for (const ctx of ["", "ctxA", "a".repeat(200)]) {
    const r = runCli(["check", "--obligation", "ob:voc", "--context", ctx]);
    assert(allowed.has(r.verdict), `unexpected verdict: ${r.verdict}`);
  }
  console.log("  ok: verdict vocabulary is contract-frozen");
}

function cleanup() {
  try {
    const dbPath = path.join(os.homedir(), ".entient", "v2", "gates", `${TEST_SPACE}.db`);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  } catch (_) {}
}

function main() {
  console.log(`[test_gate_adapter] using space=${TEST_SPACE}`);
  let passed = 0, failed = 0;
  const tests = [
    testObligationIsStable,
    testObligationDiffersOnInput,
    testCanonicalizationIgnoresKeyOrder,
    testCanonicalizationTrimsStrings,
    testCliMissThenHit,
    testCliContextScoping,
    testGateCheckFailsClosedOnBadPython,
    testVerdictVocabularyFrozen,
  ];
  for (const t of tests) {
    try {
      t();
      passed += 1;
    } catch (exc) {
      console.error(`  FAIL: ${t.name}: ${exc.message}`);
      failed += 1;
    }
  }
  cleanup();
  console.log(`\n${passed}/${passed + failed} tests passed`);
  process.exit(failed ? 1 : 0);
}

main();
