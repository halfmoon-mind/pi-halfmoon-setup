// Run: node --test extensions/router.test.ts  (Node >= 22.18 strips the types)
import assert from "node:assert/strict";
import { test } from "node:test";
import router from "./router.ts";

function setup(answer: unknown | "missing") {
	let route: any;
	let classifyCalls = 0;
	const notices: string[] = [];
	const pi: any = {
		registerProvider() {},
		registerVirtualModel(def: any) {
			route = def.route;
		},
	};
	router(pi);
	const ctx: any = {
		hasUI: true,
		ui: { notify: (msg: string) => notices.push(msg) },
		modelRegistry: {
			findOfType: () => (answer === "missing" ? undefined : { id: "jev-latest" }),
			classify: async () => {
				classifyCalls++;
				return { stopReason: "stop", answers: { tier: answer } };
			},
			find: (provider: string, id: string) => ({ provider, id }),
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
		calls: () => classifyCalls,
		notices,
	};
}

const choice = (choice: string, p: number) => ({ type: "choice", choice, probabilities: { [choice]: p } });

test("classifies the first request, then stays on the stored tier without classifying again", async () => {
	const s = setup(choice("deep", 0.56));
	const first = await s.route();
	assert.deepEqual([first.model.provider, first.model.id, first.state.tier], ["openai", "gpt-6.1-sol", "deep"]);
	const next = await s.route(first.state);
	assert.equal(next.model.id, "gpt-6.1-sol");
	assert.equal(next.state, first.state);
	assert.equal(s.calls(), 1);
});

test("a near-tie routes to the fallback tier instead of the top choice", async () => {
	const s = setup(choice("standard", 0.36));
	assert.equal((await s.route()).model.id, "claude-opus-5-5");
});

test("a missing classifier falls back and tells the user", async () => {
	const s = setup("missing");
	assert.equal((await s.route()).model.id, "claude-opus-5-5");
	assert.equal(s.notices.length, 1);
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
});
