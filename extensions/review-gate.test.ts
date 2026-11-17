// Run: node --import ./extensions/test-hooks.ts --test extensions/review-gate.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import reviewGate from "./review-gate.ts";

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
	const ctx = { mode: "tui", cwd: repo, ui, sessionManager: { getBranch: () => branch } };
	const assistant = { role: "assistant", content: [{ type: "text", text: "Bumped a.txt to 2." }] };
	const settle = (mode = "tui") => handlers.agent_before_settle({ entries: [], outcome: "completed", context: { llmMessages: [assistant] } }, { ...ctx, mode });
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
	assert.match(readFileSync(log, "utf8"), /git diff [0-9a-f]{40}[\s\S]*Bumped a\.txt to 2\./);

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
	assert.equal(await settle(), undefined);
	assert.doesNotMatch(lastTask(), /follows the plan/);

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
});
