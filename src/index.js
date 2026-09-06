/**
 * dsh-compat-guard — compatibility guard for third-party models on DSH.
 *
 * Repairs two frequent failure modes when driving DeepSeek Harness with
 * non-DeepSeek models (GPT / self-hosted reasoning models / ...):
 *
 * 1. Auto-compaction failure ("summarization truncated at the token cap").
 *    dsh-compaction-basic summarizes with a hard `maxTokens` cap (default
 *    8192) and fails closed when the summary hits it. Reasoning models spend
 *    invisible thinking tokens inside that same budget, so any model that
 *    thinks heavily (GPT-5.x, Qwen-thinking, ...) truncates and compaction
 *    aborts. Fix: on `purpose === "compaction"` LLM requests, raise the
 *    output cap (default 32768, clamped to the model's declared cap when
 *    known) and drop the reasoning effort to the cheapest level the model
 *    supports (prefer off > minimal > low).
 *
 * 2. `Error: invalid arguments: missing required property "description"`.
 *    Tools like bash / run_code / subagent declare a required `description`
 *    argument for the UI label; many models omit it and the strict schema
 *    validation rejects the whole call. Fix: on `tools/execute`, when the
 *    tool's schema requires a string `description` and the model did not
 *    supply a usable one, synthesize it from the call payload (the command,
 *    the code, the prompt, ...) before validation runs.
 *
 * 3. Code Mode (PTC) run_code failures. Models unadapted to programmatic
 *    tool calling emit incomplete TypeScript programs (unbalanced quotes or
 *    brackets, truncated code -> "code run failed (exception): Expected ',',
 *    got '<eof>'") or misuse structured results ("b.stdout.slice is not a
 *    function" — bash stdout is { text, truncated, spillPath? }, not a
 *    string). Fix: append a compact discipline block to the system prompt of
 *    code-mode requests (run_code is the single wired tool) teaching the
 *    result shapes and closure hygiene.
 *
 * Runtime configuration (optional): ~/.dsh/compat-guard.json
 *   {
 *     "compactionMaxTokens": 32768,
 *     "compactionEffort": "auto",          // "auto" | "keep" | explicit effort id
 *     "compactionStripTools": false,       // drop tools from compaction requests
 *     "compactionPurposes": ["compaction"],
 *     "fillDescription": true,
 *     "codeDiscipline": "auto",          // "auto" | "always" | "off"
 *     "logFixes": true
 *   }
 * Values passed as the cordis plugin config override the file.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "compat-guard";
export const inject = ["llm", "tools"];

const CONFIG_FILE = join(homedir(), ".dsh", "compat-guard.json");

const DEFAULTS = Object.freeze({
	compactionMaxTokens: 32768,
	compactionEffort: "auto",
	compactionStripTools: false,
	compactionPurposes: Object.freeze(["compaction"]),
	fillDescription: true,
	codeDiscipline: "auto",
	stripEscalation: "redundant",
	logFixes: true
});

/**
 * Strict-widening lattice from dsh-sandbox approveEscalation: modes a call may
 * escalate TO. "danger-full-access" has no wider target, so any
 * sandbox_permissions request there is rejected fail-closed upstream.
 */
const WIDER_MODES = Object.freeze({
	"read-only": Object.freeze(["workspace-write", "danger-full-access"]),
	"workspace-write": Object.freeze(["danger-full-access"])
});

/** Lower score = cheaper reasoning; unknown ids sort last. */
const EFFORT_PREFERENCE = new Map([
	["off", 0],
	["none", 0],
	["disable", 0],
	["disabled", 0],
	["minimal", 1],
	["low", 2],
	["medium", 3],
	["default", 3],
	["high", 4],
	["xhigh", 5],
	["ultra", 5],
	["max", 6]
]);

/** Idempotency marker for the injected code-mode discipline block. */
const CODE_DISCIPLINE_MARKER = "[compat-guard code-mode discipline]";

