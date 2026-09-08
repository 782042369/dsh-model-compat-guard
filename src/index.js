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
	descriptionTools: Object.freeze(["bash", "run_code", "subagent", "subagent_fork", "workflow"]),
	codeDiscipline: "off",
	stripEscalation: "redundant",
	unknownPolicy: "preserve",
	modelInfoTtlMs: 300000,
	modelInfoTimeoutMs: 5000,
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

/** Plugin version string mirrored from package.json for load banners. */
const VERSION = "0.4.0";
/** Contexts already wired by this module; prevents duplicate hooks on reload. */
const APPLIED_CONTEXTS = new WeakSet();

/**
 * codeDiscipline note (v0.3.7): the harness deep-freezes llm/stream request
 * objects (properties AND the messages array), so no in-hook mutation channel
 * exists. The discipline text now lives in ~/.dsh/AGENTS.md where the native
 * instruction pipeline injects it into every system prompt. Keep "off".
 */
const DISCIPLINE_SPLICE_TAG = Symbol("compatGuardDiscipline");

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
	if (!Number.isInteger(cfg.compactionMaxTokens) || cfg.compactionMaxTokens < 1024 || cfg.compactionMaxTokens > 1_000_000) cfg.compactionMaxTokens = DEFAULTS.compactionMaxTokens;
	if (typeof cfg.compactionEffort !== "string") cfg.compactionEffort = "auto";
	if (typeof cfg.compactionStripTools !== "boolean") cfg.compactionStripTools = false;
	if (!Array.isArray(cfg.compactionPurposes) || cfg.compactionPurposes.length === 0) cfg.compactionPurposes = ["compaction"];
	cfg.compactionPurposes = cfg.compactionPurposes.filter((purpose) => typeof purpose === "string" && purpose.length > 0);
	if (cfg.compactionPurposes.length === 0) cfg.compactionPurposes = ["compaction"];
	if (typeof cfg.fillDescription !== "boolean") cfg.fillDescription = true;
	if (!Array.isArray(cfg.descriptionTools)) cfg.descriptionTools = [...DEFAULTS.descriptionTools];
	cfg.descriptionTools = [...new Set(cfg.descriptionTools.filter((tool) => typeof tool === "string" && tool.length > 0))];
	if (typeof cfg.codeDiscipline !== "string" || !["auto", "always", "off"].includes(cfg.codeDiscipline)) cfg.codeDiscipline = "off";
	if (typeof cfg.stripEscalation !== "string" || !["redundant", "always", "off"].includes(cfg.stripEscalation)) cfg.stripEscalation = "redundant";
	if (typeof cfg.unknownPolicy !== "string" || !["preserve", "strip"].includes(cfg.unknownPolicy)) cfg.unknownPolicy = "preserve";
	if (!Number.isInteger(cfg.modelInfoTtlMs) || cfg.modelInfoTtlMs < 0 || cfg.modelInfoTtlMs > 3_600_000) cfg.modelInfoTtlMs = DEFAULTS.modelInfoTtlMs;
	if (!Number.isInteger(cfg.modelInfoTimeoutMs) || cfg.modelInfoTimeoutMs < 100 || cfg.modelInfoTimeoutMs > 60_000) cfg.modelInfoTimeoutMs = DEFAULTS.modelInfoTimeoutMs;
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
	if (!cfg.descriptionTools.includes(exec.name)) return;
	const required = Array.isArray(schema.required) ? schema.required : [];
	let next;
	const ensure = () => next ?? (next = { ...base });
	if (required.includes("description") && acceptsString(schema.properties?.description)) {
		const current = base.description;
		if (typeof current !== "string" || current.trim().length === 0) {
			ensure().description = synthesizeDescription(exec.name, base);
		}
	}
	if (exec.name === "workflow" && Array.isArray(schema.properties?.meta?.required) && schema.properties.meta.required.includes("description")) {
		const meta = isPlainObject(base.meta) ? base.meta : {};
		const current = meta.description;
		if (typeof current !== "string" || current.trim().length === 0) {
			const name = typeof meta.name === "string" && meta.name.length > 0 ? meta.name : "Unnamed";
			ensure().meta = { ...meta, name, description: name + " workflow" };
		}
	}
	if (next !== undefined) {
		exec.arguments = next;
		if (cfg.logFixes) logInfo(ctx, "compat-guard: filled " + exec.name + " description (chars=" + String(next.description ?? next.meta?.description ?? "").length + ")");
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
	const justificationValid = typeof args.justification === "string" && args.justification.trim().length > 0;
	let keep = justificationValid && cfg.stripEscalation !== "always";
	let policyKnown = false;
	if (keep) {
		try {
			const policy = typeof ctx.get === "function" ? ctx.get("sandboxPolicy") : undefined;
			if (policy !== undefined && typeof policy.resolve === "function") {
				const standing = policy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
				const effective = standing?.mode;
				policyKnown = typeof effective === "string" && (effective === "danger-full-access" || Object.prototype.hasOwnProperty.call(WIDER_MODES, effective));
				keep = policyKnown && (WIDER_MODES[effective] ?? []).includes(args.sandbox_permissions);
			}
		} catch {
			policyKnown = false;
			keep = false;
		}
	}
	if (!policyKnown && cfg.unknownPolicy === "preserve" && justificationValid && cfg.stripEscalation !== "always") return;
	if (keep) return;
	const next = { ...args };
	delete next.sandbox_permissions;
	if (next.justification !== undefined) delete next.justification;
	exec.arguments = next;
	if (cfg.logFixes) logInfo(ctx, "compat-guard: stripped doomed " + exec.name + " escalation (reason=" + (justificationValid ? (policyKnown ? "non-widening" : "unknown-policy") : "invalid-justification") + ")");
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
 * @param options GenerateOptions mutated in place (system only, or via a tagged leading system message when the request object is frozen).
 * @returns true when a tagged system message was spliced into options.messages and the caller must remove it after the stream drains.
 */
function injectCodeDiscipline(ctx, cfg, options) {
	if (cfg.codeDiscipline === "off") return;
	if (options.purpose !== undefined) return;
	if (cfg.codeDiscipline === "auto" && !isCodeModeRequest(options)) return;
	if (typeof options.system === "string" && options.system.includes(CODE_DISCIPLINE_MARKER)) return;
	const currentSystem = typeof options.system === "string" ? options.system : "";
	const nextSystem = currentSystem.length > 0 ? currentSystem + "\n\n" + CODE_DISCIPLINE_TEXT : CODE_DISCIPLINE_TEXT;
	try {
		options.system = nextSystem;
		if (cfg.logFixes) logInfo(ctx, "compat-guard: injected code-mode discipline into system prompt (" + options.provider + "/" + options.model + ")");
		return false;
	} catch {
		// The harness Object.freeze()s the request object (shallow): property writes
		// are impossible. Splice the discipline into the per-request messages array
		// as a leading system message instead (adapters fold system-role entries
		// into the prompt), and let the caller remove it after the stream drains.
		const messages = options.messages;
		if (!Array.isArray(messages) || Object.isFrozen(messages)) return false;
		const head = messages[0];
		if (head && head[DISCIPLINE_SPLICE_TAG] === true) return false;
		messages.unshift({ role: "system", content: [{ type: "text", text: CODE_DISCIPLINE_TEXT }], [DISCIPLINE_SPLICE_TAG]: true });
		if (cfg.logFixes) logInfo(ctx, "compat-guard: injected code-mode discipline via messages splice (" + options.provider + "/" + options.model + ")");
		return true;
	}
}

/** Resolve model capabilities with bounded, coalesced caching.
 * @param ctx - Cordis runtime context.
 * @param cfg - normalized plugin configuration.
 * @param options - outgoing model request.
 * @param cache - per-plugin capability cache.
 * @returns A promise for the model capability record or undefined.
 */
async function lookupModelInfo(ctx, cfg, options, cache) {
	const key = options.provider + "\0" + options.model;
	const now = Date.now();
	const cached = cache.get(key);
	if (cached !== undefined && cached.expiresAt > now) return cached.promise;
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error("model capability lookup timed out")), cfg.modelInfoTimeoutMs);
		(timer).unref?.();
	});
	const promise = Promise.race([ctx.llm.resolveModelInfo(options.provider, options.model, options.signal), timeout])
		.finally(() => clearTimeout(timer))
		.then((value) => {
			cache.set(key, { expiresAt: Date.now() + cfg.modelInfoTtlMs, promise: Promise.resolve(value) });
			return value;
		}, (error) => {
			cache.delete(key);
			throw error;
		});
	cache.set(key, { expiresAt: now + cfg.modelInfoTtlMs, promise });
	return promise;
}

