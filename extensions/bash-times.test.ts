// Run: node --import ./extensions/test-hooks.ts --test extensions/bash-times.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backfill, commandKey, estimate, excluded, read, record, startBackfill, storePath } from "./bash-times.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "bash-times-agent-"));

const home = join(homedir(), "p");
const id = (command: string, cwd = home) => commandKey(command, cwd)?.id;

test("cd sets the cwd, redirects, env values and trivial segments are dropped, quoted | is not split", () => {
	assert.equal(id("cd ~/p; make test", "/"), id("make test"));
	const k = commandKey('make test > /tmp/x 2>&1; echo exit=$?; grep -E "a|b" /tmp/x', home);
	assert.deepEqual(k, commandKey("make test", home));
	assert.equal(k?.label, "make");
	assert.equal(id("FOO=secret make build"), id("make build"));
	assert.deepEqual(commandKey("time make test", home), commandKey("make test", home), "time is a wrapper");
	assert.deepEqual(commandKey("{ make test; } 2>&1 | tail -3", home), commandKey("make test", home), "{ …; } is a group");
	assert.equal(id("make $(echo build)"), id("make $(echo other)"), "$(…) is dropped");
	// A substituted executable leaves a placeholder, so its argument never becomes the label.
	assert.equal(commandKey("$(command -v curl) https://example.com/super-secret-token", home)?.label, "$()");
});

test("heredocs, inline scripts and trivial commands are not recorded", () => {
	for (const c of ["cat <<EOF\nx\nEOF", "python3 - <<'PY'\nprint(1)\nPY", 'node -e "console.log(1)"', 'bash -c "make test"', "python -c 'print(1)'", 'node "-e" "console.log(1)"', "python3 '-c' 'print(1)'", 'bash "-c" "make test"', "echo hi", "cd /tmp", undefined]) {
		assert.equal(commandKey(c, home), undefined, String(c));
	}
});

test("a chain is one key, labelled by its first executable's basename only", () => {
	const chain = commandKey("make build && make analyze", home);
	assert.notEqual(chain?.id, id("make build"));
	assert.equal(chain?.label, "make");
	for (const c of ["./scripts/run.sh foo", "./scripts/run.sh /private/input.txt", "./scripts/run.sh super-secret-token"]) {
		assert.equal(commandKey(c, home)?.label, "run.sh");
	}
	assert.equal(id("/usr/bin/make test"), id("make test"));
});

test("worktrees share a key, a subdir and dirs outside git do not", () => {
	const repo = mkdtempSync(join(tmpdir(), "bash-times-repo-"));
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
	git("init", "-q");
	git("commit", "-q", "--allow-empty", "-m", "init");
	const wt = join(mkdtempSync(join(tmpdir(), "bash-times-wt-")), "wt");
	git("worktree", "add", "-q", wt);
	mkdirSync(join(repo, "sub"));
	assert.equal(id("make test", repo), id("make test", wt));
	assert.notEqual(id("make test", join(repo, "sub")), id("make test", repo));
	const a = mkdtempSync(join(tmpdir(), "bash-times-plain-"));
	const b = mkdtempSync(join(tmpdir(), "bash-times-plain-"));
	assert.ok(id("make test", a));
	assert.notEqual(id("make test", a), id("make test", b));
});

