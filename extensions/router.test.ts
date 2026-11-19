// Run: node --import ./extensions/test-hooks.ts --test extensions/router.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { PLAN_FIRST } from "./handoff.ts";
import router from "./router.ts";

const CATALOG = ["claude-sonnet-5-5", "claude-opus-4-5-20251101", "claude-opus-5", "claude-opus-5-5", "claude-fable-5-1"].map((id) => ({ provider: "pi-claude-cli", id }));

// A stand-in `claude` first on PATH. It reads the prompt from stdin, appends { pid, args, stdin } to
// $FAKE_ROUTER_RECORD, then acts on $FAKE_ROUTER: { answer }, { is_error }, { exit }, { raw } or { hang }.
const bin = mkdtempSync(join(tmpdir(), "fake-router-claude-"));
writeFileSync(
	join(bin, "claude"),
	`#!/usr/bin/env node
	const fs = require("node:fs");
	const fake = JSON.parse(process.env.FAKE_ROUTER);
	let stdin = "";
	process.stdin.on("data", (chunk) => (stdin += chunk));
	process.stdin.on("end", () => {
		// Installed before the record is written, so a recorded pid means it already ignores SIGTERM.
		if (fake.hang) process.on("SIGTERM", () => {});
		fs.appendFileSync(process.env.FAKE_ROUTER_RECORD, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), stdin }) + "\\n");
		if (fake.hang) return setInterval(() => {}, 1e6);
		if (fake.exit) process.exit(fake.exit);
		if ("raw" in fake) return process.stdout.write(fake.raw);
		if (fake.is_error) return process.stdout.write(JSON.stringify({ type: "result", is_error: true }));
		process.stdout.write(JSON.stringify({ type: "result", is_error: false, structured_output: fake.answer }));
	});`,
	{ mode: 0o755 },
);
process.env.PATH = bin + delimiter + process.env.PATH;

const answer = (tier: string, effort = "medium") => ({ answer: { tier, effort } });

