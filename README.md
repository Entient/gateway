# entient-gateway

**See which prompts didn't need the model you paid for.**

Most Claude Code quota is spent on the wrong model. `claude-audit` classifies every prompt in your sessions, tells you how many actually needed Sonnet or Opus, and blocks sessions before they bloat past 5x baseline waste. Your context is saved across compactions and injected back on the next start.

```
Your prompts, last 7 days:

  complex   (needed the model)       ████████░░░░░░░░░░░░░░░░░░░░░░  27%
  medium    (ambiguous)              █████░░░░░░░░░░░░░░░░░░░░░░░░░  15%
  simple    (Haiku would do)         ████████████░░░░░░░░░░░░░░░░░░  40%
  "ok" / "continue" / "go"           █████░░░░░░░░░░░░░░░░░░░░░░░░░  18%

  73% ran on the model you picked, but didn't need it.
```

```
npm install -g claude-audit
claude-audit install
```

Requires Node.js 16+. Works with Claude Code CLI, VS Code extension, JetBrains extension. Does **not** work with Claude Code on the web.

---

## What it does

### 1. Enforcement hooks (automatic, after `install`)

| Hook | Event | Action |
|------|-------|--------|
| `--hook prompt` | UserPromptSubmit | Measures waste factor (current tokens / baseline). Blocks if ≥ 5x. |
| `--hook tool` | PostToolUse | Exits with code 2 to stop autonomous work on runaway sessions. |
| `--hook compact` | PreCompact | Saves project + git state + file list to `~/.claude-audit/last-session.md`. |
| `--hook start` | SessionStart | Injects saved context if < 48 hours old — continues where you left off. |

### 2. Waste report (no hooks needed)

```
claude-audit             # last 7 days
claude-audit --last 30d
claude-audit --json      # machine-readable
```

Shows:
- Per-session token counts and waste factors
- Complexity tier breakdown (simple / medium / complex)
- Model recommendations (when you ran Sonnet on a two-line task)
- Sessions that needed compaction

---

## Install

```bash
npm install -g claude-audit
claude-audit install    # adds 4 hooks to ~/.claude/settings.json
claude-audit status     # verify installation
```

**Safe with existing hooks** — `install` appends to your hook list without overwriting ENTIENT, clauditor, or any other hooks you have.

```bash
claude-audit uninstall  # removes only claude-audit hooks
```

---

## All commands

| Command | What it does |
|---|---|
| `claude-audit` | Interactive dashboard (prompt mix + daily spend + worst sessions) |
| `claude-audit hud` | Live 2s-refresh HUD — inferences deferred, tokens saved, $ saved (requires ENTIENT gateway) |
| `claude-audit --last 30d` | Plain-text waste report for the window |
| `claude-audit --json` | Machine-readable report |
| `claude-audit --report` | Writes a standalone HTML report |
| `claude-audit install` | Register 4 hooks in `~/.claude/settings.json` |
| `claude-audit install --shadow` | Register hooks in observe-only mode — logs, never blocks |
| `claude-audit install-autorestart` | Set up `claude-loop.ps1` to auto-rotate sessions (Windows) |
| `claude-audit uninstall` | Remove claude-audit hooks (leaves other tools alone) |
| `claude-audit status` | Hook install state + current session waste factor |
| `claude-audit shadow-report` | Summary of shadow-mode events |
| `claude-audit doctor` | Scan for Claude Code versions with known cache bugs (2.1.69–2.1.89) |
| `claude-audit setup` | Store Anthropic API key for real billing reconciliation |
| `claude-audit billing [--last 30d]` | Fetch real daily charges from Anthropic `/v1/usage` |
| `claude-audit reconcile <export-file>` | Cross-reference a Token Slasher export against local metering |
| `claude-audit redundancy [session-file]` | Walk tool-use blocks, hit the ExecutionGate, report redundant calls |
| `claude-audit gate-stats` | JSON dump of ExecutionGate (`claude_audit` space) stats |

Hook modes are invoked by Claude Code, not by humans:

| Hook flag | Fires on | Effect |
|---|---|---|
| `claude-audit --hook prompt` | `UserPromptSubmit` | Block if waste factor ≥ threshold |
| `claude-audit --hook tool` | `PostToolUse` | Stop autonomous work on runaway sessions |
| `claude-audit --hook compact` | `PreCompact` | Save session state to `~/.claude-audit/last-session.md` |
| `claude-audit --hook start` | `SessionStart` | Inject saved context if < 48h old |

---

## Configuration

`~/.claude-audit/config.json` (auto-created):

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

**Escape hatch:** `CLAUDE_AUDIT_SKIP=1` disables blocking for a single session.

---

## How waste factor works

Waste factor = average tokens/turn in the last N turns ÷ average tokens/turn in the first N turns.

A session starts lean (low baseline). As context bloats, each turn costs more tokens just to carry the history. A factor of 10x means your current turns cost 10x what they did at the start — most of that is dead context.

---

## Context preservation

Before Claude compacts your session, `claude-audit` saves:

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

## Works alongside ENTIENT

If you use [ENTIENT](https://entient.ai) for operator deflection and spend accountability, `claude-audit install` coexists safely — both hook sets fire in sequence.

---

## License

MIT