/** Compact discipline appended to code-mode system prompts (see injectCodeDiscipline). */
const CODE_DISCIPLINE_TEXT = [
	CODE_DISCIPLINE_MARKER,
	"- Tool results inside run_code are plain JSON values: there is no .result() or .json() wrapper — use the value directly.",
	"- The bash tool returns structured objects: read output with res.stdout.text and res.stderr.text, status with res.exitCode. stdout and stderr are objects, NOT strings — never call .slice()/.trim()/.startsWith() on them or read .length directly.",
	"- The code argument must be one complete, syntactically valid TypeScript program: every quote, backtick, brace, bracket, and paren balanced, every object/array/call closed. Prefer multi-line code over one long line and re-check delimiter balance before finishing."
].join("\n");

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadFileConfig() {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
		return isPlainObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function normalizeConfig(inline) {
	const cfg = { ...DEFAULTS, ...loadFileConfig() };
	if (isPlainObject(inline)) {
		for (const [key, value] of Object.entries(inline)) {
			if (value !== undefined && key in DEFAULTS) cfg[key] = value;
		}
	}
	if (!Number.isInteger(cfg.compactionMaxTokens) || cfg.compactionMaxTokens < 1024) cfg.compactionMaxTokens = DEFAULTS.compactionMaxTokens;
	if (typeof cfg.compactionEffort !== "string") cfg.compactionEffort = "auto";
	if (typeof cfg.compactionStripTools !== "boolean") cfg.compactionStripTools = false;
	if (!Array.isArray(cfg.compactionPurposes) || cfg.compactionPurposes.length === 0) cfg.compactionPurposes = ["compaction"];
	if (typeof cfg.fillDescription !== "boolean") cfg.fillDescription = true;
	if (typeof cfg.codeDiscipline !== "string" || !["auto", "always", "off"].includes(cfg.codeDiscipline)) cfg.codeDiscipline = "auto";
	if (typeof cfg.logFixes !== "boolean") cfg.logFixes = true;
	return cfg;
}

/** First non-empty line of a string, whitespace-collapsed and length-capped. */
function firstLine(value, cap = 90) {
	if (typeof value !== "string") return undefined;
	for (const raw of value.split(/\r?\n/)) {
		const line = raw.replace(/\s+/g, " ").trim();
		if (line.length === 0) continue;
		return line.length > cap ? line.slice(0, cap) + "…" : line;
	}
	return undefined;
}

/** First meaningful code line: skips blanks, braces, and comment decoration. */
function codeSummary(value, cap = 90) {
	if (typeof value !== "string") return undefined;
	for (const raw of value.split(/\r?\n/)) {
		let line = raw.trim();
		if (line.length === 0) continue;
		// Skip whole comment lines (block, line, and continuation decoration).
		if (/^(\/\/|\/\*|\*)/.test(line)) continue;
		line = line.replace(/^\/\*+\*?\/?/, "").replace(/^\/\/+/, "").replace(/^\*+/, "").trim();
		if (line.length === 0) continue;
		if (/^[{}();,]+$/.test(line)) continue;
		if (line.length > cap) line = line.slice(0, cap) + "…";
		return line;
	}
	return undefined;
}

/** Synthesize a UI-grade description from the tool payload. */
function synthesizeDescription(tool, args) {
	switch (tool) {
		case "bash": {
			const line = firstLine(args?.command);
			return line === undefined ? "Run shell command" : `Run: ${line}`;
		}
		case "run_code": {
			const line = codeSummary(args?.code);
			return line === undefined ? "Execute code program" : `Execute code: ${line}`;
		}
		case "subagent":
		case "subagent_fork": {
			const line = firstLine(args?.prompt);
			return line === undefined ? `Delegate ${tool} task` : `Delegate: ${line}`;
		}
		case "workflow": {
			const label = typeof args?.meta?.name === "string" && args.meta.name.length > 0 ? args.meta.name : "Unnamed";
			return `${label} workflow`;
		}
		default: return `${tool} call (auto-filled)`;
	}
}

/** Whether a JSON-schema property node accepts string values. */
function acceptsString(node) {
	if (!isPlainObject(node)) return true;
	const type = node.type;
	if (type === undefined) return true;
	return Array.isArray(type) ? type.includes("string") : type === "string";
}

/**
 * Fill the required-but-missing `description` (and workflow `meta.description`)
 * before strict validation runs. Replaces `exec.arguments` with an unfrozen
 * shallow clone; the exec object itself is the designated mutable carrier of
 * the tools/execute waterfall.
 */
function fillMissingDescription(ctx, cfg, exec) {
	const args = exec.arguments;
	if (args !== undefined && !isPlainObject(args)) return;
	const base = args ?? {};
	let tool;
	try {
		tool = ctx.tools.get(exec.name, exec.agent);
	} catch {
		return;
	}
	const schema = tool?.parameters;
	if (!isPlainObject(schema)) return;
	const required = Array.isArray(schema.required) ? schema.required : [];
	let next;
	const ensure = () => next ?? (next = { ...base });
	if (required.includes("description") && acceptsString(schema.properties?.description)) {
		const current = base.description;
		if (typeof current !== "string" || current.trim().length === 0) {
			ensure().description = synthesizeDescription(exec.name, base);
		}
	}
	if (exec.name === "workflow" && isPlainObject(base.meta) && Array.isArray(schema.properties?.meta?.required) && schema.properties.meta.required.includes("description")) {
		const current = base.meta.description;
		if (typeof current !== "string" || current.trim().length === 0) {
			ensure().meta = { ...base.meta, description: `${typeof base.meta.name === "string" && base.meta.name.length > 0 ? base.meta.name : "Unnamed"} workflow` };
		}
	}
	if (next !== undefined) {
		exec.arguments = next;
		if (cfg.logFixes) logInfo(ctx, `compat-guard: filled missing ${exec.name} description: "${next.description ?? next.meta?.description}"`);
	}
}

/**
 * Strip sandbox-escalation arguments that can only fail. Non-DeepSeek models
 * (GPT/Claude/...) attach sandbox_permissions speculatively; when the request
 * is not strictly wider than the session's standing mode (equal, narrower,
 * unknown, or no confining executor mounted) dsh-sandbox's approveEscalation
 * rejects the whole call fail-closed, spamming tool errors. Stripping runs
 * the call at the current standing mode instead — semantically what the
 * model asked for whenever the request was redundant.
 */
function stripDoomedEscalation(ctx, cfg, exec) {
	if (cfg.stripEscalation === "off") return;
	const args = exec.arguments;
	if (!isPlainObject(args) || args.sandbox_permissions === undefined) return;
	if (cfg.stripEscalation !== "always") {
		let keep = false;
		try {
			const policy = typeof ctx.get === "function" ? ctx.get("sandboxPolicy") : undefined;
			if (policy !== undefined && typeof policy.resolve === "function") {
				const standing = policy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
				const effective = standing?.mode;
				keep = typeof effective === "string" && (WIDER_MODES[effective] ?? []).includes(args.sandbox_permissions);
			}
		} catch {
			keep = false;
		}
		if (keep) return;
	}
	const next = { ...args };
	delete next.sandbox_permissions;
	if (next.justification !== undefined) delete next.justification;
	exec.arguments = next;
	if (cfg.logFixes) logInfo(ctx, `compat-guard: stripped doomed ${exec.name} escalation to "${String(args.sandbox_permissions)}" (redundant or unavailable; running at the standing mode)`);
}

/** Cheapest supported reasoning effort id, or undefined when untaggable. */
function cheapestEffort(efforts) {
	let best;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const effort of efforts) {
		if (typeof effort?.id !== "string") continue;
		const score = EFFORT_PREFERENCE.get(effort.id) ?? 99;
		if (score < bestScore) {
			best = effort.id;
			bestScore = score;
		}
	}
	return best;
}

