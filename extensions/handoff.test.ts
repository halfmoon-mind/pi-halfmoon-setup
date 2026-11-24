// Run: node --import ./extensions/test-hooks.ts --test extensions/handoff.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import handoff, { activePlan, forcedReason, ignorePlans, reviewed, signals, steps } from "./handoff.ts";

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

test("reviewed needs a successful plan-reviewer run, or a plan this session already has", () => {
	const run = (results: any, toolName = "subagent") => [{ type: "message", message: { role: "toolResult", toolName, isError: false, details: results === undefined ? {} : { results } } }];
	const ok = { agent: "plan-reviewer", exitCode: 0, stopReason: "stop" };
	const p = "docs/plans/x.md";
	assert.equal(reviewed(run([ok]), p), true);
	assert.equal(reviewed(run([{ agent: "planner", exitCode: 1, stopReason: "error" }, ok]), p), true, "beside a failed planner in a parallel batch");
	assert.equal(reviewed(run(undefined), p), false, "no results");
	assert.equal(reviewed(run([]), p), false, "empty results");
	assert.equal(reviewed(run([{ agent: "planner", exitCode: 0, stopReason: "stop" }]), p), false, "only a planner");
	assert.equal(reviewed(run([{ ...ok, exitCode: 1 }]), p), false, "exit code 1");
	assert.equal(reviewed(run([{ ...ok, stopReason: "error" }]), p), false, "stopReason error");
	assert.equal(reviewed(run([{ ...ok, stopReason: "aborted" }]), p), false, "stopReason aborted");
	assert.equal(reviewed(run([ok], "bash"), p), false, "another tool");
	const accepted = [{ type: "custom", customType: "handoff-plan", data: { path: p } }];
	assert.equal(reviewed(accepted, p), true);
	assert.equal(reviewed(accepted, "docs/plans/y.md"), false);
});

test("handoff stays in a clean session, and opens a new session with the plan when the context is full", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "handoff-"));
	mkdirSync(join(cwd, "docs/plans"), { recursive: true });
	writeFileSync(join(cwd, "docs/plans/x.md"), "- [ ] 1. do it - files: a.ts (new) - check: `true`\n\n## Success criteria\n- `true`\n");

	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const tools: Record<string, any> = {};
	const entries: any[] = [];
	const sent: string[] = [];
	let branch: any[] = [];
	const pi = {
		on: (event: string, handler: any) => (handlers[event] = handler),
		registerCommand: (name: string, def: any) => (commands[name] = def),
		registerTool: (def: any) => (tools[def.name] = def),
		// As the real API does, an appended entry is on the branch at once.
		appendEntry: (customType: string, data: any) => (entries.push({ customType, data }), branch.push({ type: "custom", customType, data })),
		sendUserMessage: (text: string) => sent.push(text),
	};
	handoff(pi as any);

	const ask = (mode: string, prompt: string, messageType = "user") => handlers.before_agent_start({ messageType, prompt }, { mode, sessionManager: { getBranch: () => branch } });
	assert.equal(ask("json", "add a theme option"), undefined, "a subagent's pi never gets the plan-first note");
	handlers.session_start({}, { mode: "json" });
	assert.equal(tools.handoff, undefined, "or the tool");
	handlers.session_start({}, { mode: "tui", cwd });
	assert.match(ask("tui", "add a theme option").message.content, /^Before you edit code/);
	assert.equal(ask("tui", "Implement the plan in docs/plans/x.md. ..."), undefined, "a handoff kickoff already has its plan");
	assert.deepEqual(entries, [{ customType: "handoff-plan", data: { path: "docs/plans/x.md" } }], "and records it");
	ask("tui", "Implement the plan in docs/plans/x.md. ...");
	assert.equal(entries.length, 1, "once");
	assert.equal(ask("tui", "", "custom"), undefined, "nor a review-gate continuation");
	entries.length = 0;
	branch = [];

	let percent = 10;
	const ctx = { cwd, sessionManager: { getBranch: () => branch }, getContextUsage: () => ({ percent }) };
	await assert.rejects(tools.handoff.execute("1", { plan: "docs/plans/none.md" }, undefined, undefined, ctx), /no plan file/);
	await assert.rejects(tools.handoff.execute("1", { plan: "docs/plans/x.md" }, undefined, undefined, ctx), /plan-reviewer/);
	assert.equal(entries.length, 0);
	branch = [{ type: "message", message: { role: "toolResult", toolCallId: "r1", toolName: "subagent", isError: false, details: { results: [{ agent: "plan-reviewer", exitCode: 0, stopReason: "stop" }] } } }];

	const stay = await tools.handoff.execute("1", { plan: "docs/plans/x.md" }, undefined, undefined, ctx);
	assert.equal(stay.terminate, undefined);
	assert.match(stay.content[0].text, /Continue in this session[\s\S]*1 plan step\(s\) left[\s\S]*worker subagent[\s\S]*compacted[\s\S]*fresh worker/);
	assert.doesNotMatch(stay.content[0].text, /do it/, "the worker instruction keeps only the kickoff's first line");
	assert.match(stay.content[0].text, /Stop before a step tagged \(parallel[\s\S]*run that group here[\s\S]*`tasks` array[\s\S]*not to edit the plan file[\s\S]*fresh worker/);
	const shown = (expanded: boolean, isError = false) => tools.handoff.renderResult(stay, { expanded }, { fg: (_c: string, t: string) => t }, { isError }).render(400).join("\n").trim();
	assert.match(shown(false), /^Continue in this session[^\n]*left\)\.$/, "collapsed, the user sees only the verdict line");
	assert.match(shown(true), /worker subagent/, "ctrl+o shows the model's instructions");
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
	assert.match(kicked[0], /^Implement the plan in docs\/plans\/x\.md\.[\s\S]*success criteria[\s\S]*The plan[\s\S]*- \[ \] 1\. do it/);
	assert.match(kicked[0], /in order[\s\S]*\(parallel A\)[\s\S]*`tasks` array[\s\S]*not to edit the plan file[\s\S]*tick the steps that pass yourself[\s\S]*Call handoff/);

	await commands.handoff.handler("docs/plans/none.md", cmdCtx);
	assert.match(notices[0], /usage: \/handoff/);
	assert.equal(kicked.length, 1);
});

