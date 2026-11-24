// Run: node --import ./extensions/test-hooks.ts --test bench/agent/followup-eval.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "followup-eval-"));
const evalRun = (...args: string[]) =>
	spawnSync(process.execPath, ["--import", "./extensions/test-hooks.ts", "bench/agent/followup-eval.ts", ...args], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, timeout: 60_000 });

// One session tree, chained by parentId unless an entry names its parent.
let n = 0;
let last: string | null = null;
const lines: string[] = [];
const add = (e: any, parentId: string | null = last) => {
	const id = `e${++n}`;
	lines.push(JSON.stringify({ id, parentId, timestamp: "2026-11-24T00:00:00Z", ...e }));
	last = id;
	return id;
};
const user = (text: string) => add({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: n * 1000 } });
const reply = (text: string, extra: any[] = []) => add({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "the off case is tricky" }, ...extra, { type: "text", text }], timestamp: n * 1000 } });

lines.push(JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-11-24T00:00:00Z", cwd: "/x" }));
user("어느 쪽이 좋을까?");
reply("두 가지가 있습니다.\n\n1번으로 할까요?");
user("1번으로 하는데 중간에 off하는 케이스도 고려되는건가?"); // positive, eligible
reply("Done.");
user("이 경우도 고려됐어?"); // positive, no question
reply("Ready?");
user("진행"); // negative, eligible
reply("Edited it. OK?", [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "a.ts" } }]);
user("ㄱㄱ"); // negative, edited
add({ type: "custom_message", customType: "review-notes", content: "notes", display: true });
reply("Triaged. Which ones?");
user("진행"); // negative, after a gate message
const fork = reply("Shall I go on?");
user("ㄱㄱ"); // negative, eligible
add({ type: "message", message: { role: "user", content: "왜 테스트는 안 돌렸어?", timestamp: 99_000 } }, fork); // positive, eligible, on its own branch
lines.push("{not json");
mkdirSync(join(agentDir, "sessions/--Users-x--"), { recursive: true });
writeFileSync(join(agentDir, "sessions/--Users-x--/s.jsonl"), `${lines.join("\n")}\n`);
mkdirSync(join(agentDir, "sessions/--private-tmp-e2e--"), { recursive: true });
writeFileSync(
	join(agentDir, "sessions/--private-tmp-e2e--/t.jsonl"),
	[
		JSON.stringify({ type: "message", id: "a", parentId: null, message: { role: "user", content: "x", timestamp: 1 } }),
		JSON.stringify({ type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: "Ok?" }], timestamp: 2 } }),
		JSON.stringify({ type: "message", id: "c", parentId: "b", message: { role: "user", content: "고려됐어?", timestamp: 3 } }),
	].join("\n"),
);

test("--dry counts the follow-ups on synthetic sessions, skipping temp-run dirs, and writes nothing", () => {
	const r = evalRun("--dry");
	assert.equal(r.status, 0, r.stderr);
	assert.equal(
		r.stdout,
		[
			"sessions 1 (1 temp-run dirs skipped)",
			"positives 3: eligible 2, no question 1, edited 0, after a gate message 0, a decision check ran 0, no reply 0",
			"negatives 4: eligible 2, no question 0, edited 1, after a gate message 1, a decision check ran 0, no reply 0",
			"",
		].join("\n"),
	);
	assert.equal(existsSync(join(agentDir, "followup-eval")), false);
});

test("--report with no results, and bad arguments exit 2 without output", () => {
	const r = evalRun("--report");
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, "no results\n");
	assert.equal(evalRun("--bogus").status, 2);
	for (const args of [["--dry", "--label", "."], ["--dry", "--label", ".."], ["--report", "--label", ".."], ["--dry", "--report"], []]) assert.equal(evalRun(...args).status, 2, args.join(" "));
	assert.equal(existsSync(join(agentDir, "followup-eval")), false);
});
