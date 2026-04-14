/**
 * gate_adapter.js — thin Node wrapper around entient_agent.runtime.gate_cli.
 *
 * Contract v1 consumer.  claude-audit uses the SAME ExecutionGate primitive
 * as the Agent hooks; HIT/MISS semantics are defined by that gate, not by
 * this file.  This file is pure adaptation — it spawns Python, passes
 * obligation + context, and parses the JSON verdict back.
 *
 * Own obligation space: "claude_audit" (per contract rule I1 — one space
 * per gate instance, one DB per space).
 *
 * Exports:
 *   obligationForToolUse(toolName, toolInput) -> string
 *   gateCheck(obligation, context) -> { verdict, receipt_coord, ... }
 *   gateRecord(obligation, receipt, context, meta?) -> { ok, coord_id, ... }
 *   gateStats() -> { total, hits, misses, stale, errors, hit_rate }
 */

"use strict";

const crypto = require("crypto");
const { spawnSync } = require("child_process");

const GATE_SPACE = "claude_audit";
const CLI_TIMEOUT_MS = 5000;

/**
 * Resolve a Python interpreter.  Prefers $ENTIENT_PYTHON, then `python`,
 * then `python3`.  Falls back to `python` so subprocess failure surfaces
 * as verdict=ERROR rather than a JS crash.
 */
function resolvePython() {
  return process.env.ENTIENT_PYTHON || "python";
}

/**
 * Build a stable obligation coordinate for a tool use.
 *
 * We canonicalize the input so semantically identical calls produce the
 * same obligation.  This matches the Agent hook's canonicalization
 * philosophy (see intercept_agent.py) — without it, the gate would never
 * HIT on "same call, different whitespace."
 */
function obligationForToolUse(toolName, toolInput) {
  const canonical = canonicalize(toolInput);
  const payload = `${toolName || "unknown"}\x1F${canonical}`;
  return "tool:" + crypto.createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function canonicalize(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return JSON.stringify(v.trim());
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}

function runCli(args) {
  const py = resolvePython();
  const proc = spawnSync(
    py,
    ["-m", "entient_agent.runtime.gate_cli", ...args],
    {
      encoding: "utf8",
      timeout: CLI_TIMEOUT_MS,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    },
  );
  if (proc.error || proc.status !== 0) {
    return {
      _cli_error: true,
      reason: proc.error ? `${proc.error.code || proc.error.name}: ${proc.error.message}`
                         : `exit ${proc.status}: ${(proc.stderr || "").trim()}`,
    };
  }
  try {
    return JSON.parse((proc.stdout || "").trim());
  } catch (exc) {
    return { _cli_error: true, reason: `non-JSON stdout: ${exc.message}` };
  }
}

/**
 * Consult the gate for an obligation + context.
 *
 * Fail-closed to verdict=ERROR when the CLI subprocess fails or times out.
 * Contract I4: ERROR means caller should execute (don't short-circuit on
 * missing evidence).
 */
function gateCheck(obligation, context) {
  const result = runCli([
    "check",
    "--obligation", obligation,
    "--context", context || "",
    "--space", GATE_SPACE,
  ]);
  if (result._cli_error) {
    return {
      verdict: "ERROR",
      obligation_coord: obligation,
      receipt_coord: null,
      context_hash: context || "",
      reason: `gate_cli failure: ${result.reason}`,
      source: "cli_error",
      latency_ms: 0,
    };
  }
  return result;
}

/**
 * Record a receipt after verifiable success (contract I2).
 *
 * claude-audit only records receipts in its own space; it does not
 * pollute the Agent hook's result_store.
 */
function gateRecord(obligation, receipt, context, meta) {
  const args = [
    "record",
    "--obligation", obligation,
    "--receipt", receipt,
    "--context", context || "",
    "--space", GATE_SPACE,
  ];
  if (meta) {
    args.push("--meta", typeof meta === "string" ? meta : JSON.stringify(meta));
  }
  return runCli(args);
}

function gateStats() {
  return runCli(["stats", "--space", GATE_SPACE]);
}

module.exports = {
  GATE_SPACE,
  obligationForToolUse,
  canonicalize,
  gateCheck,
  gateRecord,
  gateStats,
};
