/**
 * Mock-based smoke test for dsh-compat-guard.
 * Run: node test/smoke.mjs  (exit 0 = all scenarios pass)
 */
import { apply } from "../src/index.js";

const listeners = {};
const logs = [];
const makeCtx = ({ modelInfo, standingMode = "danger-full-access" }) => ({
	on(event, handler) {
		listeners[event] = handler;
	},
	get(name) {
		if (name === "sandboxPolicy" && standingMode !== null) {
			return { resolve: () => ({ mode: standingMode }) };
		}
		return undefined;
	},
	logger: {
		info: (m) => logs.push(["info", m]),
		warn: (m) => logs.push(["warn", m])
	},
	llm: {
		async resolveModelInfo(provider, model) {
			if (model === "throw") throw new Error("lookup boom");
			return modelInfo;
		}
	},
	tools: {
		get(name) {
			return TOOL_DEFS[name];
		}
	}
});

const TOOL_DEFS = {
	bash: { parameters: { type: "object", properties: { command: { type: "string" }, description: { type: "string" } }, required: ["command", "description"] } },
	run_code: { parameters: { type: "object", properties: { code: { type: "string" }, description: { type: "string" } }, required: ["code", "description"] } },
	subagent: { parameters: { type: "object", properties: { prompt: { type: "string" }, description: { type: "string" } }, required: ["prompt", "description"] } },
	workflow: { parameters: { type: "object", properties: { script: { type: "string" }, meta: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name", "description"] } }, required: ["script", "meta"] } },
	read: { parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
	weird: { parameters: { type: "object", properties: { description: { type: "number" } }, required: ["description"] } }
};

let failures = 0;
function check(label, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
}

async function scenarioLlm() {
	delete listeners["llm/stream"]; delete listeners["tools/execute"];
	const ctx = makeCtx({
		modelInfo: {
			defaultMaxTokens: 128000,
			reasoning: { efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }, { id: "off" }], defaultEffort: "high" }
		}
	});
	apply(ctx, {});
	const llm = listeners["llm/stream"];
	// Production consumes the listener's return value with `for await …of`:
	// it must BE the AsyncIterable (for-await never unwraps a Promise), and the
	// lazy tuning only runs once the stream is pulled. Drain like production.
	const emptyStream = () => (async function* () {})();
	const drain = async (stream) => {
		for await (const chunk of stream) void chunk;
	};
	const opts = { purpose: "compaction", provider: "waibuzheng", model: "gpt-5.6-terra", maxTokens: 8192, messages: [], reasoningEffort: "high", tools: [{}] };
	let nextCalled = 0;
	const ret = llm(opts, () => { nextCalled++; return emptyStream(); });
	check("llm: returns AsyncIterable, not a Promise", typeof ret?.[Symbol.asyncIterator], "function");
	await drain(ret);
	check("llm: next() called once", nextCalled, 1);
	check("llm: maxTokens raised", opts.maxTokens, 32768);
	check("llm: effort lowered to cheapest (off)", opts.reasoningEffort, "off");
	check("llm: tools kept by default", opts.tools.length, 1);
	// non-compaction purpose untouched
	const main = { purpose: undefined, provider: "p", model: "m", maxTokens: 4096 };
	await drain(llm(main, () => emptyStream()));
	check("llm: main-loop request untouched", main.maxTokens, 4096);
	// clamped to declared defaultMaxTokens
	const small = makeCtx({ modelInfo: { defaultMaxTokens: 12000, reasoning: { efforts: [{ id: "low" }, { id: "high" }] } } });
	apply(small, {});
	const opts2 = { purpose: "compaction", provider: "p", model: "m", maxTokens: 8192 };
	await drain(listeners["llm/stream"](opts2, () => emptyStream()));
	check("llm: maxTokens clamped to declared cap", opts2.maxTokens, 12000);
	check("llm: cheapest without off = low", opts2.reasoningEffort, "low");
	// model without reasoning support: effort must not be set
	const noreason = makeCtx({ modelInfo: { defaultMaxTokens: 64000 } });
	apply(noreason, {});
	const opts3 = { purpose: "compaction", provider: "p", model: "m", maxTokens: 8192 };
	await drain(listeners["llm/stream"](opts3, () => emptyStream()));
	check("llm: no-reasoning model leaves effort unset", "reasoningEffort" in opts3, false);
	// info lookup failure still raises maxTokens and never throws
	const throwing = makeCtx({ modelInfo: {} });
	apply(throwing, {});
	const opts4 = { purpose: "compaction", provider: "p", model: "throw" };
	await drain(listeners["llm/stream"](opts4, () => emptyStream()));
	check("llm: lookup failure tolerated, maxTokens raised", opts4.maxTokens, 32768);
	// config: keep effort + strip tools
	const tuned = makeCtx({ modelInfo: { reasoning: { efforts: [{ id: "low" }] } } });
	apply(tuned, { compactionEffort: "keep", compactionStripTools: true, compactionMaxTokens: 16384 });
	const opts5 = { purpose: "compaction", provider: "p", model: "m", maxTokens: 8192, tools: [{}] };
	await drain(listeners["llm/stream"](opts5, () => emptyStream()));
	check("llm: keep leaves effort unset", "reasoningEffort" in opts5, false);
	check("llm: stripTools empties tools", opts5.tools, []);
	check("llm: configured maxTokens honored", opts5.maxTokens, 16384);
}

async function scenarioTools() {
	delete listeners["llm/stream"]; delete listeners["tools/execute"];
	const ctx = makeCtx({ modelInfo: {} });
	apply(ctx, {});
	const exe = listeners["tools/execute"];
	async function run(name, args) {
		const exec = { name, agent: { id: "a" }, arguments: args, signal: { aborted: false } };
		let nextCalled = 0;
		await exe(exec, () => { nextCalled++; return "ok"; });
		return { exec, nextCalled };
	}
	let r = await run("bash", { command: "cd /tmp && rm -rf build\ncmake .." });
	check("tools: bash description filled from first command line", r.exec.arguments.description, "Run: cd /tmp && rm -rf build");
	check("tools: next called", r.nextCalled, 1);
	r = await run("bash", { command: "ls", description: "List files" });
	check("tools: existing description untouched", r.exec.arguments.description, "List files");
	r = await run("bash", { command: "ls", description: "   " });
	check("tools: blank description refilled", r.exec.arguments.description, "Run: ls");
	r = await run("run_code", { code: "// calc total\nconst total = 1 + 2;\nreturn total;" });
	check("tools: run_code description from code", r.exec.arguments.description, "Execute code: const total = 1 + 2;");
	r = await run("subagent", { prompt: "Research GPT compaction failures\nmore lines" });
	check("tools: subagent description from prompt", r.exec.arguments.description, "Delegate: Research GPT compaction failures");
	r = await run("workflow", { script: "return 1;", meta: { name: "audit" } });
	check("tools: workflow meta.description filled", r.exec.arguments.meta.description, "audit workflow");
	r = await run("read", { file_path: "/x" });
	check("tools: no required description -> untouched", r.exec.arguments, { file_path: "/x" });
	r = await run("weird", { });
	check("tools: non-string description schema -> untouched", r.exec.arguments, {});
	r = await run("bash", undefined);
	check("tools: undefined args become describable object", r.exec.arguments.description, "Run shell command");
	// frozen arguments are replaced, not mutated
	const frozen = Object.freeze({ command: "pwd" });
	r = await run("bash", frozen);
	check("tools: frozen args replaced", r.exec.arguments.description, "Run: pwd");
	check("tools: original frozen object untouched", frozen.description, undefined);
}

async function scenarioEscalation() {
	delete listeners["llm/stream"]; delete listeners["tools/execute"];
	const ctx = makeCtx({ modelInfo: {}, standingMode: "danger-full-access" });
	apply(ctx, {});
	const exe = listeners["tools/execute"];
	async function run(name, args) {
		const exec = { name, agent: { session: { id: "s1" } }, arguments: args, signal: { aborted: false } };
		await exe(exec, () => "ok");
		return exec;
	}
	let r = await run("bash", { command: "ls", description: "List", sandbox_permissions: "danger-full-access", justification: "need full access" });
	check("esc: same-mode request stripped", "sandbox_permissions" in r.arguments, false);
	check("esc: justification dropped with it", "justification" in r.arguments, false);
	check("esc: other args kept", r.arguments.command, "ls");
	r = await run("bash", { command: "ls", description: "List", sandbox_permissions: "workspace-write", justification: "narrower ask at full access" });
	check("esc: narrower-than-current stripped", "sandbox_permissions" in r.arguments, false);
	const ww = makeCtx({ modelInfo: {}, standingMode: "workspace-write" });
	apply(ww, {});
	const exeWW = listeners["tools/execute"];
	const kept = { name: "bash", agent: { session: { id: "s" } }, arguments: { command: "ls", description: "L", sandbox_permissions: "danger-full-access", justification: "really need it" }, signal: { aborted: false } };
	await exeWW(kept, () => "ok");
	check("esc: strictly-wider request kept for approval flow", kept.arguments.sandbox_permissions, "danger-full-access");
	const doomed = { name: "bash", agent: { session: { id: "s" } }, arguments: { command: "ls", description: "L", sandbox_permissions: "workspace-write", justification: "same mode" }, signal: { aborted: false } };
	await exeWW(doomed, () => "ok");
	check("esc: same-mode at workspace-write stripped", "sandbox_permissions" in doomed.arguments, false);
	const nosb = makeCtx({ modelInfo: {}, standingMode: null });
	apply(nosb, {});
	const bare = { name: "bash", agent: { session: { id: "s" } }, arguments: { command: "ls", description: "L", sandbox_permissions: "danger-full-access" }, signal: { aborted: false } };
	await listeners["tools/execute"](bare, () => "ok");
	check("esc: no sandbox service mounted -> stripped", "sandbox_permissions" in bare.arguments, false);
	const offCfg = makeCtx({ modelInfo: {}, standingMode: "danger-full-access" });
	apply(offCfg, { stripEscalation: "off" });
	const offExec = { name: "bash", agent: { session: { id: "s" } }, arguments: { command: "ls", description: "L", sandbox_permissions: "danger-full-access", justification: "x" }, signal: { aborted: false } };
	await listeners["tools/execute"](offExec, () => "ok");
	check("esc: stripEscalation off -> untouched", offExec.arguments.sandbox_permissions, "danger-full-access");
	const alwaysCfg = makeCtx({ modelInfo: {}, standingMode: "workspace-write" });
	apply(alwaysCfg, { stripEscalation: "always" });
	const alwaysExec = { name: "bash", agent: { session: { id: "s" } }, arguments: { command: "ls", description: "L", sandbox_permissions: "danger-full-access", justification: "x" }, signal: { aborted: false } };
	await listeners["tools/execute"](alwaysExec, () => "ok");
	check("esc: always strips even strictly-wider", "sandbox_permissions" in alwaysExec.arguments, false);
	const bothCfg = makeCtx({ modelInfo: {}, standingMode: "danger-full-access" });
	apply(bothCfg, {});
	const both = { name: "bash", agent: { session: { id: "s" } }, arguments: { command: "pwd", sandbox_permissions: "danger-full-access", justification: "x" }, signal: { aborted: false } };
	await listeners["tools/execute"](both, () => "ok");
	check("esc: combined with description fill", both.arguments.description, "Run: pwd");
	check("esc: combined escalation stripped", "sandbox_permissions" in both.arguments, false);
}

async function main() {
	await scenarioLlm();
	await scenarioTools();
	await scenarioEscalation();
	if (failures > 0) {
		console.error(`${failures} check(s) FAILED`);
		process.exit(1);
	}
	console.log("ALL CHECKS PASSED");
}
main();