/**
 * Whether this outgoing request is a Code Mode (PTC) call: code mode wires
 * exactly one callable tool (run_code), while JSON tool-calling mode wires
 * the full schema set. Accepts both native { name } and OpenAI-style
 * { function: { name } } tool entries.
 * @param options GenerateOptions of the outgoing model call.
 * @returns true when run_code is the only wired tool.
 */
function isCodeModeRequest(options) {
	const tools = Array.isArray(options.tools) ? options.tools : [];
	if (tools.length !== 1) return false;
	const entry = tools[0];
	const name = typeof entry?.name === "string" ? entry.name : typeof entry?.function?.name === "string" ? entry.function.name : undefined;
	return name === "run_code";
}

/**
 * Append the code-mode discipline block to a request's system prompt, once.
 * Appending at the end keeps the provider prefix (and prompt cache) intact;
 * the marker check makes re-application a no-op. Auxiliary requests
 * (compaction / session-title) never run tools and are skipped.
 * @param ctx runtime context for logging.
 * @param cfg normalized plugin configuration.
 * @param options GenerateOptions mutated in place (system only).
 */
function injectCodeDiscipline(ctx, cfg, options) {
	if (cfg.codeDiscipline === "off") return;
	if (options.purpose !== undefined) return;
	if (cfg.codeDiscipline === "auto" && !isCodeModeRequest(options)) return;
	if (typeof options.system === "string" && options.system.includes(CODE_DISCIPLINE_MARKER)) return;
	options.system = typeof options.system === "string" && options.system.length > 0 ? options.system + "\n\n" + CODE_DISCIPLINE_TEXT : CODE_DISCIPLINE_TEXT;
	if (cfg.logFixes) logInfo(ctx, "compat-guard: injected code-mode discipline into system prompt (" + options.provider + "/" + options.model + ")");
}

