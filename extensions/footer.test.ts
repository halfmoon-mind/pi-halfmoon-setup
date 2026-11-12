// Run: node --import ./extensions/test-hooks.ts --test extensions/footer.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import footer from "./footer.ts";

// No real Codex CLI login, so the footer never calls chatgpt.com from a test.
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "footer-codex-"));
// Nor a Claude Code login: this dir's keychain item does not exist, nor its credentials file.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "footer-claude-"));

const usage = (input: number, cacheRead: number, cost: number) => ({ input, output: 100, cacheRead, cacheWrite: 0, cost: { total: cost } });
const assistant = (provider: string, model: string, u: object, extra: object = {}) => ({
	type: "message",
	message: { role: "assistant", provider, model, usage: u, stopReason: "stop", thinkingLevel: "medium", ...extra },
});

function renderFooter(model: object, entries: object[], statuses: Record<string, string>, width = 120, { autoCompact = true, cwd = `${homedir()}/projects/app` } = {}) {
	let factory: any;
	const handlers: Record<string, any> = {};
	footer({ on: (event: string, handler: any) => (handlers[event] = handler), getSettings: () => ({ compaction: { enabled: autoCompact } }) } as any);
	handlers.session_start({}, {
		mode: "tui",
		model,
		thinkingLevel: "medium",
		ui: { setFooter: (f: any) => (factory = f) },
		getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
		sessionManager: {
			getCwd: () => cwd,
			getSessionName: () => "fix login",
			getLeafId: () => "leaf",
			getEntries: () => entries,
			getBranch: () => entries,
		},
	});
	const theme = { fg: (_color: string, text: string) => text };
	const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(Object.entries(statuses)) };
	let rendered = () => {};
	const component = factory({ requestRender: () => rendered() }, theme, footerData);
	const render = () => component.render(width).map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/ {2,}/g, " | "));
	// Resolves with the lines rendered after the next requestRender, as when `git status` finishes.
	const rerendered = () => new Promise<string[]>((resolve) => (rendered = () => resolve(render())));
	return Object.assign(render(), { rerendered });
}

test("under router/auto: tier leads the routed model, its thinking level once, and the cost counts subagents and subscriptions", () => {
	const lines = renderFooter({ provider: "router", id: "auto", api: "pi-virtual", reasoning: true }, [
		assistant("openai", "gpt-6.1-sol", usage(1000, 0, 0.5)),
		{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { results: [{ usage: { cost: 0.25 } }] } } },
		{ type: "custom", customType: "review-gate", data: { usage: { cost: 0.125 } } },
		assistant("pi-claude-cli", "claude-opus-5-5", usage(1000, 3000, 2)),
		assistant("pi-claude-cli", "claude-opus-5-5", usage(9000, 0, 1), { stopReason: "aborted" }),
	], { router: "complex 82%", laya: "laya starting", claude: "claude 5h 3% · 7d 64%" });
	assert.deepEqual([...lines], [
		"~/projects/app (main) • fix login | claude 5h 3% · 7d 64% · laya starting",
		"CH75% $3.875 ━━━━━━━━── 80%/100k (auto) | complex 82% → claude-opus-5-5 • medium",
	]);
});

test("a physical model shows by itself, and a narrow footer cuts the model before the stats", () => {
	const lines = renderFooter({ provider: "openai", id: "gpt-6.1-sol", api: "openai-responses", reasoning: false }, [], {}, 30, { autoCompact: false });
	assert.deepEqual([...lines], ["~/projects/app (main) • fix...", "━━━━━━━━── 80%/100k | gpt-6.1-s"]);
});

test("uncommitted changes mark the branch", async () => {
	const repo = mkdtempSync(join(tmpdir(), "footer-git-"));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	writeFileSync(join(repo, "new.txt"), "");
	const lines = renderFooter({ provider: "openai", id: "gpt-6.1-sol" }, [], {}, 120, { cwd: repo });
	assert.match((await lines.rerendered())[0], /\(main\*\) • fix login$/);
});

