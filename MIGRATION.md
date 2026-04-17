# Migration — `claude-audit` → `@entient/gateway` (Entient Gateway Runtime)

As of this release the package is renamed. This is a hard cut; there is no backwards-compat alias.

## What changed

| Before | After |
|---|---|
| `claude-audit` (npm package) | `@entient/gateway` |
| `claude-audit` (binary) | `entient-gateway` |
| `~/.claude-audit/` (config + state dir) | `~/.entient-gateway/` |
| `CLAUDE_AUDIT_SKIP=1` (env escape hatch) | `ENTIENT_GATEWAY_SKIP=1` |
| `github.com/Entient/claude-audit` | `github.com/Entient/gateway` |

## What did NOT change

- **Internal ExecutionGate space** is still `claude_audit`. That space holds receipt history and is not user-facing; renaming it would orphan prior HIT/MISS evidence for no user benefit.
- **Token Slasher export filename** is still `claude-audit-billing.json`. That filename is a contract with the Token Slasher Chrome extension; it will be renamed in a coordinated release across both repos.

## Upgrading from a prior `claude-audit` install

```bash
claude-audit uninstall          # remove old hooks from ~/.claude/settings.json
npm uninstall -g claude-audit   # remove old binary
npm install -g @entient/gateway
entient-gateway install         # install the new hooks
```

Old state in `~/.claude-audit/` is left on disk. You can delete it manually; the new runtime reads only from `~/.entient-gateway/`.

## Why

`claude-audit` is not a product name — it's one feature surface (waste + audit HUD) inside the larger Entient Gateway product. The new name matches the SKU: Gateway Runtime is what runs on the customer side; Gateway Cloud is the receipts/identity/trust control plane. Collapse is the flagship behavior both halves enforce.
