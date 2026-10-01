// Run: node --import ./extensions/test-hooks.ts --test extensions/review-gate.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
	reviewGate({ on: (event: string, handler: any) => (handlers[event] = handler), registerCommand() {} } as any);
	const notices: string[] = [];
	const ctx = { mode: "tui", cwd: repo, ui: { setStatus() {}, notify: (msg: string) => notices.push(msg) } };
	const assistant = { role: "assistant", content: [{ type: "text", text: "Bumped a.txt to 2." }] };
	const settle = (mode = "tui") => handlers.agent_before_settle({ entries: [], outcome: "completed", context: { llmMessages: [assistant] } }, { ...ctx, mode });
	const reviewCount = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n---\n").length - 1 : 0);

	handlers.before_agent_start({}, ctx);
	assert.equal(await settle(), undefined, "no change, no review");
	assert.equal(reviewCount(), 0);

	writeFileSync(join(repo, "a.txt"), "2\n");
	assert.equal(await settle("json"), undefined, "a subagent's pi is never gated");
	writeFileSync(verdict, "BLOCK: off by one\nCritical: a.txt:1");
	const blocked = await settle();
	assert.equal(blocked.continue, true);
	assert.match(blocked.entries[0].content, /BLOCK: off by one/);
	assert.match(readFileSync(log, "utf8"), /git diff [0-9a-f]{40}[\s\S]*Bumped a\.txt to 2\./);

	assert.equal(await settle(), undefined, "the model changed nothing since the review");
	writeFileSync(join(repo, "a.txt"), "3\n");
	writeFileSync(verdict, "ALLOW: fixed");
	assert.equal(await settle(), undefined);
	assert.deepEqual(notices, ["review: fixed"]);
	assert.equal(reviewCount(), 2);
});
