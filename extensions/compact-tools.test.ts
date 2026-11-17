// Run: node --import ./extensions/test-hooks.ts --test extensions/compact-tools.test.ts
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import compactTools, { compact, groupCalls, hideWhenCollapsed, shortCommand, summary } from "./compact-tools.ts";
import pdfRead from "./pdf-read.ts";

const theme = { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t } as any;
const lines = (c: any) => c.render(80).map((l: string) => l.trim()).filter(Boolean);

test("pi's looking-around tools and bash are all replaced", () => {
	const tools: Record<string, any> = {};
	compactTools({ registerTool: (t: any) => (tools[t.name] = t), on: () => {} } as any);
	pdfRead({ registerTool: (t: any) => (tools[t.name] = t) } as any);
	assert.deepEqual(Object.keys(tools).sort(), ["bash", "find", "grep", "ls", "read"]);
	assert.ok(tools.read.execute && tools.read.renderShell === "self");
});

test("calls made together share one line on the first row; the rest draw nothing unless expanded or failed", () => {
	groupCalls([
		{ type: "toolCall", id: "a", name: "read", arguments: { path: "/x/router.ts" } },
		{ type: "toolCall", id: "b", name: "grep", arguments: { pattern: "registerTool" } },
		{ type: "toolCall", id: "c", name: "read", arguments: { path: "footer.ts" } },
		{ type: "toolCall", id: "d", name: "bash", arguments: { command: "ls" } },
		{ type: "toolCall", id: "e", name: "read", arguments: { path: "alone.ts" } },
	]);
	const tool = compact({
		name: "read",
		renderCall: (args: any) => new Text(`read ${args.path}`, 0, 0),
		renderResult: () => new Text("file body", 0, 0),
	} as any);
	const row = (id: string, args: any, { expanded = false, isError = false } = {}) => {
		const ctx = { toolCallId: id, state: {}, expanded, isError, isPartial: false, outputPad: 1, invalidate: () => {} } as any;
		const call = tool.renderCall!(args, theme, ctx);
		tool.renderResult!({} as any, { expanded, isPartial: false }, theme, ctx);
		return lines(call);
	};
	assert.deepEqual(row("a", { path: "/x/router.ts" }), ["read 2 · grep 1  router.ts, /registerTool/, footer.ts"]);
	assert.deepEqual(row("c", { path: "footer.ts" }), []);
	assert.deepEqual(row("c", { path: "footer.ts" }, { isError: true }), ["read footer.ts", "file body"]);
	assert.deepEqual(row("c", { path: "footer.ts" }, { expanded: true }), ["read footer.ts", "file body"]);
	// Alone, after another tool: its own call line, output hidden.
	assert.deepEqual(row("e", { path: "alone.ts" }), ["read alone.ts"]);
	assert.equal(summary([{ id: "z", name: "ls", args: {} }]).targets, ".");
});

test("bash output stays hidden until expanded, and its blank never goes back to be reused", () => {
	const shown = new Text("output", 0, 0);
	const render = hideWhenCollapsed((() => shown) as any);
	const run = (expanded: boolean, isError: boolean) => render({} as any, { expanded } as any, {} as any, { isError } as any);
	assert.equal(run(true, false), shown);
	assert.equal(run(false, true), shown);
	const blank = run(false, false);
	assert.notEqual(blank, shown);
	let reused: unknown = "unset";
	hideWhenCollapsed(((_r: any, _o: any, _t: any, c: any) => (reused = c.lastComponent)) as any)({} as any, { expanded: true } as any, {} as any, { lastComponent: blank } as any);
	assert.equal(reused, undefined);
});

test("a collapsed bash call shows the command's first line, cut short, and how many lines it hides", () => {
	assert.equal(shortCommand("ls -la"), "ls -la");
	assert.equal(shortCommand("cd x; python3 - <<'EOF'\nprint(1)\nEOF\n"), "cd x; python3 - <<'EOF' … (+2 lines)");
	assert.equal(shortCommand("a".repeat(120)), `${"a".repeat(100)}…`);
});

test("a collapsed bash call drops a leading cd into the session's directory, and only that one", () => {
	const cwd = join(homedir(), "proj");
	assert.equal(shortCommand(`cd ${cwd}; sed -n 1,17p a.ts`, cwd), "sed -n 1,17p a.ts");
	assert.equal(shortCommand(`cd "${cwd}" && git status`, cwd), "git status");
	assert.equal(shortCommand("cd ~/proj && ls", cwd), "ls");
	assert.equal(shortCommand(`cd ${cwd}/sub && ls`, cwd), `cd ${cwd}/sub && ls`, "another dir says where it runs");
	assert.equal(shortCommand(`cd ${cwd} && python3 - <<'EOF'\nprint(1)\nEOF`, cwd), "python3 - <<'EOF' … (+2 lines)");

	// Expanded, the call shows the command as written.
	initTheme();
	const tools: Record<string, any> = {};
	compactTools({ registerTool: (t: any) => (tools[t.name] = t), on: () => {} } as any);
	const call = (expanded: boolean) =>
		stripVTControlCharacters(tools.bash.renderCall({ command: `cd ${cwd}; ls` }, theme, { expanded, cwd, state: {}, executionStarted: false }).render(200).join("\n"));
	assert.ok(call(true).includes(`cd ${cwd}; ls`));
	assert.ok(!call(false).includes("cd "));
	assert.match(call(false), /\$ ls/);
});

test("a read wrapped by another module copy (pi loads pdf-read.ts with its own) still joins the groups", async () => {
	const other = await import("./compact-tools.ts?pdf-read-copy");
	groupCalls([
		{ type: "toolCall", id: "p", name: "read", arguments: { path: "a.ts" } },
		{ type: "toolCall", id: "q", name: "ls", arguments: { path: "src" } },
	]);
	const tool = other.compact({ name: "read", renderCall: () => new Text("read a.ts", 0, 0), renderResult: () => new Text("", 0, 0) } as any);
	const ctx = { toolCallId: "p", state: {}, expanded: false, isError: false, isPartial: false, outputPad: 1, invalidate: () => {} } as any;
	assert.deepEqual(lines(tool.renderCall!({ path: "a.ts" }, theme, ctx)), ["read 1 · ls 1  a.ts, src"]);
});
