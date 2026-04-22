# Entient Spend

**AI spend reconciliation. Turn opaque invoice totals into an itemized bill: which tool, which project, which day.**

Entient Spend pairs with the [entient-spend Chrome extension](https://github.com/Entient/token-slasher) (formerly Token Slasher) to cross-reference your Anthropic billing exports against your local API metering. Every $15 overage email becomes auditable.

It also ships a set of optional enforcement hooks for Claude Code that cap runaway-waste sessions and preserve context across compactions — but the headline feature is reconciliation.

> **Naming:** Entient Spend is **not** the Entient Gateway. Gateway is a separate product surface (compute-collapse proxy with signed receipts) reserved under `@entient/gateway`. Spend reads from Gateway's metering data but does not stand in for it.

---

## Install

```bash
npm install -g @entient/spend
entient-spend install    # optional: register Claude Code hooks
```

Requires Node.js 16+.

---

## What it does

### 1. Reconcile billing against local metering

```
entient-spend setup                          # store your Anthropic API key
entient-spend billing --last 30d             # fetch real daily charges
entient-spend reconcile ~/claude-audit-billing.json
```

Output: every invoice explained.

```
Invoice $15.74  Mar 24
  API usage that day: 4.2M tokens
  → ENTIENT gateway MCP: 3.1M tok  Agent project  2:31pm–4:47pm
  → label_forwards.py:  1.1M tok  (untracked — estimated)
  Triggered when running total crossed $30 threshold
```

### 2. Waste report (session-level diagnostics)

```
entient-spend                 # last 7 days
entient-spend --last 30d
entient-spend --json          # machine-readable
```

Shows per-session token counts, waste factors, complexity tiers, and model recommendations.

### 3. Optional enforcement hooks (Claude Code)

```
entient-spend install                        # adds 4 hooks to ~/.claude/settings.json
entient-spend install --shadow               # observe-only — logs, never blocks
entient-spend uninstall                      # removes only entient-spend hooks
```

| Hook | Event | Action |
|------|-------|--------|
| `--hook prompt` | UserPromptSubmit | Measures waste factor (current / baseline). Blocks at threshold. |
| `--hook tool` | PostToolUse | Exits on runaway sessions. |
| `--hook compact` | PreCompact | Saves project + git state to `~/.entient-spend/last-session.md`. |
| `--hook start` | SessionStart | Injects saved context if < 48h old. |

---

## All commands

| Command | What it does |
|---|---|
| `entient-spend` | Interactive dashboard (prompt mix + daily spend + worst sessions) |
| `entient-spend hud` | Live 2s-refresh HUD — inferences deferred, tokens saved, $ saved (requires ENTIENT Gateway running) |
| `entient-spend --last 30d` | Plain-text waste report for the window |
| `entient-spend --json` | Machine-readable report |
| `entient-spend --report` | Writes a standalone HTML report |
| `entient-spend install` | Register 4 hooks in `~/.claude/settings.json` |
| `entient-spend install --shadow` | Register hooks in observe-only mode |
| `entient-spend install-autorestart` | Set up auto-rotate sessions (Windows) |
| `entient-spend uninstall` | Remove entient-spend hooks |
| `entient-spend status` | Hook install state + current session waste factor |
| `entient-spend shadow-report` | Summary of shadow-mode events |
| `entient-spend doctor` | Scan for Claude Code versions with known cache bugs |
| `entient-spend setup` | Store Anthropic API key for real billing reconciliation |
| `entient-spend billing [--last 30d]` | Fetch real daily charges from Anthropic `/v1/usage` |
| `entient-spend reconcile <export-file>` | Cross-reference an entient-spend extension export against local metering |
| `entient-spend redundancy [session-file]` | Walk tool-use blocks, hit the ExecutionGate, report redundant calls |
| `entient-spend gate-stats` | JSON dump of ExecutionGate stats |

---

## Configuration

`~/.entient-spend/config.json` (auto-created):

```json
{
  "threshold": 5,
  "saveThreshold": 3,
  "minTurns": 15,
  "baselineTurns": 5,
  "windowTurns": 5,
  "mode": "enforce"
}
```

**Escape hatch:** `ENTIENT_SPEND_SKIP=1` disables blocking for a single session.

---

## Migrating from `claude-audit` or `@entient/gateway`

See [MIGRATION.md](./MIGRATION.md).

---

## License

MIT
