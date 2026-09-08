# Changelog

## 0.4.0

- fix: stop treating DSH's defaultMaxTokens field as a hard provider cap; honor an explicit hardMaxTokens capability when a provider supplies one.
- fix: reject blank sandbox justifications and preserve escalation requests when the active policy is unknown unless explicitly configured otherwise.
- fix: fill missing workflow metadata even when the entire meta object is absent.
- feat: coalesce and TTL-cache model capability lookups with a timeout to avoid serial metadata stalls.
- harden: restrict automatic description repair to known UI tools, redact payload text from repair logs, and prevent duplicate hook registration.
- change: deprecated code-mode prompt mutation is now off by default; use the native AGENTS.md instruction pipeline.

## 0.3.7 (2026-09-07)

- docs: codeDiscipline superseded by the native instruction pipeline. The
  harness deep-freezes llm/stream request objects (properties AND the messages
  array), so no in-hook mutation channel exists — assignment, defineProperty,
  and array splice are all rejected. The discipline text now lives in
  `~/.dsh/AGENTS.md` (native AGENTS.md/CLAUDE.md injection, effective on the
  next turn without a restart). `codeDiscipline: "off"` is the archived
  default; the three original fixes (compaction tuning, description fill,
  doomed-escalation strip) are unaffected and keep working.
- feat: load banner + first-request probe diagnostics (visible via
  `journalctl -u dsh-web`) to make plugin-load and hook-fire states
  observable from the outside.

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
