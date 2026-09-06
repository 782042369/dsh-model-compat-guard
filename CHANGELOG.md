# Changelog

## 0.3.0 (2026-09-06)

- feat: inject a compact code-mode (PTC) discipline block into the system
  prompt of run_code-only requests — teaches models that tool results are
  plain JSON values (no .result() wrapper), that bash returns structured
  objects (res.stdout.text, never stdout.slice()), and to emit complete,
  delimiter-balanced TypeScript programs. Prevents the frequent
  "code run failed (exception): Expected ',', got '<eof>'" and
  "TypeError: b.stdout.slice is not a function" failures (upstream
  [Discussion #1605](https://github.com/deepseek-ai/deepseek-harness/discussions/1605)).
  Configurable via codeDiscipline: auto (default) | always | off.

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
