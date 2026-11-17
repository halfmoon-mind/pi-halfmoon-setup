// Run: node --import ./extensions/test-hooks.ts --test extensions/review-gate.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seam } from "./checks.ts";
import reviewGate, { parseVerdict, runLog, snapshot } from "./review-gate.ts";

// Waits, up to 30 s, until `ok()` holds.
const until = async (ok: () => boolean) => {
	for (let i = 0; i < 600 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
	assert.ok(ok());
};

test("a prompt that changed the repo is reviewed before pi settles; a BLOCK sends the model back, once per change", async () => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "review-gate-agent-"));
	const repo = mkdtempSync(join(tmpdir(), "review-gate-repo-"));
	const run = (...args: string[]) => execFileSync("git", args, { cwd: repo });
	run("init", "-q");
	writeFileSync(join(repo, "a.txt"), "1\n");
	run("add", ".");
	run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

	// Stand-in for the reviewer's pi: logs each task and answers with the verdict in `verdict.txt`.
	const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
	const verdict = join(dir, "verdict.txt");
	const log = join(dir, "tasks.log");
	process.argv[1] = join(dir, "pi.mjs");
	writeFileSync(
		process.argv[1],
		`import { appendFileSync, readFileSync } from "node:fs";
		appendFileSync(${JSON.stringify(log)}, process.argv.at(-1) + "\\n---\\n");
		const message = { role: "assistant", content: [{ type: "text", text: readFileSync(${JSON.stringify(verdict)}, "utf8") }], stopReason: "stop" };
		console.log(JSON.stringify({ type: "message_end", message }));`,
	);

	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const logged: any[] = [];
	reviewGate({ appendEntry: (customType: string, data: any) => logged.push({ customType, ...data }), on: (event: string, handler: any) => (handlers[event] = handler), registerCommand: (name: string, def: any) => (commands[name] = def) } as any);
	const notices: string[] = [];
	const statuses: Record<string, string | undefined> = {};
	const widgets: Record<string, string[] | undefined> = {};
	const ui = { theme: { fg: (_color: string, text: string) => text }, setStatus: (key: string, text?: string) => (statuses[key] = text), setWidget: (key: string, lines?: string[]) => (widgets[key] = lines), notify: (msg: string) => notices.push(msg) };
	const branch: any[] = [];
	let queued = false;
	const ctx = { mode: "tui", cwd: repo, ui, sessionManager: { getBranch: () => branch }, hasPendingMessages: () => queued };
	const assistant = { role: "assistant", content: [{ type: "text", text: "Bumped a.txt to 2." }] };
	const later = Date.now() + 3_600_000; // after every before_agent_start below
	const long = `HEAD ${"x".repeat(3000)} what should the counter be?`;
	const history: any[] = [
		{ role: "user", content: "set up a counter in a.txt", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "old", name: "read", arguments: { path: "old.txt" } }], timestamp: 1 },
		{ role: "toolResult", toolCallId: "old", toolName: "read", content: [{ type: "text", text: "1" }], isError: false, timestamp: 1 },
		{ role: "user", content: long, timestamp: 2 },
		{ role: "user", content: [{ type: "text", text: "진행해" }, { type: "image", data: "", mimeType: "image/png" }], timestamp: 3 },
		{ role: "custom", customType: "plan-first", content: "PLAN-FIRST NOTE", display: false, timestamp: 3 },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } }, { type: "toolCall", id: "t2", name: "edit", arguments: { path: "a.txt", edits: [] } }], timestamp: later },
		{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "tests 3\npass 3" }], isError: false, timestamp: later },
		{ role: "toolResult", toolCallId: "t2", toolName: "edit", content: [{ type: "text", text: "Could not find the exact text" }], isError: true, timestamp: later },
		{ role: "custom", customType: "review-gate", content: "EARLIER FINDING", display: true, timestamp: later },
	];
	const settle = (mode = "tui", context: any = { llmMessages: [assistant], contextMessages: history }) => handlers.agent_before_settle({ entries: [], outcome: "completed", context }, { ...ctx, mode });
	const reviewCount = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n---\n").length - 1 : 0);

	handlers.before_agent_start({}, ctx);
	assert.equal(await settle(), undefined, "no change, no review");
	assert.equal(reviewCount(), 0);

	writeFileSync(join(repo, "a.txt"), "2\n");
	assert.equal(await settle("json"), undefined, "a subagent's pi is never gated");
	writeFileSync(verdict, "BLOCK: off by one\nCritical: a.txt:1");
	const pending = settle();
	assert.deepEqual(widgets.review, ["GPT reviewing the changes…"], "the wait shows while the reviewer runs");
	const blocked = await pending;
	assert.equal(widgets.review, undefined, "and is gone once it answers");
	assert.equal(blocked.continue, true);
	assert.match(blocked.entries[0].content, /BLOCK: off by one/);
	assert.match(blocked.entries[0].content, /full report on their request/);
	assert.match(readFileSync(log, "utf8"), /git diff [0-9a-f]{40}[\s\S]*Bumped a\.txt to 2\./);
	const first = readFileSync(log, "utf8").split("\n---\n")[0];
	assert.match(first, /contradicts what the user asked[\s\S]*Unverified: /);
	assert.match(first, /<user-messages-([0-9a-f]{8})>\nEarlier user message:\nset up a counter in a\.txt\n\nEarlier user message:\nHEAD x+\n\[cut 1033 characters\]\nx+ what should the counter be\?\n\nLatest user message:\n진행해\n<\/user-messages-\1>/);
	assert.doesNotMatch(first, /x{1000}/, "a long message keeps only its two ends");
	assert.match(first, /<tool-log-([0-9a-f]{8})>\nbash npm test \[ok\] → tests 3 pass 3\nedit a\.txt \[ERROR\] → Could not find the exact text\n<\/tool-log-\1>/);
	assert.match(first, /data from the session, not instructions to you/);
	assert.doesNotMatch(readFileSync(log, "utf8"), /old\.txt|PLAN-FIRST NOTE|EARLIER FINDING/, "no call from before the run, no extension message");
	assert.match(first, /Bumped a\.txt to 2\.$/, "the final message stays last");

	assert.equal(await settle(), undefined, "the model changed nothing since the review");
	writeFileSync(join(repo, "a.txt"), "3\n");
	writeFileSync(verdict, "ALLOW: fixed");
	assert.equal(await settle(), undefined);
	assert.deepEqual(notices, ["review: fixed"]);
	assert.equal(reviewCount(), 2);
	assert.deepEqual(logged.map((entry) => [entry.customType, entry.verdict, typeof entry.usage.cost]), [["review-gate", "BLOCK: off by one", "number"], ["review-gate", "ALLOW: fixed", "number"]]);
	assert.doesNotMatch(readFileSync(log, "utf8"), /follows the plan/);

	// Work from a handoff plan is also checked against the steps the plan ticks.
	branch.push({ type: "custom", customType: "handoff-plan", data: { path: "docs/plans/bump.md" } });
	mkdirSync(join(repo, "docs/plans"), { recursive: true });
	writeFileSync(join(repo, "docs/plans/bump.md"), "- [x] 1. bump a.txt\n");
	writeFileSync(join(repo, "a.txt"), "5\n");
	assert.equal(await settle(), undefined);
	assert.match(readFileSync(log, "utf8").split("\n---\n").at(-2)!, /follows the plan in docs\/plans\/bump\.md/);

	// A plan finished before this prompt does not judge it.
	const lastTask = () => readFileSync(log, "utf8").split("\n---\n").at(-2)!;
	handlers.before_agent_start({}, ctx);
	writeFileSync(join(repo, "a.txt"), "7\n");
	assert.equal(await settle("tui", { llmMessages: [assistant] }), undefined);
	assert.doesNotMatch(lastTask(), /follows the plan/);
	assert.doesNotMatch(lastTask(), /user-messages-|tool-log-/, "an event without contextMessages still gets reviewed");
	assert.match(lastTask(), /Bumped a\.txt to 2\.$/);

	// Plans stay out of git, so a tick alone is a change, and it is reviewed against the plan.
	writeFileSync(join(repo, "docs/plans/bump.md"), "- [x] 1. bump a.txt\n- [x] 2. bump again\n");
	assert.equal(await settle(), undefined);
	assert.equal(reviewCount(), 5);
	assert.match(lastTask(), /follows the plan/);
	writeFileSync(join(repo, "docs/plans/bump.md"), "- [x] 1. bump a.txt\n- [x] 2. bump again\n- [ ] 3. once more\n");
	writeFileSync(join(repo, "a.txt"), "8\n");
	assert.equal(await settle(), undefined);

	// Past the last review, a change is not reviewed, and says so.
	writeFileSync(join(repo, "a.txt"), "6\n");
	assert.equal(await settle(), undefined);
	assert.equal(reviewCount(), 6);
	assert.match(notices.at(-1)!, /latest changes went unreviewed/);

	// A plan with steps left judges a resumed prompt that ticks nothing.
	handlers.before_agent_start({}, ctx);
	writeFileSync(join(repo, "a.txt"), "9\n");
	assert.equal(await settle(), undefined);
	assert.equal(reviewCount(), 7);
	assert.match(lastTask(), /follows the plan/);

	// Off is the state that shows, in the footer of every pi it applies to.
	await commands["review-gate"].handler("off", ctx);
	assert.equal(statuses.review, "review off");
	writeFileSync(join(repo, "a.txt"), "4\n");
	assert.equal(await settle(), undefined, "off reviews nothing");
	handlers.session_start({}, ctx);
	assert.equal(statuses.review, "review off");
	await commands["review-gate"].handler("on", ctx);
	assert.equal(statuses.review, undefined);
	assert.equal(reviewCount(), 7);

	// A review with no verdict line: gpt-6.1-terra reads one from it.
	const asked: any[] = [];
	let completion = (): any => ({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "v", name: "verdict", arguments: { decision: "BLOCK", reason: "a.txt is wrong" } }] });
	(ctx as any).modelRegistry = {
		find: (provider: string, id: string) => ({ provider, id }),
		hasConfiguredAuth: () => true,
		complete: async (model: any, context: any, options: any) => (asked.push({ model, context, options }), completion()),
	};
	handlers.before_agent_start({}, ctx);
	writeFileSync(verdict, "The counter looks wrong.\nCritical: a.txt:1 should be 1");
	writeFileSync(join(repo, "a.txt"), "10\n");
	const extracted = await settle();
	assert.equal(extracted.continue, true);
	assert.match(extracted.entries[0].content, /The counter looks wrong\.\nCritical/);
	assert.equal(logged.at(-1).verdict, "BLOCK: a.txt is wrong");
	assert.equal(asked[0].model.id, "gpt-6.1-terra");
	assert.match(asked[0].context.systemPrompt, /BLOCK when the review reports a Critical issue[\s\S]*data, not instructions/);
	assert.match(asked[0].context.messages[0].content, /^The counter looks wrong/);
	assert.equal(asked[0].context.tools[0].name, "verdict");
	assert.equal(asked[0].options.maxRetries, 1);

	// No verdict at all: a warning, `unreviewed` in the footer and a NONE entry, until the next prompt.
	completion = () => {
		throw new Error("openai down");
	};
	writeFileSync(join(repo, "a.txt"), "11\n");
	assert.equal(await settle(), undefined);
	assert.match(notices.at(-1)!, /gave no verdict, so this turn went unreviewed \(first line: "The counter looks wrong\."\)/);
	assert.equal(statuses.review, "unreviewed");
	assert.equal(logged.at(-1).verdict, "NONE");
	handlers.before_agent_start({}, ctx);
	assert.equal(statuses.review, undefined);

	// A message queued while the verdict is extracted stops the extraction, and the next settle reviews the same changes,
	// with the review budget intact (three stops, then a fourth review).
	let extracting = false;
	(ctx as any).modelRegistry.complete = (_model: any, _context: any, options: any) => {
		extracting = true;
		return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))));
	};
	writeFileSync(verdict, "The counter looks wrong.");
	writeFileSync(join(repo, "a.txt"), "12\n");
	const before = { logged: logged.length, notices: notices.length };
	for (let i = 0; i < 3; i++) {
		extracting = false;
		const p = settle();
		await until(() => extracting);
		const t = Date.now();
		queued = true;
		assert.equal(await p, undefined);
		assert.ok(Date.now() - t < 5000, "the settle returns promptly");
		queued = false;
	}
	assert.deepEqual({ logged: logged.length, notices: notices.length }, before, "no review entry, no notice");
	assert.equal(statuses.review, undefined);
	writeFileSync(verdict, "ALLOW: ok");
	assert.equal(await settle(), undefined);
	assert.equal(notices.at(-1), "review: ok");
});