test("handoff refuses a malformed plan it has not accepted; under PI_EVAL=1 print mode is gated and the build never leaves the session", async () => {
	const saved = process.env.PI_EVAL;
	const cwd = mkdtempSync(join(tmpdir(), "handoff-eval-"));
	mkdirSync(join(cwd, "docs/plans"), { recursive: true });
	writeFileSync(join(cwd, "docs/plans/bad.md"), "- [ ] 1. do it\n- [ ] 2. more - files: gone.ts - check: `true`\n");
	writeFileSync(join(cwd, "docs/plans/x.md"), "- [ ] 1. do it - files: a.ts (new) - check: `true`\n\n## Success criteria\n- `true`\n");
	const handlers: Record<string, any> = {};
	const tools: Record<string, any> = {};
	const sent: string[] = [];
	const reviewer = { type: "message", message: { role: "toolResult", toolName: "subagent", isError: false, details: { results: [{ agent: "plan-reviewer", exitCode: 0, stopReason: "stop" }] } } };
	const branch: any[] = [reviewer];
	const pi = {
		on: (event: string, handler: any) => (handlers[event] = handler),
		registerCommand: () => {},
		registerTool: (def: any) => (tools[def.name] = def),
		appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data }),
		sendUserMessage: (text: string) => sent.push(text),
	};
	handoff(pi as any);
	const ask = (mode: string, prompt: string) => handlers.before_agent_start({ messageType: "user", prompt }, { mode, sessionManager: { getBranch: () => branch } });
	const plans = () => branch.filter((e) => e.customType === "handoff-plan").map((e) => e.data.path);
	try {
		delete process.env.PI_EVAL;
		assert.equal(ask("print", "add a theme option"), undefined, "print mode is not gated outside the eval");
		handlers.session_start({}, { mode: "print", cwd });
		assert.equal(tools.handoff, undefined);

		process.env.PI_EVAL = "1";
		assert.equal(ask("json", "add a theme option"), undefined, "json stays ungated, even under the eval");
		handlers.session_start({}, { mode: "json", cwd });
		assert.equal(tools.handoff, undefined);
		const note = ask("print", "add a theme option").message.content;
		assert.match(note, /^Before you edit code[\s\S]*- files: a\.ts, b\.ts \(new\) - check:/);
		assert.match(note, /no one is there to approve it/, "no run waits for a go-ahead no one gives");
		assert.doesNotMatch(note, /wait for their go-ahead/);
		assert.match(note, /## Assumptions[\s\S]*unchecked/, "PLAN_FIRST names the Assumptions endings");
		handlers.session_start({}, { mode: "print", cwd });
		assert.ok(tools.handoff);
		assert.equal(tools.handoff.executionMode, "sequential", "a write in the same batch lands before handoff reads the plan");
		assert.equal(ask("print", "Implement the plan in docs/plans/x.md. This session starts empty"), undefined);
		ask("print", "Implement the plan in docs/plans/x.md.");
		assert.deepEqual(plans(), ["docs/plans/x.md"], "a kickoff records its plan once");

		const ctx = { cwd, sessionManager: { getBranch: () => branch }, getContextUsage: () => ({ percent: 90 }) };
		const run = (plan: string, newSession?: boolean) => tools.handoff.execute("1", { plan, newSession }, undefined, undefined, ctx);
		await assert.rejects(run("docs/plans/bad.md"), (e: Error) => {
			assert.equal(e.message, "docs/plans/bad.md is not in the plan format:\n- step 1 has no check\n- step 1 lists no files\n- step 2: gone.ts does not exist (mark a new file `gone.ts (new)`)\n- no success criteria commands\nFix the plan file and call handoff again");
			return true;
		});
		assert.deepEqual(plans(), ["docs/plans/x.md"], "a refused plan is not recorded");
		writeFileSync(join(cwd, "docs/plans/assume.md"), "- [ ] 1. do it - files: a.ts (new) - check: `true`\n\n## Success criteria\n- `true`\n\n## Assumptions\n- A1. x — unchecked: not found\n");
		await assert.rejects(run("docs/plans/assume.md"), /A1 is unchecked \(not found\)/);
		assert.deepEqual(plans(), ["docs/plans/x.md"], "a plan with an unchecked assumption is not recorded");
		branch.push({ type: "custom", customType: "handoff-plan", data: { path: "docs/plans/bad.md" } });
		assert.match((await run("docs/plans/bad.md")).content[0].text, /^Continue in this session/, "a plan the session already accepted is exempt");

		// Full, compacted, and asked for a new session: the measured run still stays in one session.
		branch.push({ type: "compaction" });
		const stay = await run("docs/plans/x.md", true);
		assert.equal(stay.terminate, undefined);
		assert.match(stay.content[0].text, /^Continue in this session \(context 90%/);
		handlers.agent_settled({ aborted: false });
		assert.deepEqual(sent, [], "no queued /handoff");
	} finally {
		if (saved === undefined) delete process.env.PI_EVAL;
		else process.env.PI_EVAL = saved;
	}
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
