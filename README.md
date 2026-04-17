# Entient Gateway Runtime

**The local half of [Entient Gateway](https://entient.ai). Collapse redundant LLM work. Preserve session context. See what you actually saved.**

Entient Gateway is one product with two halves:

- **Gateway Runtime** (this package) — runs on the customer side. Intercepts Claude Code sessions, blocks runaway waste, saves context across compactions, and surfaces $ saved in a live HUD.
- **Gateway Cloud** — hosted half. Receipts, identity, trust. Turns "I ran it" into "here is the proof."

Collapse is the flagship behavior both halves enforce: *after the first witness, identical or derivable work is resolved by lookup, not execution.*

```
Your prompts, last 7 days:

  complex   (needed the model)       ████████░░░░░░░░░░░░░░░░░░░░░░  27%
  medium    (ambiguous)              █████░░░░░░░░░░░░░░░░░░░░░░░░░  15%
  simple    (Haiku would do)         ████████████░░░░░░░░░░░░░░░░░░  40%
  "ok" / "continue" / "go"           █████░░░░░░░░░░░░░░░░░░░░░░░░░  18%

  73% ran on the model you picked, but didn't need it.
```

```
npm install -g @entient/gateway
entient-gateway install
```

Requires Node.js 16+. Works with Claude Code CLI, VS Code extension, JetBrains extension. Does **not** work with Claude Code on the web.

> Migrating from `claude-audit`? See [MIGRATION.md](./MIGRATION.md).

---

## What it does

### 1. Enforcement hooks (automatic, after `install`)

| Hook | Event | Action |
|------|-------|--------|
| `--hook prompt` | UserPromptSubmit | Measures waste factor (current tokens / baseline). Blocks if ≥ 5x. |
| `--hook tool` | PostToolUse | Exits with code 2 to stop autonomous work on runaway sessions. |
| `--hook compact` | PreCompact | Saves project + git state + file list to `~/.entient-gateway/last-session.md`. |
| `--hook start` | SessionStart | Injects saved context if < 48 hours old — continues where you left off. |

### 2. Waste report (no hooks needed)

```
entient-gateway             # last 7 days
entient-gateway --last 30d
entient-gateway --json      # machine-readable
```

Shows:
- Per-session token counts and waste factors
- Complexity tier breakdown (simple / medium / complex)
- Model recommendations (when you ran Sonnet on a two-line task)
- Sessions that needed compaction

---

## Install

```bash
npm install -g @entient/gateway
entient-gateway install    # adds 4 hooks to ~/.claude/settings.json
entient-gateway status     # verify installation
```

**Safe with existing hooks** — `install` appends to your hook list without overwriting ENTIENT or any other hooks you have.

```bash
entient-gateway uninstall  # removes only entient-gateway hooks
```

---

## All commands

| Command | What it does |
|---|---|
| `entient-gateway` | Interactive dashboard (prompt mix + daily spend + worst sessions) |
| `entient-gateway hud` | Live 2s-refresh HUD — inferences deferred, tokens saved, $ saved (requires Gateway Cloud) |
| `entient-gateway --last 30d` | Plain-text waste report for the window |
| `entient-gateway --json` | Machine-readable report |
| `entient-gateway --report` | Writes a standalone HTML report |
| `entient-gateway install` | Register 4 hooks in `~/.claude/settings.json` |
| `entient-gateway install --shadow` | Register hooks in observe-only mode — logs, never blocks |
| `entient-gateway install-autorestart` | Set up `claude-loop.ps1` to auto-rotate sessions (Windows) |
| `entient-gateway uninstall` | Remove entient-gateway hooks (leaves other tools alone) |
| `entient-gateway status` | Hook install state + current session waste factor |
| `entient-gateway shadow-report` | Summary of shadow-mode events |
| `entient-gateway doctor` | Scan for Claude Code versions with known cache bugs (2.1.69–2.1.89) |
| `entient-gateway setup` | Store Anthropic API key for real billing reconciliation |
| `entient-gateway billing [--last 30d]` | Fetch real daily charges from Anthropic `/v1/usage` |
| `entient-gateway reconcile <export-file>` | Cross-reference a Token Slasher export against local metering |
| `entient-gateway redundancy [session-file]` | Walk tool-use blocks, hit the ExecutionGate, report redundant calls |
| `entient-gateway gate-stats` | JSON dump of ExecutionGate stats |

Hook modes are invoked by Claude Code, not by humans:

| Hook flag | Fires on | Effect |
|---|---|---|
| `entient-gateway --hook prompt` | `UserPromptSubmit` | Block if waste factor ≥ threshold |
| `entient-gateway --hook tool` | `PostToolUse` | Stop autonomous work on runaway sessions |
| `entient-gateway --hook compact` | `PreCompact` | Save session state to `~/.entient-gateway/last-session.md` |
| `entient-gateway --hook start` | `SessionStart` | Inject saved context if < 48h old |

---

## Configuration

`~/.entient-gateway/config.json` (auto-created):

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

| Key | Default | Description |
|-----|---------|-------------|
| `threshold` | `5` | Waste factor that triggers session kill + restart (current avg / baseline avg) |
| `saveThreshold` | `3` | Waste factor that triggers git savepoint + early warning |
| `minTurns` | `15` | Minimum turns before enforcement kicks in |
| `baselineTurns` | `5` | Turns used to establish baseline token cost |
| `windowTurns` | `5` | Recent turns used to compute current token cost |
| `mode` | `"enforce"` | `"enforce"` blocks at threshold. `"shadow"` logs but never blocks (use `install --shadow` for observe-only). |

**Escape hatch:** `ENTIENT_GATEWAY_SKIP=1` disables blocking for a single session.

---

## How waste factor works

Waste factor = average tokens/turn in the last N turns ÷ average tokens/turn in the first N turns.

A session starts lean (low baseline). As context bloats, each turn costs more tokens just to carry the history. A factor of 10x means your current turns cost 10x what they did at the start — most of that is dead context.

---

## Context preservation

Before Claude compacts your session, Gateway Runtime saves:

```markdown
# Session Context — 2026-04-04T12:00:00Z
Project: C:\Users\Brock1\Desktop\Agent
Branch: master (abc1234)

## Modified files
- src/main.py
- README.md

## Session waste
Turns: 47 | Baseline: 1,200 tok/turn | Current: 4,800 tok/turn | Factor: 4.0x
```

On the next session start, this is injected as `additionalContext` — Claude resumes with full awareness of what was happening.

---

## License

MIT
