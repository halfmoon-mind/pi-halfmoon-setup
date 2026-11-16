// Run: node --import ./extensions/test-hooks.ts --test extensions/handoff.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import handoff, { activePlan, forcedReason, ignorePlans, signals, steps } from "./handoff.ts";

test("signals count compactions, failed tool calls and review BLOCKs; a full or compacted session must hand off", () => {
	const branch = [
		{ type: "message", message: { role: "toolResult", isError: true } },
		{ type: "message", message: { role: "toolResult", isError: false } },
		{ type: "custom", customType: "review-gate", data: { verdict: "BLOCK: off by one" } },
		{ type: "custom", customType: "review-gate", data: { verdict: "ALLOW: fine" } },
	];
	const s = signals(branch, 20);
	assert.deepEqual(s, { percent: 20, compactions: 0, toolErrors: 1, blocks: 1 });
	assert.equal(forcedReason(s), undefined, "errors and BLOCKs alone are the model's call");
	assert.match(forcedReason(signals(branch, 50))!, /50% full/);
	assert.match(forcedReason(signals([...branch, { type: "compaction" }], null))!, /compacted 1/);
	assert.equal(activePlan([{ type: "custom", customType: "handoff-plan", data: { path: "a.md" } }, { type: "custom", customType: "handoff-plan", data: { path: "b.md" } }]), "b.md");
});

test("handoff stays in a clean session, and opens a new session with the plan when the context is full", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "handoff-"));
	mkdirSync(join(cwd, "docs/plans"), { recursive: true });
	writeFileSync(join(cwd, "docs/plans/x.md"), "- [ ] 1. do it\n");

	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const tools: Record<string, any> = {};
	const entries: any[] = [];
	const sent: string[] = [];
	const pi = {
		on: (event: string, handler: any) => (handlers[event] = handler),
		registerCommand: (name: string, def: any) => (commands[name] = def),
		registerTool: (def: any) => (tools[def.name] = def),
		appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
		sendUserMessage: (text: string) => sent.push(text),
	};
	handoff(pi as any);

	const ask = (mode: string, prompt: string, messageType = "user") => handlers.before_agent_start({ messageType, prompt }, { mode });
	assert.equal(ask("json", "add a theme option"), undefined, "a subagent's pi never gets the plan-first note");
	handlers.session_start({}, { mode: "json" });
	assert.equal(tools.handoff, undefined, "or the tool");
	handlers.session_start({}, { mode: "tui", cwd });
	assert.match(ask("tui", "add a theme option").message.content, /^Before you edit code/);
	assert.equal(ask("tui", "Implement the plan in docs/plans/x.md. ..."), undefined, "a handoff kickoff already has its plan");
	assert.equal(ask("tui", "", "custom"), undefined, "nor a review-gate continuation");

	let percent = 10;
	const ctx = { cwd, sessionManager: { getBranch: () => [] }, getContextUsage: () => ({ percent }) };
	await assert.rejects(tools.handoff.execute("1", { plan: "docs/plans/none.md" }, undefined, undefined, ctx), /no plan file/);

	const stay = await tools.handoff.execute("1", { plan: "docs/plans/x.md" }, undefined, undefined, ctx);
	assert.equal(stay.terminate, undefined);
	assert.match(stay.content[0].text, /Continue in this session[\s\S]*1 plan step\(s\) left[\s\S]*worker subagent[\s\S]*compacted[\s\S]*fresh worker/);
	handlers.agent_settled({ aborted: false });
	assert.deepEqual(sent, []);

	percent = 60;
	const leave = await tools.handoff.execute("1", { plan: "docs/plans/x.md" }, undefined, undefined, ctx);
	assert.equal(leave.terminate, true);
	assert.match(leave.content[0].text, /60% full/);
	handlers.agent_settled({ aborted: false });
	assert.deepEqual(sent, ["/handoff docs/plans/x.md"]);
	handlers.agent_settled({ aborted: false });
	assert.equal(sent.length, 1, "one handoff per request");
	await tools.handoff.execute("1", { plan: "docs/plans/x.md" }, undefined, undefined, ctx);
	handlers.agent_settled({ aborted: true });
	handlers.agent_settled({ aborted: false });
	assert.equal(sent.length, 1, "Esc drops the handoff for good");
	assert.equal(entries.length, 3);
	assert.deepEqual(entries[0], { customType: "handoff-plan", data: { path: "docs/plans/x.md" } });

	// The command opens the new session with the plan recorded and the kickoff as its first message.
	const newEntries: any[] = [];
	const kicked: string[] = [];
	let parent: string | undefined;
	const notices: string[] = [];
	const cmdCtx = {
		cwd,
		ui: { notify: (msg: string) => notices.push(msg) },
		sessionManager: { getSessionFile: () => "/sessions/old.jsonl" },
		newSession: async (opts: any) => {
			parent = opts.parentSession;
			await opts.setup({ appendCustomEntry: (customType: string, data: any) => newEntries.push({ customType, data }) });
			await opts.withSession({ sendUserMessage: async (text: string) => kicked.push(text) });
		},
	};
	await commands.handoff.handler("docs/plans/x.md", cmdCtx);
	assert.equal(parent, "/sessions/old.jsonl");
	assert.deepEqual(newEntries, [{ customType: "handoff-plan", data: { path: "docs/plans/x.md" } }]);
	assert.match(kicked[0], /^Implement the plan in docs\/plans\/x\.md\.[\s\S]*success criteria/);

	await commands.handoff.handler("docs/plans/none.md", cmdCtx);
	assert.match(notices[0], /usage: \/handoff/);
	assert.equal(kicked.length, 1);
});

test("steps counts a plan's ticked and open checkboxes", () => {
	const cwd = mkdtempSync(join(tmpdir(), "handoff-steps-"));
	writeFileSync(join(cwd, "p.md"), "- [x] 1. a\n  - [X] 2. b\n- [ ] 3. c\n* [ ] 4. d\nnot - [ ] a step\n");
	assert.deepEqual(steps(cwd, "p.md"), { done: 2, open: 2 });
	assert.equal(steps(cwd, "gone.md"), undefined);
});

test("plan files stay out of git through the repo's own exclude file, added once", () => {
	const repo = mkdtempSync(join(tmpdir(), "handoff-git-"));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	mkdirSync(join(repo, "docs/plans"), { recursive: true });
	writeFileSync(join(repo, "docs/plans/x.md"), "plan\n");
	const status = () => execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: repo, encoding: "utf8" });
	assert.match(status(), /docs\/plans\/x\.md/);
	ignorePlans(repo);
	ignorePlans(repo);
	assert.equal(status(), "");
	assert.equal(readFileSync(join(repo, ".git/info/exclude"), "utf8").match(/docs\/plans\//g)?.length, 1);
	assert.match(readFileSync(join(repo, ".git/info/exclude"), "utf8"), /^\/docs\/plans\/$/m);

	// Started below the root, the pattern names that directory's plans from the root.
	const sub = join(repo, "pkg [a]");
	mkdirSync(join(sub, "docs/plans"), { recursive: true });
	writeFileSync(join(sub, "docs/plans/y.md"), "plan\n");
	assert.match(status(), /pkg \[a\]\/docs\/plans\/y\.md/);
	ignorePlans(sub);
	assert.equal(status(), "");
	ignorePlans(mkdtempSync(join(tmpdir(), "handoff-nogit-"))); // outside a repository it does nothing
});