/** Tune one auxiliary (compaction-style) LLM request in place. */
async function tuneAuxRequest(ctx, cfg, options) {
	if (!isPlainObject(options)) return;
	if (typeof options.provider !== "string" || typeof options.model !== "string") return;
	if (!cfg.compactionPurposes.includes(options.purpose)) return;
	let info;
	try {
		info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal);
	} catch (error) {
		if (cfg.logFixes) logWarn(ctx, `compat-guard: model info lookup failed for ${options.provider}/${options.model}: ${error?.message ?? error}`);
	}
	const changes = [];
	if (Number.isInteger(cfg.compactionMaxTokens)) {
		let raise = cfg.compactionMaxTokens;
		const declared = info?.defaultMaxTokens;
		if (Number.isInteger(declared) && declared > 8192) raise = Math.min(raise, declared);
		const current = typeof options.maxTokens === "number" ? options.maxTokens : 0;
		if (raise > current) {
			options.maxTokens = raise;
			changes.push(`maxTokens ${current || "unset"}→${raise}`);
		}
	}
	if (cfg.compactionEffort !== "keep") {
		const reasoning = info?.reasoning;
		if (reasoning === undefined || reasoning === null) {
			// Model does not support reasoning efforts; sending one would throw
			// UNSUPPORTED_REASONING_EFFORT, so leave the request untouched.
		} else if (Array.isArray(reasoning.efforts) && reasoning.efforts.length > 0) {
			const ids = reasoning.efforts.map((effort) => effort?.id).filter((id) => typeof id === "string");
			let effort;
			if (cfg.compactionEffort === "auto") effort = cheapestEffort(reasoning.efforts);
			else if (ids.includes(cfg.compactionEffort)) effort = cfg.compactionEffort;
			else if (cfg.logFixes) logWarn(ctx, `compat-guard: configured effort "${cfg.compactionEffort}" unsupported by ${options.provider}/${options.model}; keeping ${options.reasoningEffort ?? reasoning.defaultEffort ?? "default"}`);
			if (effort !== undefined && options.reasoningEffort !== effort) {
				options.reasoningEffort = effort;
				changes.push(`effort→${effort}`);
			}
		}
	}
	if (cfg.compactionStripTools && Array.isArray(options.tools) && options.tools.length > 0) {
		options.tools = [];
		changes.push("tools stripped");
	}
	if (changes.length > 0 && cfg.logFixes) logInfo(ctx, `compat-guard: tuned ${options.purpose} request for ${options.provider}/${options.model} (${changes.join(", ")})`);
}

function logInfo(ctx, message) {
	try {
		console.log(`[compat-guard] ${message}`);
	} catch {}
	try {
		ctx.logger?.info?.(message);
	} catch {}
}

function logWarn(ctx, message) {
	try {
		console.warn(`[compat-guard] ${message}`);
	} catch {}
	try {
		ctx.logger?.warn?.(message);
	} catch {}
}

export function apply(ctx, config) {
	const cfg = normalizeConfig(config);
	// The llm/stream waterfall must return the downstream AsyncIterable itself:
	// consumers iterate it directly (`for await …of stream`), and for-await does
	// NOT unwrap promises — an `async` listener here returns a Promise and every
	// model call dies with "stream is not async iterable". Stay synchronous and
	// defer the async tuning into the returned generator (the same pattern
	// dsh-session-checkpoint-policy uses for its checkpoint wrapper), so the
	// options are still tuned before the adapter reads them at first pull.
	ctx.on("llm/stream", (options, next) => (async function* () {
		try {
			injectCodeDiscipline(ctx, cfg, options);
			await tuneAuxRequest(ctx, cfg, options);
		} catch (error) {
			logWarn(ctx, `compat-guard: llm/stream tuning failed: ${error?.message ?? error}`);
		}
		yield* next();
	})(), { global: true, prepend: true });
	ctx.on("tools/execute", async (exec, next) => {
		if (exec !== null && typeof exec === "object") {
			try {
				stripDoomedEscalation(ctx, cfg, exec);
			} catch (error) {
				logWarn(ctx, `compat-guard: escalation strip failed: ${error?.message ?? error}`);
			}
			try {
				if (cfg.fillDescription) fillMissingDescription(ctx, cfg, exec);
			} catch (error) {
				logWarn(ctx, `compat-guard: description fill failed: ${error?.message ?? error}`);
			}
		}
		return next();
	});
}
