// Run: node --import ./extensions/test-hooks.ts --test --test-timeout=10000 extensions/timing.test.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { commandKey, read, record } from "./bash-times.ts";
import timing, { fmt, live, summary } from "./timing.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "timing-agent-"));

test("fmt keeps one decimal below 10s, then whole seconds and minutes", () => {
	assert.deepEqual([850, 9400, 9960, 12000, 59600, 83000].map(fmt), ["0.9s", "9.4s", "10s", "12s", "1m 0s", "1m 23s"]);
});

test("summary lists the top 3 tools by time, drops an empty tools part, and marks an abort; live names a running tool", () => {
	const tools = new Map([["read", { ms: 2000, n: 5 }], ["bash", { ms: 41000, n: 12 }], ["edit", { ms: 500, n: 1 }], ["subagent", { ms: 30000, n: 2 }]]);
	assert.equal(summary({ total: 83000, agent: 58000, tools, aborted: false }), "⏱ total 1m 23s · agent 58s · bash 41s ×12, subagent 30s ×2, read 2.0s ×5");
	assert.equal(summary({ total: 3000, agent: 2000, tools: new Map(), aborted: false }), "⏱ total 3.0s · agent 2.0s");
	assert.equal(summary({ total: 3000, agent: 2000, tools: new Map(), aborted: true }), "⏱ total 3.0s · agent 2.0s (aborted)");
	assert.equal(live({ total: 42000, agent: 30000, running: { name: "bash", ms: 12000 } }), "⏱ 42s · agent 30s · bash 12s");
	assert.equal(live({ total: 42000, agent: 30000 }), "⏱ 42s · agent 30s");
	assert.equal(live({ total: 140000, agent: 130000, running: { name: "bash", ms: 130000, usual: 316000 } }), "⏱ 2m 20s · agent 2m 10s · bash 2m 10s of ~5m 16s");
	assert.equal(live({ total: 662000, agent: 662000, running: { name: "bash", ms: 662000, usual: 316000 } }), "⏱ 11m 2s · agent 11m 2s · bash 11m 2s · usually ~5m 16s");
});

// The extension's handlers, with every setStatus("time", …) call and notice collected; the clock and interval are mocked.
// A tick over several intervals runs them all at its end time, so status values are checked one second at a time.
function setup(t: any, mode = "tui", cwd = mkdtempSync(join(tmpdir(), "timing-cwd-"))) {
	mock.timers.enable({ apis: ["Date", "setInterval"] });
	const handlers: Record<string, any> = {};
	timing({ on: (event: string, handler: any) => (handlers[event] = handler) } as any);
	const statuses: (string | undefined)[] = [];
	const notices: string[] = [];
	const ctx = { mode, cwd, ui: { setStatus: (key: string, text?: string) => key === "time" && statuses.push(text), notify: (msg: string) => notices.push(msg) } };
	const fire = (name: string, event: any = {}) => handlers[name](event, ctx);
	// Every test ends with a shutdown, even a failing one, so no interval outlives it.
	t.after(() => (fire("session_shutdown"), mock.timers.reset()));
	return { fire, statuses, notices, cwd };
}

test("the status ticks during a run and names the longest-running open tool", (t) => {
	const { fire, statuses, notices } = setup(t);
	fire("before_agent_start");
	fire("agent_start");
	mock.timers.tick(1000);
	fire("tool_execution_start", { toolCallId: "a", toolName: "bash" });
	mock.timers.tick(1000);
	fire("tool_execution_start", { toolCallId: "b", toolName: "read" });
	mock.timers.tick(1000);
	mock.timers.tick(1000);
	fire("tool_execution_end", { toolCallId: "a", toolName: "bash", durationMs: 3000 });
	mock.timers.tick(1000);
	fire("tool_execution_end", { toolCallId: "b", toolName: "read", durationMs: 3000 });
	mock.timers.tick(1000);
	assert.deepEqual(statuses, [
		"⏱ 0.0s · agent 0.0s",
		"⏱ 1.0s · agent 1.0s",
		"⏱ 2.0s · agent 2.0s · bash 1.0s",
		"⏱ 3.0s · agent 3.0s · bash 2.0s",
		"⏱ 4.0s · agent 4.0s · bash 3.0s",
		"⏱ 5.0s · agent 5.0s · read 3.0s",
		"⏱ 6.0s · agent 6.0s",
	]);
	fire("agent_end");
	fire("agent_settled", { aborted: false });
	assert.deepEqual(notices, ["⏱ total 6.0s · agent 6.0s · bash 3.0s ×1, read 3.0s ×1"]);
});

test("agent spans are summed, and a gap after agent_end counts in total only", (t) => {
	const { fire, notices } = setup(t);
	fire("before_agent_start");
	mock.timers.tick(500); // before the first agent_start
	fire("agent_start");
	mock.timers.tick(2000);
	fire("agent_end");
	mock.timers.tick(3000); // e.g. a review gate sending the model back
	fire("agent_start");
	mock.timers.tick(1000);
	fire("agent_end");
	mock.timers.tick(4000); // settle work
	fire("agent_settled", { aborted: false });
	assert.deepEqual(notices, ["⏱ total 11s · agent 3.0s"]);
});

