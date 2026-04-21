# Entient Spend — Numbers Audit Spec

Evergreen audit for any number this runtime reports that might end up in a positioning doc, a sales letter, or a public claim. Run it before citing figures. Run it again after any change to `audit.js`.

```
node audit/run_audit.js
```

## Scope

This audits the Entient Spend's own self-measurement. It does **not** audit the underlying Claude transcripts — those are the ground truth. It audits our classifier's reading of them.

Six questions, in order:

1. **Are metric definitions written down?** — every claim must map to a named, testable definition here.
2. **Does each number trace to raw?** — file path + query + window.
3. **Does the classifier agree with a human on a random sample?** — target ≥85% agreement per class, else the number ships with a caveat or gets withdrawn.
4. **Is anything being double-counted?** — cache-create vs cache-read tokens; overhead-vs-savings buckets.
5. **Is the tool deterministic on fixed input?** — two runs on the same window must produce identical numbers.
6. **Are versions pinned?** — git HEAD + `audit.js` sha256 + input file size/stat snapshot. Numbers without a version pin are unquotable.

## Metric definitions (authoritative)

Any claim that uses these terms must use these exact definitions, or invent a new name and add it here.

### `prompt`
One line in `~/.claude/history.jsonl` where `rec.display` is non-empty and `rec.timestamp` falls in the window. Each user turn in Claude Code creates one such line. Tool calls and model responses are **not** prompts. Retries are counted only if the user resent the prompt (Claude Code writes a new history line).

### `Haiku-eligible`
A prompt whose classifier output is `continuation` or `low`. See classifier definition below. This is **our** classifier's judgment, not Anthropic's routing, not a ground-truth label.

### `ACK / continuation`
A prompt classifier output of `continuation`. Rule (v2, 2026-04-17): strip a leading ACK prefix (`ok`/`yeah`/`yes`/`no`/`sure`/`good`/`great`/`alright`/`perfect`/`right`/`cool`/`nice`/`got it` followed by `[,.:\s]+`), up to twice, then if the remainder has word count ≤ 8 and does not match `HIGH_RE`/`LOW_RE`, classify as `continuation`. **Changed from v1:** matching `CONTINUATION_RE` alone no longer forces `continuation`; long "ok but …" / "good get …" prompts now fall through to `LOW_RE` / `medium`. Residual fragility: the ACK stripper does not follow "so" / "and" / "but" connectives, so `"ok and i need you to..."` has only "ok " stripped — the remaining `"and i need you to..."` still determines class.

### `high complexity`
A prompt classifier output of `high`. Rule: matches `HIGH_RE` (traceback / error: / exception: / triple-backtick / architect / implement / refactor / generate code / write test / update spec). Known fragility: narrow vocabulary. "Debug the race condition" does not match — falls through to continuation if ≤8 words.

### `startup overhead`
Per-session token count attributed to system prompt + tool definitions, as reported by Entient Spend's session parser (`summarizeSession` in `audit.js`). Double-counting risk: Anthropic's cache-create tokens are billed once, cache-read tokens are billed separately at 10% rate. "Startup overhead" as currently implemented counts both.

### `30-day window`
Unix-epoch-ms boundary: `Date.now() - 30 * 86_400_000`. Inclusive of the boundary. Not calendar-aligned.

### `savings`
Not audited here. Any claim of dollar savings must separately justify the counterfactual (what would have been spent under which pricing). On Claude Max the counterfactual is "nothing billed" — flat $200/mo. For API-billed callers the counterfactual is the per-token rate of the configured model.

## Classifier reference

Current implementation (v2, 2026-04-17) — `audit.js` line 1017-1048. Any change to these constants invalidates prior audits.

```
CONTINUATION_RE = /^(proceed|continue|do it|go ahead|yes|no|ok|good|both|all|now do|next|great|sounds|done|sure|right|correct|perfect|got it|makes sense|agreed)\b/i
ACK_PREFIX_RE   = /^(ok|yeah|yes|no|sure|good|great|alright|perfect|right|cool|nice|got it)[,.:\s]+/i
SHORT_ACK       = 8
HIGH_RE         = /traceback|error:|exception:|nameerror|typeerror|assertionerror|```|architect|implement|refactor|generate code|write.*test|update.*spec/i
LOW_RE          = /^(where is|what is|what are|what was|whats|did you|do we|do i|does the|does it|how do|how many|can you show|rename it|it wasn.t)\b/i
LOW_MAX_WORDS   = 15
```

Decision order (v2):
1. `HIGH_RE.test(raw)` → `high`
2. `stripAckPrefix(raw)` → `core` (strip up to 2 ACK prefixes)
3. `LOW_RE.test(core) && word_count(core) ≤ LOW_MAX_WORDS` → `low`
4. `word_count(core) ≤ SHORT_ACK` → `continuation`
5. else → `medium`

## Red-team checks (what `run_audit.js` executes)

1. **Stability** — run classifier twice on same window, assert byte-identical output.
2. **Fragility probe** — scan prompts classified as `continuation` for prefixes `no, ` / `yes, ` / `ok, ` / `sure, ` followed by >8 words. These are false continuations; the count is the lower bound of classifier bleed.
3. **Short-but-substantive probe** — scan prompts classified as `continuation` with word count in [5, 8] and at least one of {verb imperative, file extension, code fence, `fix`, `add`, `remove`}. Lower bound of ACK false-positive rate.
4. **Version pin** — emit git HEAD, `audit.js` sha256, `history.jsonl` size + line count + mtime, and the sha256 of the audit spec itself.
5. **Sample draw** — deterministic (seed=42) sample of N=50 prompts from the window, written to `audit/samples/sample_{utcdate}.jsonl` with classifier output. User hand-labels these in `audit/labels.jsonl`. Next audit run computes agreement.
6. **Classifier agreement** — if `audit/labels.jsonl` exists and covers ≥30 rows, compute per-class precision/recall. Target: ≥85% agreement per class.

## Publishing rule

A number may be cited in public positioning only if:

- It uses a name from the definitions block above.
- The most recent `run_audit.js` output for that window is referenced in the doc (by sha or snapshot file).
- Any class below 85% hand-label agreement either (a) is not cited, (b) is cited with the fragility caveat in-line, or (c) was computed after a classifier fix re-validated agreement.

Sales copy ships behind the audit, not ahead of it.

## Caveat template (required for Claude Max data)

> On Claude Max (flat-rate subscription), the figures below are capacity-equivalent waste, not directly billed cash. For API-billed agent operators running the same workload, the same pattern becomes real spend at the provider's per-token rate.

## Output

`run_audit.js` writes:
- stdout — markdown report
- `audit/snapshots/audit_{utcdate}.json` — machine-readable snapshot
- `audit/samples/sample_{utcdate}.jsonl` — for hand-labeling (only if missing)