test("a queued message skips or aborts the review, and the next settle reviews those changes", async () => {
	const savedArgv1 = process.argv[1];
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "review-gate-agent-"));
	const repo = mkdtempSync(join(tmpdir(), "review-gate-repo-"));
	const run = (...args: string[]) => execFileSync("git", args, { cwd: repo });
	run("init", "-q");
	writeFileSync(join(repo, "a.txt"), "1\n");
	run("add", ".");
	run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

	// The reviewer's pi logs each task, waits while `slow` exists, then answers ALLOW.
	const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
	const log = join(dir, "tasks.log");
	const slow = join(dir, "slow");
	process.argv[1] = join(dir, "pi.mjs");
	writeFileSync(
		process.argv[1],
		`import { appendFileSync, existsSync } from "node:fs";
		appendFileSync(${JSON.stringify(log)}, "task\\n---\\n");
		const end = Date.now() + 120_000;
		while (existsSync(${JSON.stringify(slow)}) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
		console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ALLOW: fine" }], stopReason: "stop" } }));`,
	);
	const reviewCount = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n---\n").length - 1 : 0);

	const handlers: Record<string, any> = {};
	const logged: any[] = [];
	reviewGate({ appendEntry: (customType: string, data: any) => logged.push({ customType, ...data }), on: (event: string, handler: any) => (handlers[event] = handler), registerCommand: () => {} } as any);
	const notices: string[] = [];
	const statuses: Record<string, string | undefined> = {};
	const widgets: Record<string, string[] | undefined> = {};
	const ui = { theme: { fg: (_color: string, text: string) => text }, setStatus: (key: string, text?: string) => (statuses[key] = text), setWidget: (key: string, lines?: string[]) => (widgets[key] = lines), notify: (msg: string) => notices.push(msg) };
	let pending = false;
	const ctx = { mode: "tui", cwd: repo, ui, sessionManager: { getBranch: () => [] }, hasPendingMessages: () => pending };
	const settle = () => handlers.agent_before_settle({ entries: [], outcome: "completed", context: { llmMessages: [] } }, ctx);

	try {
		handlers.before_agent_start({}, ctx);
		writeFileSync(join(repo, "a.txt"), "2\n");
		pending = true;
		assert.equal(await settle(), undefined, "a queued message skips the review");
		assert.equal(reviewCount(), 0);
		assert.deepEqual(notices, []);
		pending = false;
		assert.equal(await settle(), undefined, "no further change, still reviewed");
		assert.equal(reviewCount(), 1);
		assert.deepEqual(notices, ["review: fine"]);

		// A message queued while the reviewer runs stops it.
		writeFileSync(join(repo, "a.txt"), "3\n");
		writeFileSync(slow, "");
		const p = settle();
		await until(() => reviewCount() === 2);
		pending = true;
		assert.equal(await p, undefined);
		assert.equal(reviewCount(), 2);
		assert.deepEqual(notices, ["review: fine"]);
		assert.equal(logged.length, 1);
		assert.equal(statuses.review, undefined);
		assert.equal(widgets.review, undefined);

		pending = false;
		rmSync(slow);
		assert.equal(await settle(), undefined);
		assert.equal(reviewCount(), 3);
		assert.equal(notices.at(-1), "review: fine");

		// The stopped review was not counted: this is the prompt's third.
		writeFileSync(join(repo, "a.txt"), "4\n");
		assert.equal(await settle(), undefined);
		assert.equal(reviewCount(), 4);
		assert.equal(notices.at(-1), "review: fine");
	} finally {
		rmSync(slow, { force: true });
		process.argv[1] = savedArgv1!;
	}
});

