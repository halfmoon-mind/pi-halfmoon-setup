// Run: node --import ./extensions/test-hooks.ts --test extensions/pi-claude-cli/pi-claude-cli.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import extension, { formatRateLimits } from "./index.ts";

// A stand-in `claude` on PATH that records how it was called and what reached it. $FAKE_CLAUDE lists its
// steps: read the next stdin message, call a tool through the MCP server like the CLI does, write stream-json
// lines, exit, or hang. { lines, stderr, exit, hang } is short for reading the prompt, then writing and exiting.
const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
const record = join(dir, "record.json");
writeFileSync(
	join(dir, "claude"),
	`#!/usr/bin/env node
	const fs = require("node:fs");
	const readline = require("node:readline");
	const args = process.argv.slice(2);
	if (args[0] === "--version" || args[0] === "auth") process.exit(0);
	const { lines = [], stderr = "", exit = 0, hang, steps = [{ read: true }, { stderr, lines }, hang ? { hang } : { exit }] } = JSON.parse(process.env.FAKE_CLAUDE);
	const sys = args.includes("--append-system-prompt") ? fs.readFileSync(args[args.indexOf("--append-system-prompt") + 1], "utf8") : null;
	const seen = { pid: process.pid, args, sys, inputs: [], toolResults: [] };
	const stdin = readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]();
	const write = (stream, text) => new Promise((resolve) => stream.write(text, resolve));
	let mcp;
	async function callTool(id) {
		if (!mcp) {
			const server = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers["custom-tools"];
			mcp = require("node:child_process").spawn(server.command, server.args, { stdio: ["pipe", "pipe", "inherit"] });
			mcp.lines = readline.createInterface({ input: mcp.stdout })[Symbol.asyncIterator]();
		}
		const params = { name: "read", arguments: {}, _meta: { "claudecode/toolUseId": id } };
		mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }) + "\\n");
		seen.toolResults.push(JSON.parse((await mcp.lines.next()).value).result);
	}
	(async () => {
		for (const step of steps) {
			if (step.read) seen.inputs.push(JSON.parse((await stdin.next()).value));
			if (step.call) await callTool(step.call);
			if (step.stderr) await write(process.stderr, step.stderr);
			if (step.lines) await write(process.stdout, step.lines.map((l) => JSON.stringify(l) + "\\n").join(""));
			fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(seen));
			if ("exit" in step) process.exit(step.exit);
		}
	})();`,
	{ mode: 0o755 },
);
process.env.PATH = dir + delimiter + process.env.PATH;

let provider: any;
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
const handlers: Record<string, any> = {};
extension({
	on: (name: string, handler: any) => (handlers[name] = handler),
	getAllTools: () => tools,
	setActiveTools() {},
	registerProvider: (_id: string, def: any) => (provider = def),
} as any);
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

	const { args, sys, inputs } = recorded();
	assert.deepEqual(
		["--model", "--effort", "--thinking-display", "--permission-mode", "--tools"].map((name) => flag(args, name)),
		[opus.id, "max", "summarized", "default", "WebSearch,WebFetch"],
	);
	assert.ok(["--no-session-persistence", "--strict-mcp-config"].every((name) => args.includes(name)));
	assert.ok(!args.includes("--session-id") && !args.includes("--resume"));
	assert.match(sys, /^You are pi\./);
	assert.equal(inputs[0].message.content, "USER:\nhi");
	assert.deepEqual([reply.stopReason, reply.content], ["stop", [{ type: "text", text: "Hello" }]]);
});

