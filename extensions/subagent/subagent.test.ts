// Run: node --import ./extensions/test-hooks.ts --test extensions/subagent/subagent.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { discoverAgents } from "./agents.ts";
import subagent from "./index.ts";
import { runSingleAgent } from "./run.ts";

// A fresh, empty agent dir, so neither the real ~/.pi/agent/agents nor another test's agents override this package's.
const freshAgentDir = () => (process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "subagent-test-")));

const agentFile = (dir: string, name: string, model: string) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: test\nmodel: ${model}\n---\n`);
};

test("the package's agents load with their models; user and project agents with the same name override them", () => {
	const cwd = mkdtempSync(join(tmpdir(), "subagent-project-"));
	agentFile(join(freshAgentDir(), "agents"), "scout", "user/model");
	agentFile(join(cwd, ".pi", "agents"), "planner", "project/model");
	const models = Object.fromEntries(discoverAgents(cwd, "both").agents.map((a) => [a.name, `${a.source} ${a.model}`]));
	assert.deepEqual(models, {
		scout: "user user/model",
		"deep-worker": "user openai/gpt-6.2-sol:medium",
		planner: "project project/model",
		"plan-reviewer": "user openai/gpt-6.2-sol:high",
		reviewer: "user openai/gpt-6.2-sol:high",
		worker: "user pi-claude-cli/claude-opus:high",
	});
});

test("only the package's reviewer is sandbox: read-only; a user reviewer.md without the key, or with another value, is not", () => {
	const cwd = mkdtempSync(join(tmpdir(), "subagent-project-"));
	freshAgentDir();
	const sandboxes = Object.fromEntries(discoverAgents(cwd, "user").agents.map((a) => [a.name, a.sandbox]));
	assert.equal(sandboxes.reviewer, "read-only");
	for (const [name, sandbox] of Object.entries(sandboxes)) if (name !== "reviewer") assert.equal(sandbox, undefined, name);

	const user = join(freshAgentDir(), "agents");
	agentFile(user, "reviewer", "user/model");
	assert.equal(discoverAgents(cwd, "user").agents.find((a) => a.name === "reviewer")!.sandbox, undefined);
	writeFileSync(join(user, "reviewer.md"), "---\nname: reviewer\ndescription: test\nsandbox: off\n---\n");
	assert.equal(discoverAgents(cwd, "user").agents.find((a) => a.name === "reviewer")!.sandbox, undefined);
});

test("an agent with sandbox: read-only is spawned with PI_SANDBOX_READONLY=1; an env override replaces it", async () => {
	freshAgentDir();
	const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
	process.argv[1] = join(dir, "pi.mjs");
	writeFileSync(
		process.argv[1],
		`const env = { ro: process.env.PI_SANDBOX_READONLY ?? null, sandbox: process.env.PI_SANDBOX ?? null };
		const message = { role: "assistant", content: [{ type: "text", text: JSON.stringify(env) }], stopReason: "stop" };
		console.log(JSON.stringify({ type: "message_end", message }));`,
	);
	const { agents } = discoverAgents(dir, "user");
	const envOf = async (name: string, env?: NodeJS.ProcessEnv) => {
		const r = await runSingleAgent(dir, {}, agents, name, "t", undefined, undefined, undefined, undefined, (results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }), env);
		const last = r.messages.at(-1) as any;
		return JSON.parse(last.content[0].text);
	};
	assert.equal((await envOf("reviewer")).ro, "1");
	assert.equal((await envOf("scout")).ro, null);
	const { PI_SANDBOX_READONLY: _, ...rest } = process.env;
	assert.deepEqual(await envOf("reviewer", { ...rest, PI_SANDBOX: "off" }), { ro: null, sandbox: "off" });
});

test("a chain runs each agent on its own model and hands the previous step's output to the next", async () => {
	freshAgentDir();
	// Stand-in for the `pi` the tool spawns: logs how it was called and answers with its task.
	const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
	const log = join(dir, "calls.jsonl");
	process.argv[1] = join(dir, "pi.mjs");
	writeFileSync(
		process.argv[1],
		`import { appendFileSync, readFileSync } from "node:fs";
		const args = process.argv.slice(2);
		const prompt = readFileSync(args[args.indexOf("--append-system-prompt") + 1], "utf8");
		appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt }) + "\\n");
		const message = { role: "assistant", content: [{ type: "text", text: "answer to " + args.at(-1) }], stopReason: "stop" };
		console.log(JSON.stringify({ type: "message_end", message }));`,
	);

	let tool: any;
	subagent({ registerTool: (def: any) => (tool = def) } as any);
	// The model sees each agent's description, so it can delegate without a workflow prompt.
	assert.match(tool.description, /\n- deep-worker: Delivers one logic-heavy goal/);
	const ctx = { cwd: dir, model: { provider: "router", id: "auto" }, hasUI: false };
	const chain = [
		{ agent: "scout", task: "find the router" },
		{ agent: "planner", task: "plan from {previous}" },
	];
	const updates: number[][] = [];
	const onUpdate = (u: any) => updates.push(u.details.results.map((r: any) => r.exitCode));
	const result = await tool.execute("call-1", { chain }, undefined, onUpdate, ctx);
	// A step still running is marked so (-1), not as already exited 0.
	assert.deepEqual(updates, [[-1], [0, -1]]);

	const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
	assert.deepEqual(
		calls.map(({ args }) => [flag(args, "--model"), flag(args, "--tools"), args.at(-1)]),
		[
			["pi-claude-cli/claude-haiku:high", "read,grep,find,ls,bash", "Task: find the router"],
			["pi-claude-cli/claude-opus:high", "read,grep,find,ls", "Task: plan from answer to Task: find the router"],
		],
	);
	assert.match(calls[0].prompt, /You are a scout/);
	assert.equal(result.content[0].text, "answer to Task: plan from answer to Task: find the router");
});

test("parallel output shares a 50 KB budget; a cut task's full output is in a file the notice names", async () => {
	freshAgentDir();
	const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
	process.argv[1] = join(dir, "pi.mjs");
	const answer = (task: string) => (task === "Task: t0" ? "short answer" : "answer to " + task + "x".repeat(20_000) + "END");
	writeFileSync(
		process.argv[1],
		`const task = process.argv.at(-1);
		const text = task === "Task: t0" ? "short answer" : "answer to " + task + "x".repeat(20_000) + "END";
		const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
		console.log(JSON.stringify({ type: "message_end", message }));`,
	);
	let tool: any;
	subagent({ registerTool: (def: any) => (tool = def) } as any);
	const tasks = Array.from({ length: 8 }, (_, i) => ({ agent: "scout", task: `t${i}` }));
	const ctx = { cwd: dir, model: undefined, hasUI: false };
	const text: string = (await tool.execute("call-1", { tasks }, undefined, undefined, ctx)).content[0].text;

	assert.ok(Buffer.byteLength(text) <= 50 * 1024 + 8 * 300, `${Buffer.byteLength(text)} bytes`);
	assert.doesNotMatch(text, /preserved in tool details/);
	const sections = text.split("\n\n---\n\n");
	assert.equal(sections.length, 8);
	assert.ok(sections[0]!.endsWith("\n\nshort answer"), sections[0]);
	for (const [i, section] of sections.entries()) {
		if (i === 0) continue;
		const notice = section.match(/\[Output truncated: \d+ bytes omitted\. Full output: (\S+)\]/);
		assert.ok(notice, `t${i} has no notice`);
		assert.equal(readFileSync(notice[1]!, "utf8"), answer(`Task: t${i}`));
		const kept = section.slice(section.indexOf("answer to"), section.indexOf("\n\n[Output truncated"));
		assert.ok(Buffer.byteLength(kept) > Math.floor(51200 / 8), `t${i} kept ${Buffer.byteLength(kept)} bytes`);
	}
});

test("collapsed, a subagent call shows which agents run, not their task text; ctrl+o shows it", () => {
	let tool: any;
	subagent({ registerTool: (def: any) => (tool = def) } as any);
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const shown = (args: any, expanded: boolean) => tool.renderCall(args, theme, { expanded }).render(400).join("\n").trim();
	const single = { agent: "worker", task: "Implement the plan in docs/plans/x.md" };
	assert.equal(shown(single, false), "subagent worker [user]");
	assert.match(shown(single, true), /Implement the plan/);
	const parallel = { tasks: [{ agent: "scout", task: "look at the router" }, { agent: "worker", task: "build step 2" }] };
	assert.doesNotMatch(shown(parallel, false), /router|step 2/);
	assert.match(shown(parallel, false), /scout[\s\S]*worker/);
	assert.match(shown({ chain: [{ agent: "planner", task: "plan it" }] }, true), /plan it/);
});

test("collapsed, a subagent result is one row per agent: its answer's first line, its current tool call, or waiting", () => {
	let tool: any;
	subagent({ registerTool: (def: any) => (tool = def) } as any);
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 };
	const agent = (name: string, exitCode: number, content: any[], extra = {}) => ({
		agent: name,
		agentSource: "user",
		task: `task for ${name}`,
		exitCode,
		messages: [{ role: "assistant", content }],
		stderr: "",
		usage,
		...extra,
	});
	const planner = agent("planner", 0, [{ type: "text", text: "\n## Plan: fix the chain header\n\nSteps follow." }]);
	const reviewing = agent("plan-reviewer", -1, [{ type: "toolCall", name: "grep", arguments: { pattern: "BeforeAgentStartEvent" } }]);
	const chain = { chain: ["planner", "plan-reviewer", "worker"].map((a) => ({ agent: a, task: "t" })) };
	const shown = (mode: string, results: any[], args: any, { expanded = false, isPartial = false, width = 200 } = {}) =>
		tool
			.renderResult({ content: [], details: { mode, agentScope: "user", projectAgentsDir: null, results } }, { expanded, isPartial }, theme, { args })
			.render(width)
			.map((l: string) => stripVTControlCharacters(l).trimEnd());

	assert.deepEqual(shown("chain", [planner, reviewing], chain, { isPartial: true }), [
		"⏳ chain 1/3 steps",
		"✓ planner → ## Plan: fix the chain header",
		"⏳ plan-reviewer  now: grep /BeforeAgentStartEvent/ in .",
		"· worker waiting",
		"Total: 2 turns $0.0200",
		"(Ctrl+O to expand)",
	]);
	const narrow = shown("chain", [planner, reviewing], chain, { isPartial: true, width: 20 });
	assert.equal(narrow.length, 6);
	assert.match(narrow[1]!, /^✓ planner → ## Pl.*…$/);

	const failed = agent("plan-reviewer", 1, [], { stopReason: "error", errorMessage: "rate limited" });
	const stopped = shown("chain", [planner, failed], chain).join("\n");
	assert.match(stopped, /^✗ chain 1\/3 steps$/m);
	assert.match(stopped, /^✗ plan-reviewer \[error\]$/m);
	assert.match(stopped, /^Error: rate limited$/m);
	assert.doesNotMatch(stopped, /waiting/);

	assert.deepEqual(shown("single", [agent("worker", 0, [{ type: "text", text: "Done." }])], { agent: "worker", task: "t" }), [
		"✓ worker → Done.",
		"1 turn $0.0100",
		"(Ctrl+O to expand)",
	]);

	const starting = agent("worker", -1, []);
	assert.deepEqual(shown("parallel", [planner, starting], {}, { isPartial: true }), [
		"⏳ parallel 1/2 done, 1 running",
		"✓ planner → ## Plan: fix the chain header",
		"⏳ worker  now: starting",
		"(Ctrl+O to expand)",
	]);

	const bash = agent("worker", -1, [{ type: "toolCall", name: "bash", arguments: { command: "cd x\nls\npwd" } }]);
	assert.deepEqual(shown("parallel", [bash], {}, { isPartial: true })[1], "⏳ worker  now: $ cd x ls pwd");
	const described = agent("worker", -1, [{ type: "toolCall", name: "bash", arguments: { command: "cd x && ls", description: "List files" } }]);
	assert.deepEqual(shown("parallel", [described], {}, { isPartial: true })[1], "⏳ worker  now: List files");
	const thinking = agent("plan-reviewer", -1, [
		{ type: "thinking", thinking: "**Checking the header**\n\nMore detail" },
		{ type: "toolCall", name: "grep", arguments: { pattern: "X" } },
	]);
	assert.deepEqual(shown("parallel", [thinking], {}, { isPartial: true })[1], "⏳ plan-reviewer  Checking the header · now: grep /X/ in .");

	// Expanded while running, parallel keeps its log preview.
	const checked = agent("planner", 0, [
		{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
		{ type: "text", text: "Checking the types." },
	]);
	const preview = shown("parallel", [checked, starting], {}, { expanded: true, isPartial: true }).join("\n");
	for (const part of ["─── planner ✓", "→ read a.ts", "Checking the types."]) assert.ok(preview.includes(part), part);
	assert.doesNotMatch(preview, /now:/);
});

test("an aborted subagent that ignores SIGTERM is killed with SIGKILL after 5s", { timeout: 15000 }, async () => {
	freshAgentDir();
	// Stand-in pi that traps SIGTERM and never exits on its own.
	const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
	const ready = join(dir, "ready");
	process.argv[1] = join(dir, "pi.mjs");
	writeFileSync(
		process.argv[1],
		`import { writeFileSync } from "node:fs";
		process.on("SIGTERM", () => {});
		writeFileSync(${JSON.stringify(ready)}, "");
		setInterval(() => {}, 1000);`,
	);
	let tool: any;
	subagent({ registerTool: (def: any) => (tool = def) } as any);
	const abort = new AbortController();
	const run = tool.execute("call-1", { agent: "scout", task: "hang" }, abort.signal, undefined, { cwd: dir, model: undefined, hasUI: false });
	while (!existsSync(ready)) await new Promise((r) => setTimeout(r, 50));
	abort.abort();
	await assert.rejects(run, /aborted/);
});