test("nested calls and calls that never ran are skipped", (t) => {
	const { fire, statuses, notices } = setup(t);
	fire("before_agent_start");
	fire("agent_start");
	fire("tool_execution_start", { toolCallId: "c", toolName: "codemode" });
	fire("tool_execution_start", { toolCallId: "n", toolName: "bash", parentToolCallId: "c" });
	fire("tool_execution_start", { toolCallId: "x", toolName: "edit" });
	mock.timers.tick(1000);
	assert.equal(statuses.at(-1), "⏱ 1.0s · agent 1.0s · codemode 1.0s");
	fire("tool_execution_end", { toolCallId: "n", toolName: "bash", parentToolCallId: "c", durationMs: 900 });
	fire("tool_execution_end", { toolCallId: "x", toolName: "edit" });
	fire("tool_execution_end", { toolCallId: "c", toolName: "codemode", durationMs: 1000 });
	fire("agent_end");
	fire("agent_settled", { aborted: false });
	assert.deepEqual(notices, ["⏱ total 1.0s · agent 1.0s · codemode 1.0s ×1"]);
});

test("settle clears the status and stops the ticks, and an abort is marked", (t) => {
	const { fire, statuses, notices } = setup(t);
	fire("before_agent_start");
	fire("agent_start");
	mock.timers.tick(2000);
	fire("agent_settled", { aborted: true }); // no agent_end: the open span counts up to settle
	assert.equal(statuses.at(-1), undefined);
	const n = statuses.length;
	mock.timers.tick(5000);
	assert.equal(statuses.length, n, "no status after settle");
	assert.deepEqual(notices, ["⏱ total 2.0s · agent 2.0s (aborted)"]);
});

test("a second before_agent_start with no settle leaves one interval", (t) => {
	const { fire, statuses } = setup(t);
	fire("before_agent_start");
	fire("before_agent_start");
	const n = statuses.length;
	mock.timers.tick(3000);
	assert.equal(statuses.length, n + 3, "one status per tick");
});

test("session_shutdown mid-run stops the ticks", (t) => {
	const { fire, statuses, notices } = setup(t);
	fire("before_agent_start");
	mock.timers.tick(1000);
	fire("session_shutdown");
	const n = statuses.length;
	mock.timers.tick(5000);
	assert.equal(statuses.length, n);
	fire("agent_settled", { aborted: false });
	assert.deepEqual(notices, [], "a settle after shutdown has no run to report");
});

test("outside tui there is no status and no notice", (t) => {
	const { fire, statuses, notices } = setup(t, "print");
	fire("before_agent_start");
	fire("agent_start");
	mock.timers.tick(3000);
	fire("agent_end");
	fire("agent_settled", { aborted: false });
	assert.deepEqual([statuses, notices], [[], []]);
});

const bash = (toolCallId: string, command = "make test") => ({ toolCallId, toolName: "bash", args: { command } });
const done = (toolCallId: string, durationMs: number, text = "ok") => ({ toolCallId, toolName: "bash", durationMs, result: { content: [{ type: "text", text }] } });

test("a bash command with a usual time shows it, and a run past twice that gets a note", (t) => {
	const { fire, statuses, cwd } = setup(t);
	const { id } = commandKey("make test", cwd)!;
	for (let i = 0; i < 3; i++) record(id, "make", 300000);
	fire("before_agent_start");
	fire("agent_start");
	fire("tool_execution_start", bash("m"));
	mock.timers.tick(1000);
	assert.equal(statuses.at(-1), "⏱ 1.0s · agent 1.0s · bash 1.0s of ~5m 0s");
	mock.timers.tick(600000);
	const content = [{ type: "text", text: "ok" }];
	assert.deepEqual(fire("tool_result", { ...bash("m"), content }), { content: [...content, { type: "text", text: "[took 10m 1s; this command usually takes ~5m 0s here]" }] });
	fire("tool_execution_end", done("m", 601000));
	assert.deepEqual(read()[id].ms, [300000, 300000, 300000, 601000]);
	fire("tool_execution_start", bash("u"));
	mock.timers.tick(1000);
	assert.equal(fire("tool_result", { ...bash("u"), content }), undefined, "under twice the usual time");
});

test("outside tui a bash duration is still recorded, but not an excluded one", (t) => {
	const { fire, cwd } = setup(t, "print");
	const { id } = commandKey("make test", cwd)!;
	fire("tool_execution_start", bash("p"));
	fire("tool_execution_end", done("p", 5000));
	fire("tool_execution_start", bash("x"));
	fire("tool_execution_end", done("x", 9000, "Command timed out after 9 seconds"));
	assert.deepEqual(read()[id].ms, [5000]);
});