function setup(fake: object, catalog = CATALOG) {
	const agentDir = mkdtempSync(join(tmpdir(), "router-test-"));
	const recordPath = join(agentDir, "record.jsonl");
	// Tests in one file run in sequence, so each setup can own the env vars.
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.FAKE_ROUTER_RECORD = recordPath;
	process.env.FAKE_ROUTER = JSON.stringify(fake);
	let route: any;
	const notices: string[] = [];
	const statuses: Record<string, string | undefined> = {};
	const routerStatuses: (string | undefined)[] = [];
	router({
		registerVirtualModel(def: any) {
			route = def.route;
		},
	} as any);
	const ctx: any = {
		hasUI: true,
		mode: "tui",
		sessionManager: { getSessionId: () => "session-1" },
		ui: {
			notify: (msg: string) => notices.push(msg),
			setStatus: (key: string, text?: string) => {
				statuses[key] = text;
				if (key === "router") routerStatuses.push(text);
			},
		},
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			getAll: () => catalog,
		},
	};
	const request = (state?: unknown, extra?: object) => ({
		reason: "user",
		thinkingLevel: "medium",
		state,
		messages: [{ role: "user", content: "Implement Dijkstra with a Fibonacci heap" }],
		...extra,
	});
	const records = () => (existsSync(recordPath) ? readFileSync(recordPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
	return {
		route: (state?: unknown, extra?: object) => route(request(state, extra), ctx),
		records,
		calls: () => records().length,
		prompts: () => records().map((r) => r.stdin),
		answer: (next: object) => {
			process.env.FAKE_ROUTER = JSON.stringify(next);
		},
		dataset: () => readFileSync(join(agentDir, "laya-dataset.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
		notices,
		statuses,
		routerStatuses,
	};
}

test("classifies the first request, then stays on the stored tier without classifying again", async () => {
	const s = setup(answer("deep"));
	const first = await s.route();
	assert.deepEqual([first.model.provider, first.model.id, first.state.tier], ["pi-claude-cli", "claude-fable-5-1", "deep"]);
	const next = await s.route(first.state);
	assert.equal(next.model.id, "claude-fable-5-1");
	assert.equal(next.state, first.state);
	assert.equal(s.calls(), 1);
	assert.equal(s.routerStatuses[0], "classifying…");
	assert.equal(s.statuses.router, "deep");
});

test("calls claude exactly as validated: prompt on stdin, `--tools \"\"`, no --bare", async () => {
	const s = setup(answer("standard"));
	await s.route();
	const [{ args, stdin }] = s.records();
	const schema = '{"type":"object","properties":{"tier":{"enum":["quick","standard","complex","deep"]},"effort":{"enum":["low","medium","high","xhigh"]}},"required":["tier","effort"]}';
	assert.deepEqual(args, ["-p", "--model", "haiku", "--output-format", "json", "--json-schema", schema, "--no-session-persistence", "--tools", "", "--setting-sources=", "--strict-mcp-config", "--disable-slash-commands", "--system-prompt", args.at(-1)]);
	assert.match(args.at(-1), /^You route a coding agent's user request to a model\./);
	assert.equal(stdin, "Implement Dijkstra with a Fibonacci heap");
});

test("classifies the user's message, not handoff's plan-first note sent after it", async () => {
	const s = setup(answer("deep"));
	const plan = { role: "user", content: [{ type: "text", text: PLAN_FIRST }] };
	await s.route(undefined, { messages: [{ role: "user", content: "fix the typo" }, plan] });
	assert.deepEqual(s.prompts(), ["fix the typo"]);
	assert.equal(s.dataset()[0].prompt, "fix the typo");
});

test("the classifier's effort sets the thinking level until the user picks another one", async () => {
	assert.equal((await setup(answer("complex", "low")).route()).thinkingLevel, "low");
	const s = setup(answer("complex", "high"));
	const first = await s.route();
	assert.equal(first.thinkingLevel, "high");
	assert.equal((await s.route(first.state)).thinkingLevel, "high");
	const picked = await s.route(first.state, { thinkingLevel: "low" });
	assert.equal(picked.thinkingLevel, "low");
	// Going back to the level the session started with keeps the user's choice, not the classifier's.
	assert.equal((await s.route(picked.state, { thinkingLevel: "medium" })).thinkingLevel, "medium");
});

test("the main session never runs on GPT: Opus by default, deep work and complex work rated xhigh on Fable at medium, for the whole session", async () => {
	const route = (tier: string, effort: string) => setup(answer(tier, effort)).route();
	const s = setup(answer("complex", "xhigh"));
	const first = await s.route();
	assert.deepEqual([first.model.id, first.thinkingLevel, s.statuses.router], ["claude-fable-5-1", "medium", "complex-high"]);
	// The user's own thinking level keeps the escalated model.
	const picked = await s.route(first.state, { thinkingLevel: "low" });
	assert.deepEqual([picked.model.id, picked.thinkingLevel], ["claude-fable-5-1", "low"]);
	assert.equal((await route("complex", "high")).model.id, "claude-opus-5-5");
	for (const effort of ["low", "xhigh"]) {
		const deep = await route("deep", effort);
		assert.deepEqual([deep.model.id, deep.thinkingLevel, deep.state.tier], ["claude-fable-5-1", "medium", "deep"]);
	}
	assert.equal((await route("standard", "low")).model.id, "claude-opus-5-5");
	const standard = await route("standard", "xhigh");
	assert.deepEqual([standard.model.id, standard.thinkingLevel], ["claude-opus-5-5", "xhigh"]);
});

test("a quick session runs on Sonnet at medium and classifies each new user message until another tier wins", async () => {
	const s = setup(answer("quick", "high"));
	const hi = [{ role: "user", content: "hi" }];
	const first = await s.route(undefined, { messages: hi });
	assert.deepEqual([first.model.id, first.thinkingLevel, first.state.tier], ["claude-sonnet-5-5", "medium", "quick"]);
	// Tool results inside the same turn stay on Sonnet without classifying.
	assert.equal((await s.route(first.state, { reason: "continuation", messages: hi })).state, first.state);
	assert.equal(s.calls(), 1);
	// The next user message is classified on its own; once it needs Opus the session stays there.
	s.answer(answer("standard"));
	const messages = [...hi, { role: "assistant", content: "Hi!" }, { role: "user", content: "fix the footer" }];
	const work = await s.route(first.state, { messages });
	assert.deepEqual([work.model.id, work.state.tier, s.prompts()[1]], ["claude-opus-5-5", "standard", "fix the footer"]);
	await s.route(work.state, { messages });
	assert.equal(s.calls(), 2);
	assert.deepEqual(s.dataset().map((line) => line.prompt), ["hi", "fix the footer"]);
});

test("a thinking level the user picked in a quick session survives reclassification", async () => {
	const s = setup(answer("quick", "high"));
	const first = await s.route();
	const picked = await s.route(first.state, { thinkingLevel: "low" });
	s.answer(answer("standard"));
	const work = await s.route(picked.state, { thinkingLevel: "low" });
	assert.deepEqual([work.model.id, work.thinkingLevel], ["claude-opus-5-5", "low"]);
});

test("each newly routed session logs one dataset line with the prompt and Haiku's answer", async () => {
	const s = setup(answer("standard", "high"));
	const first = await s.route();
	await s.route(first.state);
	const [line, ...rest] = s.dataset();
	assert.equal(rest.length, 0);
	assert.deepEqual(
		[line.session, line.mode, line.classifier, line.prompt, line.tier, line.effort, line.model, line.thinkingLevel],
		["session-1", "tui", "haiku", "Implement Dijkstra with a Fibonacci heap", "standard", "high", "pi-claude-cli/claude-opus-5-5", "high"],
	);
	assert.equal("probabilities" in line || "score" in line, false);
});

test("every way the classifier can fail falls back to Opus and tells the user once", async () => {
	const path = process.env.PATH;
	const empty = mkdtempSync(join(tmpdir(), "no-claude-"));
	const cases: [string, object][] = [
		["claude not on PATH", answer("deep")],
		["nonzero exit", { exit: 1 }],
		["is_error", { is_error: true }],
		["bad JSON", { raw: "oops" }],
		["answer outside the schema", { answer: { tier: "complex-high", effort: "low" } }],
	];
	for (const [name, fake] of cases) {
		const s = setup(fake);
		if (name === "claude not on PATH") process.env.PATH = empty;
		try {
			assert.equal((await s.route()).model.id, "claude-opus-5-5", name);
		} finally {
			process.env.PATH = path;
		}
		assert.equal(s.notices.length, 1, name);
		assert.equal(s.statuses.router, "complex?", name);
	}
});

test("aborting a classification SIGKILLs a claude that ignores SIGTERM", async (t) => {
	const s = setup({ hang: true });
	const controller = new AbortController();
	const routed = s.route(undefined, { signal: controller.signal });
	routed.catch(() => {});
	let pid: number | undefined;
	while (!(pid = s.records()[0]?.pid)) await new Promise((resolve) => setTimeout(resolve, 20));
	// A failed assert must not leave the hanging child behind.
	t.after(() => {
		try {
			process.kill(pid!, "SIGKILL");
		} catch {}
	});
	controller.abort();
	await assert.rejects(routed);
	assert.equal(s.statuses.router, undefined);
	const alive = () => {
		try {
			process.kill(pid!, 0);
			return true;
		} catch {
			return false;
		}
	};
	const deadline = Date.now() + 5000;
	while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(alive(), false);
});

test("a direct request stays on the session's model without classifying or warning", async () => {
	const s = setup(answer("deep"));
	const previous = { model: { provider: "openai", id: "gpt-6.1-sol" }, thinkingLevel: "high" };
	const routed = await s.route(undefined, { reason: "direct", previous });
	assert.deepEqual([routed.model.id, routed.thinkingLevel, routed.state], ["gpt-6.1-sol", "high", undefined]);
	assert.equal(s.calls(), 0);
	assert.equal(s.notices.length, 0);
});

test("a classification cancelled by the user stores no tier", async () => {
	const s = setup(answer("deep"));
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(s.route(undefined, { signal: controller.signal }));
	assert.equal(s.statuses.router, undefined);
});

test("the Opus tiers follow the newest Opus the provider lists", async () => {
	const catalog = [
		...CATALOG,
		{ provider: "pi-claude-cli", id: "claude-opus-6" },
		{ provider: "pi-claude-cli", id: "claude-sonnet-6" },
		{ provider: "pi-claude-cli", id: "claude-opus-4-20250514" }, // a dated snapshot, not version 4.20250514
		{ provider: "anthropic", id: "claude-opus-7" }, // another provider's catalog
	];
	const routed = await setup(answer("complex"), catalog).route();
	assert.deepEqual([routed.model.provider, routed.model.id], ["pi-claude-cli", "claude-opus-6"]);
	assert.equal((await setup(answer("standard"), catalog).route()).model.id, "claude-opus-6");
});
