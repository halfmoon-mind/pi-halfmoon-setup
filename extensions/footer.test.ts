// Run: node --import ./extensions/test-hooks.ts --test extensions/footer.test.ts
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import footer from "./footer.ts";

const usage = (input: number, cacheRead: number, cost: number) => ({ input, output: 100, cacheRead, cacheWrite: 0, cost: { total: cost } });
const assistant = (provider: string, model: string, u: object, extra: object = {}) => ({
	type: "message",
	message: { role: "assistant", provider, model, usage: u, stopReason: "stop", thinkingLevel: "medium", ...extra },
});

function renderFooter(model: object, entries: object[], statuses: Record<string, string>, width = 120) {
	let factory: any;
	const handlers: Record<string, any> = {};
	footer({ on: (event: string, handler: any) => (handlers[event] = handler) } as any);
	handlers.session_start({}, {
		mode: "tui",
		model,
		thinkingLevel: "medium",
		ui: { setFooter: (f: any) => (factory = f) },
		getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
		sessionManager: {
			getCwd: () => `${homedir()}/projects/app`,
			getSessionName: () => "fix login",
			getLeafId: () => "leaf",
			getEntries: () => entries,
			getBranch: () => entries,
		},
	});
	const theme = { fg: (_color: string, text: string) => text };
	const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(Object.entries(statuses)) };
	return factory(undefined, theme, footerData).render(width).map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/ {2,}/g, " | "));
}

test("under router/auto: tier leads the routed model, its thinking level once, subscription cost left out", () => {
	const lines = renderFooter({ provider: "router", id: "auto", api: "pi-virtual", reasoning: true }, [
		assistant("openai", "gpt-6.1-sol", usage(1000, 0, 0.5)),
		assistant("pi-claude-cli", "claude-opus-5-5", usage(1000, 3000, 2)),
		assistant("pi-claude-cli", "claude-opus-5-5", usage(9000, 0, 1), { stopReason: "aborted" }),
	], { router: "complex", laya: "laya starting" });
	assert.deepEqual(lines, [
		"~/projects/app (main) • fix login | laya starting",
		"↑11k ↓300 CH75% $0.500 ━━━━━━━━── 80%/100k | complex → claude-opus-5-5 • medium",
	]);
});

test("a physical model shows by itself, and a narrow footer cuts the model before the stats", () => {
	const lines = renderFooter({ provider: "openai", id: "gpt-6.1-sol", api: "openai-responses", reasoning: false }, [], {}, 30);
	assert.deepEqual(lines, ["~/projects/app (main) • fix...", "━━━━━━━━── 80%/100k | gpt-6.1-s"]);
});
