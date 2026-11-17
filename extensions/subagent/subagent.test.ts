// Run: node --import ./extensions/test-hooks.ts --test extensions/subagent/subagent.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { discoverAgents } from "./agents.ts";
import subagent from "./index.ts";

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
		"deep-worker": "user openai/gpt-6.1-sol:medium",
		planner: "project project/model",
		"plan-reviewer": "user openai/gpt-6.1-sol:xhigh",
		reviewer: "user openai/gpt-6.1-sol:high",
		worker: "user pi-claude-cli/claude-opus:high",
	});
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

	// Expanded while running, parallel keeps its log preview.
	const checked = agent("planner", 0, [
		{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
		{ type: "text", text: "Checking the types." },
	]);
	const preview = shown("parallel", [checked, starting], {}, { expanded: true, isPartial: true }).join("\n");
	for (const part of ["─── planner ✓", "→ read a.ts", "Checking the types."]) assert.ok(preview.includes(part), part);
	assert.doesNotMatch(preview, /now:/);
});