// A new claude process starts with no conversation: the first call, or one the running process cannot take.
test("a new claude process gets pi's whole history with the system prompt, including its tool calls and reasoning", async () => {
	const lines = [event({ type: "message_stop" }), { type: "result", subtype: "success" }];
	const messages = [
		{ role: "system", content: "You are pi.", timestamp: 1 },
		{ role: "user", content: "read /a.txt, then delegate", timestamp: 2 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Start with a.txt.", thinkingSignature: "sig" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/a.txt" } },
			],
			timestamp: 3,
		},
		{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "A" }], timestamp: 4 },
		{ role: "assistant", content: [{ type: "toolCall", id: "t2", name: "subagent", arguments: { task: "x" } }], timestamp: 5 },
		{ role: "toolResult", toolCallId: "t2", toolName: "subagent", content: [{ type: "text", text: "done" }], timestamp: 6 },
	];
	await run({ lines }, messages, { sessionId: "s1" });

	const { args, sys, inputs } = recorded();
	assert.ok(!args.includes("--resume"));
	assert.match(sys, /^You are pi\./);
	assert.equal(
		inputs[0].message.content,
		[
			"USER:",
			"read /a.txt, then delegate",
			"ASSISTANT:",
			// Without its reasoning the model would plan each step again from scratch.
			"[Thinking] Start with a.txt.",
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

test("claude waits in its MCP call for the result pi sends next, then goes on in the same process, which also takes the next prompt", async () => {
	const toolUse = [
		// Claude Code's internal tools are not pi's to run, so they never reach pi.
		event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t0", name: "ToolSearch" } }),
		event({ type: "content_block_stop", index: 0 }),
		event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "mcp__custom-tools__read" } }),
		event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"/a.txt"}' } }),
		event({ type: "content_block_stop", index: 1 }),
		event({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
		event({ type: "message_stop" }),
	];
	const say = (text: string) => [
		event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		event({ type: "content_block_stop", index: 0 }),
		event({ type: "message_stop" }),
		{ type: "result", subtype: "success" },
	];
	const fake = { steps: [{ read: true }, { lines: toolUse }, { call: "t1" }, { lines: say("a.txt says A") }, { read: true }, { lines: say("bye") }, { exit: 0 }] };
	const ask = { role: "user", content: "read /a.txt", timestamp: 1 };

	const call = await run(fake, [ask]);
	assert.deepEqual([call.stopReason, call.content], ["toolUse", [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/a.txt" } }]]);
	const result = { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "A" }], isError: false, timestamp: 2 };
	const answer = await run(fake, [ask, call, result]);
	assert.deepEqual(answer.content, [{ type: "text", text: "a.txt says A" }]);
	const bye = await run(fake, [ask, call, result, answer, { role: "user", content: "thanks", timestamp: 3 }]);
	assert.deepEqual(bye.content, [{ type: "text", text: "bye" }]);

	// The one process got the prompt, then pi's tool result as the MCP call's result, then only the new message.
	const { inputs, toolResults } = recorded();
	assert.deepEqual(toolResults, [{ content: [{ type: "text", text: "A" }], isError: false }]);
	assert.deepEqual(inputs.map((input: any) => input.message.content), ["USER:\nread /a.txt", [{ type: "text", text: "thanks" }]]);
});

test("a claude crash ends the turn with claude's stderr", async () => {
	const reply = await run({ stderr: "Not logged in", exit: 1 }, [{ role: "user", content: "hi", timestamp: 1 }]);
	assert.deepEqual(reply.content, [{ type: "text", text: "Error: Claude CLI exited with code 1: Not logged in" }]);
});

test("an error claude reports mid-reply, or an exit without a result, still shows up after the partial reply", async () => {
	const thinking = event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
	const failed = { type: "result", subtype: "error_during_execution", is_error: true, errors: ["API Error: 529 Overloaded"] };
	const hi = [{ role: "user", content: "hi", timestamp: 1 }];

	const reported = await run({ lines: [thinking, failed] }, hi);
	assert.deepEqual(reported.content.at(-1), { type: "text", text: "Error: API Error: 529 Overloaded" });

	const exited = await run({ lines: [thinking] }, hi);
	assert.deepEqual(exited.content.at(-1), { type: "text", text: "Error: Claude CLI exited before it finished the reply" });
});

test("the subscription usage claude reports goes to the footer, with the reset time once a window is nearly used", async () => {
	const statuses: Record<string, string> = {};
	await handlers.session_start({}, { hasUI: true, ui: { setStatus: (key: string, text: string) => (statuses[key] = text), theme: { fg: (_color: string, text: string) => `<${text}>` } } });
	const limits = (fiveHour: number, sevenDay: number) => ({
		type: "rate_limit_event",
		rate_limit_info: {
			status: "allowed",
			unifiedWindows: { five_hour: { utilization: fiveHour, resetsAt: 1790854800 }, seven_day: { utilization: sevenDay, resetsAt: 1790978400 } },
		},
	});
	const lines = [event({ type: "message_stop" }), limits(0.03, 0.64), { type: "result", subtype: "success" }];
	await run({ lines }, [{ role: "user", content: "hi", timestamp: 1 }]);
	assert.equal(statuses.claude, "claude 5h 3% · 7d 64%");
	assert.match(formatRateLimits(limits(0.85, 0.64).rate_limit_info)!, /^<claude 5h 85% ↻\d\d:\d\d · 7d 64%>$/);
});
