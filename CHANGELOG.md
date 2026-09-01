# Changelog

## 0.2.0 (2026-09-02)

First public release.

- Public repository + English README, LICENSE, changelog.
- No functional change since 0.1.2.

## 0.1.2 (2026-08-30)

- fix: llm/stream waterfall contract — the async listener returned a Promise
  and broke every model call with `stream is not async iterable`. The hook now
  stays synchronous and defers async tuning into the returned generator.
- Log fixes to the console so they are visible in `journalctl -u dsh-web`.

## 0.1.1 (2026-08-30)

- fix: strip doomed sandbox escalation requests (upstream
  [Discussion #3877](https://github.com/deepseek-ai/deepseek-harness/discussions/3877)) —
  non-widening / blank-justification `sandbox_permissions` no longer
  fail-closes tool calls; configurable via `stripEscalation`
  (`redundant` | `always` | `off`).

## 0.1.0 (2026-08-30)

- fix: reasoning-model compaction truncation — raise the `purpose=compaction`
  output cap (default 32768, clamped to the model's declared max) and drop the
  reasoning effort to the cheapest supported level
  (upstream [Discussion #3465](https://github.com/deepseek-ai/deepseek-harness/discussions/3465)).
- fix: auto-fill the required tool-call `description` argument that many
  models omit (`bash` / `run_code` / `subagent` / `workflow`).
