# Entient Gateway Runtime — Billing Reconciliation Plan

## WHERE TO FIND THIS
- This file: `C:\Users\Brock1\Desktop\entient-gateway\BILLING_RECONCILIATION_PLAN.md`
- Memory doc: `~/.claude/projects/C--Users-Brock1-Desktop-Agent/memory/project_claude_audit.md`
- Token Slasher extension: `C:\Users\Brock1\Desktop\token-slasher-extension\`
- Gateway Runtime tool: `C:\Users\Brock1\Desktop\entient-gateway\audit.js`

---

## What We Know About Billing

**Two completely separate billing streams:**

| Stream | What it covers | How charged |
|--------|---------------|-------------|
| Claude Max subscription | Claude.ai + Claude Code interactive sessions | $200/mo flat — no per-token charges ever |
| API overages | Any call made with sk-ant-... API key | Per token, billed when accumulated use crosses ~$15 threshold |

**The $15–16 email receipts are 100% from API key calls, not Claude Code.**

**API callers in this system (April 2026 audit):**
- ENTIENT gateway port 8877 — MCP tool calls → logged to `~/.entient/v2/metering.db`
- `entient-interceptor/tools/label_forwards.py` — Haiku batch labeling → NOT logged
- `entient-interceptor/tools/bulk_synthesize.py` — operator synthesis → NOT logged
- `entient-interceptor/tools/operator_mill.py` — synthesis loop → NOT logged
- `entient-interceptor/tools/haiku_router.py` — routing tests → NOT logged
- `entient-interceptor/tools/label_worker.py` — labeling worker → NOT logged
- `entient-interceptor/tools/operator_synthesizer.py` → NOT logged
- `entient_interceptor/intent_sidecar.py` — logged to `~/.entient/v2/sidecar_telemetry.jsonl` only

**30-day numbers (March–April 2026):**
- ENTIENT gateway: 14,041 requests, 21% deflected, $60.85 metered
- Of that: $59.69 from MCP tool calls, $0.69 from Haiku
- Untracked (labeling, synthesis): est. $2–5/month
- Total overages received: $15.16 + $15.20 + $15.74 = $46.10 (sample — more exist)

---

## The Full Solution (3 parts, all exist or need minor additions)

### Part 1 — Token Slasher (ALREADY BUILT + INSTALLED)

**Repo:** `C:\Users\Brock1\Desktop\token-slasher-extension\`

Token Slasher v2.2.0 is already:
- Installed as a Chrome extension (unpacked)
- Targeting `console.anthropic.com/settings/billing` and `/settings/usage`
- Scraping spend, tokens, requests on every visit
- Storing 90-day history in `chrome.storage.local`

**What's missing:** An export button.

**Fix needed (popup.js):** Add "Export to entient-gateway" button that writes
`chrome.storage.local` history to a file the user can save. Token Slasher
already has the data — it just needs a way out.

When user clicks export:
1. Reads all history from `chrome.storage.local`
2. Structures as JSON with invoices + daily usage
3. User saves file as `claude-audit-billing.json` to their home folder

### Part 2 — entient-gateway reconcile command (TO BUILD)

`node audit.js reconcile` reads `~/claude-audit-billing.json` (from Token Slasher export)
and cross-references with `metering.db` + session files.

Output: Every invoice explained. Which day, which tool, which project caused it.

```
Invoice $15.74  Mar 24
  API usage that day: 4.2M tokens
  → ENTIENT gateway MCP: 3.1M tok  Agent project  2:31pm–4:47pm
  → label_forwards.py:  1.1M tok  (untracked — estimated)
  Triggered when running total crossed $30 threshold
```

### Part 3 — Instrument untracked API callers (TO BUILD)

Add `_log_to_metering(model, input_tok, output_tok, tool_name)` to the 9 tools
that call the API directly without going through the gateway. Write to metering.db.

Once done: every dollar is visible. No more mystery charges.

---

## Next Steps (in order)

1. **Add export button to Token Slasher popup**
   - File: `C:\Users\Brock1\Desktop\token-slasher-extension\popup.js`
   - Add button that dumps `chrome.storage.local[ts_history]` to downloadable JSON
   - Reload extension in Chrome (chrome://extensions → reload)

2. **Add `reconcile` command to entient-gateway**
   - File: `C:\Users\Brock1\Desktop\entient-gateway\audit.js`
   - Reads `~/claude-audit-billing.json`
   - Cross-refs with `~/.entient/v2/metering.db`
   - Outputs per-invoice breakdown

3. **Instrument the 9 untracked callers in entient-interceptor/tools/**
   - Add metering wrapper to each
   - After this: zero blind spots

---

## Quick Queries

```bash
# All API spend logged to metering.db by day
python3 -c "
import sqlite3, os
db = os.path.expanduser('~/.entient/v2/metering.db')
conn = sqlite3.connect(db)
for r in conn.execute('''
    SELECT DATE(timestamp_utc), COUNT(*), SUM(total_tokens), SUM(cost_usd)
    FROM usage WHERE cached=0
    GROUP BY DATE(timestamp_utc) ORDER BY 1 DESC LIMIT 30
''').fetchall():
    print(f'{r[0]}  {r[1]:>6} calls  \${r[3]:.4f}')
"
```

```bash
# Spend by tool/model
python3 -c "
import sqlite3, os
db = os.path.expanduser('~/.entient/v2/metering.db')
conn = sqlite3.connect(db)
for r in conn.execute('''
    SELECT model, COUNT(*), SUM(total_tokens), SUM(cost_usd)
    FROM usage WHERE cached=0
    GROUP BY model ORDER BY SUM(cost_usd) DESC
''').fetchall():
    print(f'{str(r[0]):<30} {r[1]:>6} calls  \${r[3]:.4f}')
"
```