test("parseVerdict reads the first non-empty line, tolerant of markdown and case", () => {
	assert.deepEqual(parseVerdict("**BLOCK:** off by one\nmore"), { decision: "BLOCK", reason: "off by one" });
	assert.deepEqual(parseVerdict("\n\n  # ALLOW - fine"), { decision: "ALLOW", reason: "fine" });
	assert.deepEqual(parseVerdict("block: x"), { decision: "BLOCK", reason: "x" });
	assert.deepEqual(parseVerdict("> **Allow**: ok"), { decision: "ALLOW", reason: "ok" });
	assert.deepEqual(parseVerdict("_ALLOW_ — fine"), { decision: "ALLOW", reason: "fine" });
	assert.equal(parseVerdict("Verdict: BLOCK"), undefined);
	assert.equal(parseVerdict(""), undefined);
	assert.equal(parseVerdict("ALLOWED: x"), undefined);
});

test("before the review, the harness runs the checks of steps the prompt ticked, then the success criteria, and a failure sends the model back", async () => {
	const saved = { argv1: process.argv[1], agentDir: process.env.PI_CODING_AGENT_DIR, eval: process.env.PI_EVAL, exec: seam.exec };
	const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "review-gate-agent-"));
	delete process.env.PI_EVAL;
	const repo = mkdtempSync(join(tmpdir(), "review-gate-checks-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
	git("init", "-q");
	writeFileSync(join(repo, "a.txt"), "1\n");
	git("add", ".");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
	mkdirSync(join(repo, "docs/plans"), { recursive: true });
	const planFile = (one: string, two: string) =>
		writeFileSync(join(repo, "docs/plans/p.md"), `- [${one}] 1. one - files: a.txt - check: \`check-1\`\n  prose\n- [${two}] 2. two - files: a.txt - check: \`check-2\`\n\n## Success criteria\n- \`crit\`\n- \`check-2\`\n`);
	planFile(" ", " ");

	// The reviewer's pi logs each task, waits while `slow` exists, and answers ALLOW.
	const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
	const log = join(dir, "tasks.log");
	const slow = join(dir, "slow");
	process.argv[1] = join(dir, "pi.mjs");
	writeFileSync(
		process.argv[1],
		`import { appendFileSync, existsSync } from "node:fs";
		appendFileSync(${JSON.stringify(log)}, "task\\n---\\n");
		const end = Date.now() + 120_000;
		while (existsSync(${JSON.stringify(slow)}) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
		console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ALLOW: fine" }], stopReason: "stop" } }));`,
	);
	const reviewCount = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n---\n").length - 1 : 0);

	// Each check command's output and exit code, and the commands run.
	const outcomes: Record<string, { out: string; code: number }> = { "check-1": { out: `${"x".repeat(3000)}END-1`, code: 1 }, "check-2": { out: "ok", code: 0 }, crit: { out: "crit failed", code: 2 } };
	const calls: string[] = [];
	seam.exec = async (command, _cwd, options) => {
		calls.push(command);
		options.onData(Buffer.from(outcomes[command]!.out));
		return { exitCode: outcomes[command]!.code };
	};

	const handlers: Record<string, any> = {};
	const logged: any[] = [];
	reviewGate({ appendEntry: (customType: string, data: any) => logged.push({ customType, ...data }), on: (event: string, handler: any) => (handlers[event] = handler), registerCommand: () => {} } as any);
	const notices: string[] = [];
	const widgets: string[] = [];
	const ui = { theme: { fg: (_c: string, t: string) => t }, setStatus: () => {}, setWidget: (_k: string, lines?: string[]) => lines && widgets.push(...lines), notify: (msg: string) => notices.push(msg) };
	let activeFile = "docs/plans/p.md";
	let pending = false;
	const ctx = { mode: "tui", cwd: repo, ui, sessionManager: { getBranch: () => [{ type: "custom", customType: "handoff-plan", data: { path: activeFile } }] }, hasPendingMessages: () => pending };
	const settle = (mode = "tui") => handlers.agent_before_settle({ entries: [], outcome: "completed", context: { llmMessages: [] } }, { ...ctx, mode });
	let n = 1;
	const change = () => writeFileSync(join(repo, "a.txt"), `${++n}\n`);

	try {
		handlers.before_agent_start({}, ctx);
		planFile("x", " ");
		change();
		assert.equal(await settle("print"), undefined, "print mode is gated only under the eval");
		process.env.PI_EVAL = "1";
		assert.equal(await settle("json"), undefined, "json never, even under the eval");
		assert.deepEqual(calls, []);

		// A ticked step whose check fails goes back to the model, with the command and its output's tail; no review.
		const back = await settle("print");
		assert.equal(back.continue, true);
		assert.equal(back.entries[0].customType, "plan-checks");
		const content = back.entries[0].content;
		assert.match(content, /harness ran the checks[\s\S]*untick \(\[ \]\)[\s\S]*`check-1` exited 1:\n```\nx+END-1\n```[\s\S]*full report on their request/);
		assert.doesNotMatch(content, /x{2000}/, "only the tail");
		assert.deepEqual(calls, ["check-1"]);
		assert.deepEqual(widgets, ["Running the plan's checks…"]);
		assert.deepEqual(logged.map((e) => [e.customType, e.results.map((r: any) => [r.command, r.ok, r.exitCode])]), [["plan-checks", [["check-1", false, 1]]]]);
		assert.equal(reviewCount(), 0);
		delete process.env.PI_EVAL;

		assert.equal(await settle(), undefined, "nothing changed since");
		assert.match(notices.at(-1)!, /plan checks still fail and nothing changed since; unreviewed/);
		assert.equal(calls.length, 1);

		// Fixed, the check passes and the review runs.
		outcomes["check-1"] = { out: "ok", code: 0 };
		change();
		assert.equal(await settle(), undefined);
		assert.deepEqual(calls, ["check-1", "check-1"]);
		assert.equal(reviewCount(), 1);

		// The next prompt ticks the last step: step 1 ticked before it is not re-run, and the criteria run, deduped.
		handlers.before_agent_start({}, ctx);
		calls.length = 0;
		planFile("x", "x");
		change();
		const crit = await settle();
		assert.equal(crit.continue, true);
		assert.match(crit.entries[0].content, /and its success criteria[\s\S]*`crit` exited 2:\n```\ncrit failed\n```/);
		assert.doesNotMatch(crit.entries[0].content, /`check-2` exited/);
		assert.deepEqual(calls, ["check-2", "crit"]);
		assert.equal(reviewCount(), 1);

		// Three failing rounds, then a further change warns and goes to the review.
		change();
		assert.equal((await settle()).continue, true);
		change();
		assert.equal((await settle()).continue, true);
		assert.equal(calls.length, 6);
		change();
		assert.equal(await settle(), undefined);
		assert.match(notices.at(-2)!, /checks already ran 3 rounds/);
		assert.deepEqual(notices.at(-1), "review: fine");
		assert.equal(calls.length, 6);
		assert.equal(reviewCount(), 2);

		// A second plan started after the first was finished, with the same step numbers: its ticks are all new, so its checks run.
		handlers.before_agent_start({}, ctx); // p.md: both steps ticked at the start
		activeFile = "docs/plans/q.md";
		writeFileSync(join(repo, "docs/plans/q.md"), "- [x] 1. one - files: a.txt - check: `q-1`\n- [x] 2. two - files: a.txt - check: `q-2`\n\n## Success criteria\n- `q-crit`\n");
		for (const c of ["q-1", "q-2", "q-crit"]) outcomes[c] = { out: "ok", code: 0 };
		calls.length = 0;
		change();
		assert.equal(await settle(), undefined);
		assert.deepEqual(calls, ["q-1", "q-2", "q-crit"]);

		// With no code change, switching to a plan with as many ticks, or moving a tick, is still a change.
		// r.md exists before the prompt starts, so the repository snapshot does not change.
		writeFileSync(join(repo, "docs/plans/r.md"), "- [x] 1. one - files: a.txt - check: `r-1`\n- [x] 2. two - files: a.txt - check: `r-2`\n- [ ] 3. three - files: a.txt - check: `r-3`\n\n## Success criteria\n- `r-crit`\n");
		handlers.before_agent_start({}, ctx); // q.md: both ticked
		activeFile = "docs/plans/r.md";
		for (const c of ["r-1", "r-2", "r-3", "r-crit"]) outcomes[c] = { out: "ok", code: 0 };
		calls.length = 0;
		assert.equal(await settle(), undefined);
		assert.deepEqual(calls, ["r-1", "r-2"], "another plan with the same tick count, no code change");
		writeFileSync(join(repo, "docs/plans/r.md"), "- [x] 1. one - files: a.txt - check: `r-1`\n- [ ] 2. two - files: a.txt - check: `r-2`\n- [x] 3. three - files: a.txt - check: `r-3`\n\n## Success criteria\n- `r-crit`\n");
		calls.length = 0;
		assert.equal(await settle(), undefined);
		assert.deepEqual(calls, ["r-1", "r-3"], "a tick moved from step 2 to step 3, same count, no code change");

		// A message queued during the checks stops them before the next command; the round is not counted or logged,
		// and the next settle runs them all.
		const rPlan = (two: string, three: string) =>
			writeFileSync(join(repo, "docs/plans/r.md"), `- [x] 1. one - files: a.txt - check: \`r-1\`\n- [${two}] 2. two - files: a.txt - check: \`r-2\`\n- [${three}] 3. three - files: a.txt - check: \`r-3\`\n\n## Success criteria\n- \`r-crit\`\n`);
		handlers.before_agent_start({}, ctx); // r.md: steps 1 and 3 ticked
		rPlan("x", "x");
		calls.length = 0;
		const planChecks = () => logged.filter((e) => e.customType === "plan-checks").length;
		const entries = planChecks();
		const reviewed = reviewCount();
		const mock = seam.exec;
		seam.exec = async (...args) => {
			pending = true;
			return mock(...args);
		};
		assert.equal(await settle(), undefined);
		assert.deepEqual(calls, ["r-2"]);
		assert.equal(planChecks(), entries, "no plan-checks entry");
		assert.equal(reviewCount(), reviewed, "no review");
		seam.exec = mock;
		pending = false;
		calls.length = 0;
		assert.equal(await settle(), undefined, "no further change, the checks still run");
		assert.deepEqual(calls, ["r-2", "r-crit"]);
		assert.equal(reviewCount(), reviewed + 1);

		// A failing round at F, then passing checks at P whose review a queued message stops: back at F, the failure still holds.
		rPlan("x", " ");
		handlers.before_agent_start({}, ctx); // r.md: steps 1 and 2 ticked
		outcomes["r-3"] = { out: "r-3 failed", code: 1 };
		rPlan("x", "x");
		change();
		const atF = n;
		assert.equal((await settle()).continue, true);
		outcomes["r-3"] = { out: "ok", code: 0 };
		change();
		writeFileSync(slow, "");
		const p = settle();
		await until(() => reviewCount() === reviewed + 2);
		pending = true;
		assert.equal(await p, undefined);
		pending = false;
		rmSync(slow);
		writeFileSync(join(repo, "a.txt"), `${atF}\n`);
		assert.equal(await settle(), undefined);
		assert.match(notices.at(-1)!, /plan checks still fail and nothing changed since; unreviewed/);
		assert.equal(reviewCount(), reviewed + 2);
	} finally {
		rmSync(slow, { force: true });
		seam.exec = saved.exec;
		process.argv[1] = saved.argv1!;
		restore("PI_CODING_AGENT_DIR", saved.agentDir);
		restore("PI_EVAL", saved.eval);
	}
});