/** Tune one auxiliary (compaction-style) LLM request in place.
 * @param ctx - Cordis runtime context.
 * @param cfg - normalized plugin configuration.
 * @param options - outgoing model request.
 * @param cache - per-plugin capability cache.
 * @returns A promise settled after best-effort tuning.
 */
async function tuneAuxRequest(ctx, cfg, options, cache) {
	if (!isPlainObject(options)) return;
	if (typeof options.provider !== "string" || typeof options.model !== "string") return;
	if (!cfg.compactionPurposes.includes(options.purpose)) return;
	let info;
	try {
		info = await lookupModelInfo(ctx, cfg, options, cache);
	} catch (error) {
		if (cfg.logFixes) logWarn(ctx, `compat-guard: model info lookup failed for ${options.provider}/${options.model}: ${error?.message ?? error}`);
	}
	const changes = [];
	if (Number.isInteger(cfg.compactionMaxTokens)) {
		let raise = cfg.compactionMaxTokens;
		const hardCap = info?.hardMaxTokens;
		if (Number.isInteger(hardCap) && hardCap > 0) raise = Math.min(raise, hardCap);
		const current = typeof options.maxTokens === "number" ? options.maxTokens : 0;
		if (raise > 0 && raise !== current) {
			try {
				options.maxTokens = raise;
				if (options.maxTokens === raise) changes.push(`maxTokens ${current || "unset"}→${raise}`);
			} catch {
				if (cfg.logFixes) logWarn(ctx, "compat-guard: compaction maxTokens skipped because request is immutable");
			}
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
				try {
					options.reasoningEffort = effort;
					if (options.reasoningEffort === effort) changes.push(`effort→${effort}`);
				} catch {
					if (cfg.logFixes) logWarn(ctx, "compat-guard: compaction reasoning effort skipped because request is immutable");
				}
			}
		}
	}
	if (cfg.compactionStripTools && Array.isArray(options.tools) && options.tools.length > 0) {
		try {
			options.tools = [];
			if (Array.isArray(options.tools) && options.tools.length === 0) changes.push("tools stripped");
		} catch {
			if (cfg.logFixes) logWarn(ctx, "compat-guard: compaction tools strip skipped because request is immutable");
		}
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

/** Apply compatibility repairs to one Cordis context.
 * @param ctx - Cordis plugin context.
 * @param config - optional inline configuration override.
 * @returns void; hooks are owned by the context lifecycle.
 */
export function apply(ctx, config) {
	if (ctx !== null && typeof ctx === "object") {
		if (APPLIED_CONTEXTS.has(ctx)) return;
		APPLIED_CONTEXTS.add(ctx);
	}
	const cfg = normalizeConfig(config);
	const modelInfoCache = new Map();
	logInfo(ctx, "compat-guard v" + VERSION + " loaded (codeDiscipline=" + cfg.codeDiscipline + ")");
	let firstRequestSeen = false;
	// The llm/stream waterfall must return the downstream AsyncIterable itself:
	// consumers iterate it directly (`for await …of stream`), and for-await does
	// NOT unwrap promises — an `async` listener here returns a Promise and every
	// model call dies with "stream is not async iterable". Stay synchronous and
	// defer the async tuning into the returned generator (the same pattern
	// dsh-session-checkpoint-policy uses for its checkpoint wrapper), so the
	// options are still tuned before the adapter reads them at first pull.
	ctx.on("llm/stream", (options, next) => (async function* () {
		let spliced = false;
		if (!firstRequestSeen) {
			firstRequestSeen = true;
			const t0 = Array.isArray(options.tools) ? options.tools[0] : undefined;
			const msgs = options.messages;
			logInfo(ctx, "compat-guard: first llm/stream request seen (provider=" + options.provider + " model=" + options.model + " purpose=" + String(options.purpose) + " tools=" + (Array.isArray(options.tools) ? options.tools.length : "n/a") + " tool0=" + (t0 ? String(t0.name ?? t0.function?.name) : "n/a") + " systemType=" + typeof options.system + " msgsIsArray=" + Array.isArray(msgs) + " msgsFrozen=" + (Array.isArray(msgs) ? Object.isFrozen(msgs) : "n/a") + " msgsLen=" + (Array.isArray(msgs) ? msgs.length : "n/a") + ")");
		}
		try {
			spliced = injectCodeDiscipline(ctx, cfg, options) === true;
			await tuneAuxRequest(ctx, cfg, options, modelInfoCache);
		} catch (error) {
			logWarn(ctx, `compat-guard: llm/stream tuning failed: ${error?.message ?? error}`);
		}
		try {
			yield* next();
		} finally {
			// Remove the discipline message after the stream drains so a shared
			// messages array never persists the spliced entry into session history.
			if (spliced && Array.isArray(options.messages)) {
				const messages = options.messages;
				for (let i = 0; i < Math.min(messages.length, 2); i++) {
					if (messages[i] && messages[i][DISCIPLINE_SPLICE_TAG] === true) {
						messages.splice(i, 1);
						break;
					}
				}
			}
		}
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
