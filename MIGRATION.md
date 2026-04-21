# Migration — `claude-audit` → `@entient/gateway` → `@entient/spend`

This package has been renamed twice. Here is the full history.

## Timeline

| Date | npm name | Binary | Config dir | Status |
|---|---|---|---|---|
| Pre-2026-04-15 | `claude-audit` | `claude-audit` | `~/.claude-audit/` | historical |
| 2026-04-15 to 2026-04-21 | `@entient/gateway` (local only — never published) | `entient-gateway` | `~/.entient-gateway/` | rolled back |
| 2026-04-21 → | `@entient/spend` | `entient-spend` | `~/.entient-spend/` | **current** |

## Why the second rename

The 2026-04-15 rename to `@entient/gateway` / Entient Gateway Runtime took a name reserved for a different product — the Entient Gateway primitive (a compute-collapse proxy with signed receipts, implemented at `entient/entient/gateway/server.py`). See `Agent/ARCHITECTURE_PRIMITIVES.md` for the full architecture.

The current tool's actual function is AI spend reconciliation (cross-referencing Anthropic billing exports against local metering, paired with the Token Slasher Chrome extension). That's what "Spend" names honestly.

`@entient/gateway` was never published to npm under this tool's identity, so no one is upgrading *from* `@entient/gateway`. The `@entient/gateway` namespace is now held by a placeholder reserving the name for the actual Gateway primitive.

## Upgrading from `claude-audit`

```bash
claude-audit uninstall          # remove old hooks from ~/.claude/settings.json
npm uninstall -g claude-audit   # remove old binary
npm install -g @entient/spend
entient-spend install           # install the new hooks (optional)
```

Old state in `~/.claude-audit/` is left on disk. You can delete it manually; the new runtime reads only from `~/.entient-spend/`.

## Upgrading from local `@entient/gateway` installs

If you installed an unreleased pre-2026-04-21 build from source (the package was never published to the registry):

```bash
entient-gateway uninstall       # remove old hooks, if installed
npm uninstall -g @entient/gateway
npm install -g @entient/spend
entient-spend install
```

State in `~/.entient-gateway/` can be deleted; new state lives in `~/.entient-spend/`.

## What did NOT change

- **Token Slasher export filename** is still `claude-audit-billing.json`. That filename is a contract with the Token Slasher Chrome extension; it will be renamed in a coordinated release across both repos.

## What changed in the 2026-04-21 rename

| Before | After |
|---|---|
| `@entient/gateway` (npm, local-only) | `@entient/spend` |
| `entient-gateway` (binary) | `entient-spend` |
| `~/.entient-gateway/` (config + state dir) | `~/.entient-spend/` |
| `ENTIENT_GATEWAY_SKIP=1` (env escape hatch) | `ENTIENT_SPEND_SKIP=1` |
| GATE_SPACE `claude_audit` (internal ExecutionGate space) | `entient_spend` |
| Disk folder `entient-gateway/` | `entient-spend/` |
| GitHub remote `github.com/Entient/gateway` | unchanged (will rename in a later coordinated cut) |
