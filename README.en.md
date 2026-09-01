# dsh-compat-guard

[中文文档](README.md)

A compatibility guard plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that repairs three frequent failure modes when driving DSH with non-DeepSeek models (GPT, Qwen-thinking, self-hosted reasoning models, ...). Zero-config out of the box; every fix can be toggled in `~/.dsh/compat-guard.json`.

## 1. Reasoning-model auto-compaction failure

**Symptom**: `summarization truncated at the token cap (incomplete checkpoint)` — compaction aborts on every attempt
(upstream [Discussion #3465](https://github.com/deepseek-ai/deepseek-harness/discussions/3465)).

**Root cause**: `dsh-compaction-basic` summarizes with a hard `maxTokens` cap (default 8192) and fails closed when the
summary hits it. Reasoning models spend invisible thinking tokens inside that same output budget, so any model that
thinks heavily truncates and compaction aborts.

**Fix**: intercepts `purpose === "compaction"` LLM requests on the `llm/stream` waterfall and

- raises `maxTokens` to 32768 (configurable, clamped to the model's declared cap when known);
- drops the reasoning effort to the cheapest level the model supports (prefer `off` > `minimal` > `low`);
- never forces an effort on models without reasoning support (avoids `UNSUPPORTED_REASONING_EFFORT`).

## 2. Doomed sandbox-escalation requests fail-closing tool calls

**Symptom** (upstream [Discussion #3877](https://github.com/deepseek-ai/deepseek-harness/discussions/3877)):

```text
Error: sandbox escalation to "danger-full-access" is not strictly wider than this call's current "danger-full-access" mode
Error: invalid justification: expected a non-empty sentence
```

**Root cause**: when a sandbox executor is attached, the `bash`/`write`/`edit` tool schemas advertise a
`sandbox_permissions` field globally, but the effective mode is resolved per session. Execution requires the request to
be *strictly wider* plus a non-empty justification, otherwise the whole call fails closed. GPT/Claude-class models attach
the field speculatively and blow up in `danger-full-access` sessions.

**Fix**: the `tools/execute` hook resolves the session's standing mode and strips `sandbox_permissions` +
`justification` when the request is doomed (same mode / narrower / no sandbox service / unknown mode), executing at
the standing mode — semantically identical, because the model already has what it asked for. Strictly-wider requests are
preserved and go through the normal approval flow.

`stripEscalation`: `"redundant"` (default — only strip doomed requests) | `"always"` (strip even legal escalations,
for sessions with approval prompts disabled) | `"off"`.

## 3. `missing required property "description"`

**Root cause**: `bash` / `run_code` / `subagent` declare a required `description` argument (used as the UI label);
strict JSON-Schema validation rejects the whole call when the model omits it.

**Fix**: on `tools/execute`, before strict validation, synthesize the description from the call payload when required
and missing:

- `bash` → first line of the command (`Run: cd /tmp && rm -rf build`)
- `run_code` → first effective code line (comments / braces skipped)
- `subagent` / `subagent_fork` → first line of the prompt
- `workflow` → fills the nested `meta.description` too

Calls that already carry a usable description are untouched.

## Configuration (optional)

`~/.dsh/compat-guard.json`:

```json
{
  "compactionMaxTokens": 32768,
  "compactionEffort": "auto",
  "compactionStripTools": false,
  "compactionPurposes": ["compaction"],
  "fillDescription": true,
  "stripEscalation": "redundant",
  "logFixes": true
}
```

- `compactionEffort`: `"auto"` (cheapest level) | `"keep"` (leave untouched) | an explicit effort id.
- `compactionStripTools`: when `true`, drops the tools list from compaction requests (prevents the model from calling
  tools mid-summary; costs the prefix KV cache).
- Same-named fields passed as cordis plugin config override the file.

Apply config changes with `systemctl restart dsh-web` (or restart your `dsh web` process). Look for
`compat-guard:` lines in the logs to see every applied fix.

## Install

From the marketplace (Settings → Plugins → Marketplace, searchable as `dsh-compat-guard`) or directly:

```bash
dsh plugin --profile web add github:782042369/dsh-compat-guard
```

Restart `dsh web` afterwards. Uninstall: `dsh plugin --profile web remove dsh-compat-guard`.

## Test

```bash
node test/smoke.mjs   # mock-driven assertions for all three fixes
```

## License

[MIT](LICENSE)