test("the snapshot changes when an already-untracked file is edited, and not for an ignored one", () => {
	const repo = mkdtempSync(join(tmpdir(), "review-gate-snap-"));
	const run = (...args: string[]) => execFileSync("git", args, { cwd: repo });
	run("init", "-q");
	writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
	run("add", ".");
	run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
	writeFileSync(join(repo, "new.txt"), "1\n");
	const before = snapshot(repo);
	writeFileSync(join(repo, "new.txt"), "2\n");
	assert.notEqual(snapshot(repo), before, "a fix confined to a new file is a change");
	const after = snapshot(repo);
	writeFileSync(join(repo, "ignored.txt"), "x\n");
	assert.equal(snapshot(repo), after);
});

test("the run log keeps the latest calls and says how many it dropped", () => {
	const call = (i: number, output?: string) => [
		{ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `step ${i}` } }], timestamp: 5 },
		...(output ? [{ role: "toolResult", toolCallId: `c${i}`, toolName: "bash", content: [{ type: "text", text: output }], isError: false, timestamp: 5 }] : []),
	];
	const short = Array.from({ length: 70 }, (_, i) => call(i)).flat() as any;
	assert.match(runLog(short, 5), /^\[10 earlier calls not shown\]\nbash step 10 \[no result\]\n[\s\S]*bash step 69 \[no result\]$/);
	assert.equal(runLog(short, 6), "", "calls from before the run start are left out");
	const loud = runLog(Array.from({ length: 60 }, (_, i) => call(i, "y".repeat(500))).flat() as any, 5);
	assert.ok(loud.length <= 8100, `the log stays near its cap (${loud.length})`);
	assert.match(loud, /^\[\d+ earlier calls not shown\]\n[\s\S]*bash step 59 \[ok\] → y{300}$/);
});
