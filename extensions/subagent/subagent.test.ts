// Run: node --import ./extensions/test-hooks.ts --test extensions/subagent/subagent.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
		planner: "project project/model",
		"plan-reviewer": "user openai/gpt-6-astra:xhigh",
		reviewer: "user openai/gpt-6-astra:high",
		worker: "user router/auto",
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
	const ctx = { cwd: dir, model: { provider: "router", id: "auto" }, hasUI: false };
	const chain = [
		{ agent: "scout", task: "find the router" },
		{ agent: "planner", task: "plan from {previous}" },
	];
	const result = await tool.execute("call-1", { chain }, undefined, undefined, ctx);

	const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
	assert.deepEqual(
		calls.map(({ args }) => [flag(args, "--model"), flag(args, "--tools"), args.at(-1)]),
		[
			["pi-claude-cli/claude-haiku", "read,grep,find,ls,bash", "Task: find the router"],
			["pi-claude-cli/claude-opus:high", "read,grep,find,ls", "Task: plan from answer to Task: find the router"],
		],
	);
	assert.match(calls[0].prompt, /You are a scout/);
	assert.equal(result.content[0].text, "answer to Task: plan from answer to Task: find the router");
});