test("the ChatGPT subscription's usage, read with Codex CLI's login, shows once a prompt ends", async () => {
	const handlers: Record<string, any> = {};
	footer({ on: (event: string, handler: any) => (handlers[event] = handler) } as any);
	writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { access_token: "tok", account_id: "acct" } }));
	const fetch = globalThis.fetch;
	let headers: any;
	globalThis.fetch = (async (_url: string, init: any) => {
		headers = init.headers;
		const window = (used_percent: number, limit_window_seconds: number) => ({ used_percent, limit_window_seconds, reset_after_seconds: 1, reset_at: 1791048682 });
		return Response.json({ rate_limit: { primary_window: window(12, 18_000), secondary_window: window(85, 604_800) } });
	}) as any;
	const status = new Promise((resolve) => {
		const ctx = { mode: "tui", ui: { theme: { fg: (_color: string, text: string) => `<${text}>` }, setStatus: (key: string, text?: string) => key === "gpt" && resolve(text) } };
		handlers.agent_end({}, ctx);
	});
	try {
		assert.match(String(await status), /^<gpt 5h 12% · 7d 85% ↻\S+ \d\d:\d\d>$/);
	} finally {
		globalThis.fetch = fetch;
	}
	assert.deepEqual(headers, { Authorization: "Bearer tok", "ChatGPT-Account-Id": "acct" });
});

test("the Claude subscription's usage, read with Claude Code's login, shows when the session starts", async () => {
	const handlers: Record<string, any> = {};
	footer({ on: (event: string, handler: any) => (handlers[event] = handler) } as any);
	writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "ctok" } }));
	const fetch = globalThis.fetch;
	let headers: any;
	globalThis.fetch = (async (url: string, init: any) => {
		if (!url.includes("anthropic")) return new Response(null, { status: 401 });
		headers = init.headers;
		// Seen: no 5h window while it is unused.
		return Response.json({}, { headers: { "anthropic-ratelimit-unified-7d-utilization": "0.17", "anthropic-ratelimit-unified-7d-reset": "1794607200" } });
	}) as any;
	const status = new Promise((resolve) => {
		const ctx = { mode: "tui", ui: { theme: { fg: (_color: string, text: string) => `<${text}>` }, setStatus: (key: string, text?: string) => key === "claude" && resolve(text), setFooter: () => {} } };
		handlers.session_start({}, ctx);
	});
	try {
		assert.equal(await status, "claude 7d 17%");
	} finally {
		globalThis.fetch = fetch;
	}
	assert.equal(headers.Authorization, "Bearer ctok");
});

test("before router/auto's first route, the footer says the model is still to be picked, without a thinking level", () => {
	const lines = renderFooter({ id: "auto", api: "pi-virtual", reasoning: true }, [], {});
	assert.equal(lines[1], "━━━━━━━━── 80%/100k (auto) | auto (picks on first message)");
});

test("usage that cannot be read shows as `?` when the session starts", async () => {
	const handlers: Record<string, any> = {};
	footer({ on: (event: string, handler: any) => (handlers[event] = handler) } as any);
	writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { access_token: "tok", account_id: "acct" } }));
	writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "ctok" } }));
	const fetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(null, { status: 429 })) as any;
	const statuses: Record<string, string> = {};
	try {
		await new Promise<void>((resolve) => {
			const setStatus = (key: string, text: string) => (statuses[key] = text) && Object.keys(statuses).length === 2 && resolve();
			handlers.session_start({}, { mode: "tui", ui: { theme: { fg: (_c: string, t: string) => t }, setStatus, setFooter: () => {} } });
		});
	} finally {
		globalThis.fetch = fetch;
	}
	assert.deepEqual(statuses, { gpt: "gpt ?", claude: "claude ?" });
});