test("estimate needs 3 samples and a 20 s median; the store keeps the last 10", () => {
	rmSync(storePath(), { force: true });
	assert.equal(estimate("a"), undefined, "no store");
	record("a", "make", 30000);
	record("a", "make", 40000);
	assert.equal(estimate("a"), undefined, "2 samples");
	for (const ms of [19000, 19000, 19000]) record("b", "make", ms);
	assert.equal(estimate("b"), undefined, "19 s median");
	record("a", "make", 50000);
	assert.equal(estimate("a"), 40000);
	for (let i = 0; i < 12; i++) record("c", "make", i);
	assert.deepEqual(JSON.parse(readFileSync(storePath(), "utf8")).c.ms, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("excluded catches aborts, timeouts and the sandbox, not an exit code", () => {
	for (const t of ["Command aborted", "x\nCommand timed out after 30 seconds", "[sandbox: blocked]"]) assert.ok(excluded(t), t);
	assert.ok(!excluded("out\n\nCommand exited with code 2"));
});

/** The store file has the labels and no path, argument, normalized command or cwd. */
function assertPrivate(labels: string[]) {
	const text = readFileSync(storePath(), "utf8");
	assert.deepEqual(Object.values(JSON.parse(text)).map((v: any) => v.label).sort(), labels);
	for (const leak of ["/", "secret", "scripts", "input", "foo", "build", homedir()]) assert.ok(!text.includes(leak), leak);
}

test("a recorded command keeps only its hash, its executable's name and the durations", () => {
	rmSync(storePath(), { force: true });
	for (const c of ["FOO=secret make build", "./scripts/run.sh foo", "./scripts/run.sh /private/input.txt", "./scripts/run.sh super-secret-token", "$(command -v curl) https://example.com/super-secret-token"]) {
		const k = commandKey(c, home)!;
		record(k.id, k.label, 1000);
	}
	assertPrivate(["$()", "make", "run.sh", "run.sh", "run.sh"]);
});

// One session file under a fresh sessions dir: each pair is a bash call and its result.
type Pair = { command: string; text: string; at: number; end: number; durationMs?: number; isError?: boolean };
function sessions(pairs: Pair[], dir = mkdtempSync(join(tmpdir(), "bash-times-sessions-")), sub = "--p--") {
	mkdirSync(join(dir, sub), { recursive: true });
	const lines: unknown[] = [{ type: "session", cwd: home }];
	pairs.forEach((p, i) => {
		lines.push({ type: "message", message: { role: "assistant", timestamp: p.at, content: [{ type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: p.command } }] } });
		lines.push({ type: "message", message: { role: "toolResult", toolCallId: `t${i}`, toolName: "bash", content: [{ type: "text", text: p.text }], isError: p.isError ?? false, timestamp: p.end, ...(p.durationMs === undefined ? {} : { durationMs: p.durationMs }) } });
	});
	writeFileSync(join(dir, sub, "s.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
	return dir;
}

test("startBackfill fills a missing store once from past sessions", async () => {
	rmSync(storePath(), { force: true });
	sessions(
		[
			{ command: "make test", text: "ok", at: 0, end: 99999, durationMs: 300000 },
			{ command: "cd ~/p && make test", text: "ok", at: 1000, end: 311000 },
			{ command: "make test", text: "Command aborted", at: 0, end: 5000, isError: true },
			{ command: "python3 - <<'PY'\nprint(1)\nPY", text: "1", at: 0, end: 50000 },
		],
		join(process.env.PI_CODING_AGENT_DIR!, "sessions"),
	);
	await startBackfill();
	assert.deepEqual(read(), { [id("make test")!]: { label: "make", ms: [300000, 310000] } });
	assert.equal(startBackfill(), undefined, "the store exists: no second backfill");
	assert.deepEqual(read()[id("make test")!].ms, [300000, 310000]);
});

test("without durationMs a blocked result adds nothing and an exit code still counts; backfilled samples come before live ones", async () => {
	rmSync(storePath(), { force: true });
	record(id("make test")!, "make", 1);
	await backfill(
		sessions([
			{ command: "make test", text: "blocked by a hook", at: 0, end: 900000, isError: true },
			{ command: "make test", text: "FAIL\n\nCommand exited with code 2", at: 0, end: 42000, isError: true },
		]),
	);
	assert.deepEqual(read()[id("make test")!].ms, [42000, 1]);
});

test("backfilled commands with path or secret arguments keep only the executable's name", async () => {
	rmSync(storePath(), { force: true });
	const pairs = ["FOO=secret make build", "./scripts/run.sh foo", "./scripts/run.sh /private/input.txt", "./scripts/run.sh super-secret-token", "$(command -v curl) https://example.com/super-secret-token"].map((command) => ({ command, text: "ok", at: 0, end: 1, durationMs: 1000 }));
	await backfill(sessions(pairs));
	assertPrivate(["$()", "make", "run.sh", "run.sh", "run.sh"]);
});

test("backfill keeps the 10 latest runs by time, not by the order it reads the session dirs in", async () => {
	rmSync(storePath(), { force: true });
	// Read first, but newer: --a-- holds runs 11-20, --b-- the older runs 1-10 (two worktrees sharing a key).
	const run = (n: number) => ({ command: "make test", text: "ok", at: n * 1000, end: n * 1000 + 1, durationMs: n });
	const dir = sessions(Array.from({ length: 10 }, (_, i) => run(i + 11)), undefined, "--a--");
	sessions(Array.from({ length: 10 }, (_, i) => run(i + 1)), dir, "--b--");
	await backfill(dir);
	assert.deepEqual(read()[id("make test")!].ms, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
});
