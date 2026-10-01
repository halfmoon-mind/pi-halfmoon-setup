// Run: node --test extensions/router.test.ts  (Node >= 22.18 strips the types)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import router from "./router.ts";

const CATALOG = ["claude-sonnet-5-5", "claude-opus-4-5-20251101", "claude-opus-5", "claude-opus-5-5", "claude-fable-5-1"].map((id) => ({ provider: "pi-claude-cli", id }));

function setup(answer: unknown | "missing", catalog = CATALOG, env: Record<string, string> = {}, effort?: unknown) {
	// A non-local laya URL keeps pi from starting laya-serve; the switch file goes to a fresh dir.
	Object.assign(process.env, { LAYA_URL: "http://laya.test/v1", ...env });
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "router-test-"));
	let route: any;
	let classifyCalls = 0;
	let classifyingStatus: string | undefined;
	const notices: string[] = [];
	const statuses: Record<string, string | undefined> = {};
	const commands: Record<string, any> = {};
	const handlers: Record<string, any> = {};
	const pi: any = {
		registerProvider() {},
		registerVirtualModel(def: any) {
			route = def.route;
		},
		registerCommand(name: string, def: any) {
			commands[name] = def;
		},
		on(event: string, handler: any) {
			handlers[event] = handler;
		},
	};
	router(pi);
	const ctx: any = {
		hasUI: true,
		ui: {
			notify: (msg: string) => notices.push(msg),
			setStatus: (key: string, text?: string) => {
				statuses[key] = text;
			},
		},
		modelRegistry: {
			findOfType: () => (answer === "missing" ? undefined : { id: "jev-latest" }),
			classify: async () => {
				classifyCalls++;
				classifyingStatus = statuses.router;
				return { stopReason: "stop", answers: { tier: answer, effort } };
			},
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
	return {
		route: (state?: unknown, extra?: object) => route(request(state, extra), ctx),
		laya: (args: string) => commands.laya.handler(args, ctx),
		sessionStart: () => handlers.session_start({}, ctx),
		calls: () => classifyCalls,
		classifyingStatus: () => classifyingStatus,
		notices,
		statuses,
	};
}

const choice = (choice: string, p: number) => ({ type: "choice", choice, probabilities: { [choice]: p } });

test("classifies the first request, then stays on the stored tier without classifying again", async () => {
	const s = setup(choice("deep", 0.56));
	const first = await s.route();
	assert.deepEqual([first.model.provider, first.model.id, first.state.tier], ["pi-claude-cli", "claude-opus-5-5", "deep"]);
	const next = await s.route(first.state);
	assert.equal(next.model.id, "claude-opus-5-5");
	assert.equal(next.state, first.state);
	assert.equal(s.calls(), 1);
	assert.equal(s.classifyingStatus(), "classifying…");
	assert.equal(s.statuses.router, "deep 56%");
});

test("Laya's effort score sets the thinking level until the user picks another one", async () => {
	const score = (score: number) => ({ type: "score", score, confidence: 0.25 });
	assert.equal((await setup(choice("deep", 0.9), CATALOG, {}, score(0.18)).route()).thinkingLevel, "low");
	const s = setup(choice("deep", 0.9), CATALOG, {}, score(1.9));
	const first = await s.route();
	assert.equal(first.thinkingLevel, "high");
	assert.equal((await s.route(first.state)).thinkingLevel, "high");
	const picked = await s.route(first.state, { thinkingLevel: "low" });
	assert.equal(picked.thinkingLevel, "low");
	// Going back to the level the session started with keeps the user's choice, not Laya's.
	assert.equal((await s.route(picked.state, { thinkingLevel: "medium" })).thinkingLevel, "medium");
	// No effort answer: the user's level stands.
	assert.equal((await setup(choice("deep", 0.9)).route()).thinkingLevel, "medium");
});

test("only work rated xhigh leaves Opus or Sonnet: design climbs to Fable, logic to GPT-6 Astra, for the whole session", async () => {
	const score = (score: number) => ({ type: "score", score, confidence: 0.25 });
	const route = (tier: string, effort: number) => setup(choice(tier, 0.9), CATALOG, {}, score(effort)).route();
	const s = setup(choice("deep", 0.9), CATALOG, {}, score(2.2));
	const first = await s.route();
	assert.deepEqual([first.model.id, first.thinkingLevel, s.statuses.router], ["gpt-6-astra", "xhigh", "deep-high 90%"]);
	// The user's own thinking level keeps the escalated model.
	assert.equal((await s.route(first.state, { thinkingLevel: "low" })).model.id, "gpt-6-astra");
	assert.equal((await route("complex", 2.2)).model.id, "claude-fable-5-1");
	assert.equal((await route("deep", 2.1)).model.id, "claude-opus-5-5");
	assert.equal((await route("standard", 2.2)).model.id, "claude-sonnet-5-5");
});

test("a near-tie routes to the fallback tier instead of the top choice", async () => {
	const s = setup(choice("standard", 0.36));
	assert.equal((await s.route()).model.id, "claude-opus-5-5");
	assert.equal(s.statuses.router, "complex? 36%");
});

test("a missing classifier falls back and tells the user", async () => {
	const s = setup("missing");
	assert.equal((await s.route()).model.id, "claude-opus-5-5");
	assert.equal(s.notices.length, 1);
	assert.equal(s.statuses.router, "complex?");
});

test("a direct request stays on the session's model without classifying or warning", async () => {
	const s = setup(choice("deep", 0.56));
	const previous = { model: { provider: "openai", id: "gpt-6.1-sol" }, thinkingLevel: "high" };
	const routed = await s.route(undefined, { reason: "direct", previous });
	assert.deepEqual([routed.model.id, routed.thinkingLevel, routed.state], ["gpt-6.1-sol", "high", undefined]);
	assert.equal(s.calls(), 0);
	assert.equal(s.notices.length, 0);
});

test("a classification cancelled by the user stores no tier", async () => {
	const s = setup(choice("deep", 0.56));
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(s.route(undefined, { signal: controller.signal }));
	assert.equal(s.statuses.router, undefined);
});

test("the complex and standard tiers follow the newest Opus and Sonnet the provider lists", async () => {
	const catalog = [
		...CATALOG,
		{ provider: "pi-claude-cli", id: "claude-opus-6" },
		{ provider: "pi-claude-cli", id: "claude-sonnet-6" },
		{ provider: "pi-claude-cli", id: "claude-opus-4-20250514" }, // a dated snapshot, not version 4.20250514
		{ provider: "anthropic", id: "claude-opus-7" }, // another provider's catalog
	];
	const routed = await setup(choice("complex", 0.9), catalog).route();
	assert.deepEqual([routed.model.provider, routed.model.id], ["pi-claude-cli", "claude-opus-6"]);
	assert.equal((await setup(choice("standard", 0.9), catalog).route()).model.id, "claude-sonnet-6");
});

test("without laya-serve installed, router/auto still answers and explains the fix once", async () => {
	// Port 9 on loopback refuses at once, so laya looks down and pi tries to start a missing binary.
	// "missing": with laya down the classifier cannot answer, as in a real pi.
	const s = setup("missing", CATALOG, { LAYA_URL: "http://127.0.0.1:9/v1", LAYA_SERVE_BIN: "/nonexistent/laya-serve" });
	s.sessionStart();
	for (let session = 0; session < 3; session++) assert.equal((await s.route()).model.id, "claude-opus-5-5");
	assert.equal(s.notices.length, 1);
	assert.match(s.notices[0], /pip install "laya\[serve\]".*LAYA_SERVE_BIN.*\/laya off/);
});

test("/laya off routes to the newest Opus without classifying or warning; /laya on classifies again", async () => {
	const s = setup(choice("standard", 0.9));
	await s.laya("off");
	const routed = await s.route();
	assert.deepEqual([routed.model.id, routed.state.tier, routed.state.unclassified], ["claude-opus-5-5", "complex", undefined]);
	assert.equal(s.statuses.router, "complex");
	assert.equal(s.calls(), 0);
	assert.deepEqual(s.notices, ["laya off: router/auto uses pi-claude-cli/claude-opus-5-5 without classifying"]);
	await s.laya("on");
	assert.equal((await s.route()).model.id, "claude-sonnet-5-5");
	assert.equal(s.calls(), 1);
});

test("a process started with spawnWithLifeline does not outlive a SIGKILLed parent", async () => {
	// Stand-in for pi: starts `sleep` the way pi starts laya-serve, prints its pid, then idles.
	const routerUrl = JSON.stringify(new URL("./router.ts", import.meta.url).href);
	const parent = spawn(
		process.execPath,
		["--input-type=module", "-e", `import { spawnWithLifeline } from ${routerUrl};
			console.log(spawnWithLifeline("sleep", ["300"], process.env).pid); setInterval(() => {}, 1e6);`],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	const pid = Number(String(await new Promise((resolve) => parent.stdout.once("data", resolve))));
	// kill(pid, 0) also succeeds on a zombie, so "not alive" means neither running nor a zombie.
	const alive = () => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	assert.ok(alive());
	parent.kill("SIGKILL");
	const deadline = Date.now() + 5000;
	while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(alive(), false);
});
