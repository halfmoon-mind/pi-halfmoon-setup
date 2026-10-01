// Run: node --import ./extensions/test-hooks.ts --test extensions/pi-claude-cli/pi-claude-cli.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import extension from "./index.ts";

// A stand-in `claude` on PATH: records how it was called, then replays the stream-json lines in $FAKE_CLAUDE.
const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
const record = join(dir, "record.json");
writeFileSync(
	join(dir, "claude"),
	`#!/usr/bin/env node
	const fs = require("node:fs");
	const args = process.argv.slice(2);
	if (args[0] === "--version" || args[0] === "auth") process.exit(0);
	const { lines = [], stderr = "", exit = 0, hang } = JSON.parse(process.env.FAKE_CLAUDE);
	const sys = args.includes("--append-system-prompt") ? fs.readFileSync(args[args.indexOf("--append-system-prompt") + 1], "utf8") : null;
	require("node:readline").createInterface({ input: process.stdin }).once("line", (line) => {
		fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, args, sys, input: JSON.parse(line) }));
		const out = lines.map((l) => JSON.stringify(l) + "\\n").join("");
		process.stderr.write(stderr, () => process.stdout.write(out, () => hang || process.exit(exit)));
	});`,
	{ mode: 0o755 },
);
process.env.PATH = dir + delimiter + process.env.PATH;

let provider: any;
extension({ on() {}, getAllTools: () => [], registerProvider: (_id: string, def: any) => (provider = def) } as any);
const opus = { ...provider.models.find((m: any) => m.id.includes("opus")), provider: "pi-claude-cli", api: "pi-claude-cli" };

function run(fake: object, messages: object[], options: object = {}) {
	process.env.FAKE_CLAUDE = JSON.stringify(fake);
	return provider.streamSimple(opus, { messages }, { cwd: dir, ...options }).result();
}
const event = (event: object) => ({ type: "stream_event", event, parent_tool_use_id: null });
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
const recorded = () => JSON.parse(readFileSync(record, "utf8"));

test("pi 0.99's system message reaches claude as the system prompt, and claude keeps no session of its own", async () => {
	const lines = [
		event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
		event({ type: "content_block_stop", index: 0 }),
		event({ type: "message_stop" }),
		{ type: "result", subtype: "success" },
	];
	const messages = [
		{ role: "system", content: "You are pi.", timestamp: 1 },
		{ role: "user", content: "hi", timestamp: 2 },
	];
	const reply = await run({ lines }, messages, { sessionId: "s1", reasoning: "high" });

	const { args, sys, input } = recorded();
	assert.deepEqual([flag(args, "--model"), flag(args, "--effort")], [opus.id, "max"]);
	assert.ok(args.includes("--no-session-persistence") && !args.includes("--session-id") && !args.includes("--resume"));
	assert.match(sys, /^You are pi\./);
	assert.equal(input.message.content, "USER:\nhi");
	assert.deepEqual([reply.stopReason, reply.content], ["stop", [{ type: "text", text: "Hello" }]]);
});

// The kill above stops claude before it saves its tool calls, so only pi's history has them.
test("after tool calls, claude gets pi's whole history with the system prompt, including its own tool calls", async () => {
	const lines = [event({ type: "message_stop" }), { type: "result", subtype: "success" }];
	const messages = [
		{ role: "system", content: "You are pi.", timestamp: 1 },
		{ role: "user", content: "read /a.txt, then delegate", timestamp: 2 },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/a.txt" } }], timestamp: 3 },
		{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "A" }], timestamp: 4 },
		{ role: "assistant", content: [{ type: "toolCall", id: "t2", name: "subagent", arguments: { task: "x" } }], timestamp: 5 },
		{ role: "toolResult", toolCallId: "t2", toolName: "subagent", content: [{ type: "text", text: "done" }], timestamp: 6 },
	];
	await run({ lines }, messages, { sessionId: "s1" });

	const { args, sys, input } = recorded();
	assert.ok(!args.includes("--resume"));
	assert.match(sys, /^You are pi\./);
	assert.equal(
		input.message.content,
		[
			"USER:",
			"read /a.txt, then delegate",
			"ASSISTANT:",
			'Historical tool call (non-executable): Read args={"file_path":"/a.txt"}',
			"TOOL RESULT (historical Read):",
			"A",
			"ASSISTANT:",
			'[Used subagent tool with args: {"task":"x"}]',
			"TOOL RESULT (subagent):",
			"done",
		].join("\n"),
	);
});

test("a tool call pi can run reaches pi with pi's names, and claude is killed before it runs the tool itself", async () => {
	const lines = [
		// Claude Code's internal tools are not pi's to run, so they never reach pi.
		event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t0", name: "ToolSearch" } }),
		event({ type: "content_block_stop", index: 0 }),
		event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Read" } }),
		event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"/a.txt"}' } }),
		event({ type: "content_block_stop", index: 1 }),
		event({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
		event({ type: "message_stop" }),
	];
	const reply = await run({ lines, hang: true }, [{ role: "user", content: "read /a.txt", timestamp: 1 }]);

	assert.deepEqual(
		[reply.stopReason, reply.content],
		["toolUse", [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/a.txt" } }]],
	);
	// kill(pid, 0) also succeeds on a zombie, so wait for the kill to be reaped.
	const { pid } = recorded();
	const alive = () => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const deadline = Date.now() + 2000;
	while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(alive(), false);
});

test("a claude crash ends the turn with claude's stderr", async () => {
	const reply = await run({ stderr: "Not logged in", exit: 1 }, [{ role: "user", content: "hi", timestamp: 1 }]);
	assert.deepEqual(reply.content, [{ type: "text", text: "Error: Claude CLI exited with code 1: Not logged in" }]);
});
