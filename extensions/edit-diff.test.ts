// Run: node --import ./extensions/test-hooks.ts --test extensions/edit-diff.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, mixColors, rgbColor, visibleWidth } from "@earendil-works/pi-tui";
import editDiff, { renderEditDiff } from "./edit-diff.ts";

initTheme();
const colors = { toolDiffAdded: rgbColor(0, 200, 0), toolDiffRemoved: rgbColor(200, 0, 0) };
const theme = {
	fg: (_: string, t: string) => t,
	bold: (t: string) => t,
	bg: (n: string, t: string) => `[${n}]${t}`,
	colors,
	appearance: "dark",
	getColorMode: () => "truecolor",
} as any;
const HINT = "ctrl+o to expand";
const plain = (lines: string[]) => lines.map((l) => stripVTControlCharacters(l).trimEnd());
const bgOf = (token: keyof typeof colors, mix: number) => backgroundAnsi(mixColors(rgbColor(0, 0, 0), colors[token], mix, "srgb"), "truecolor");

test("rows are gutter │ marker code, with each changed line on its own full-width background", () => {
	const rows = renderEditDiff("-1 a\n+1 b\n 2 c", "x.txt", theme, 40, false, HINT);
	assert.deepEqual(plain(rows), ["1 │ - a", "1 │ + b", "2 │   c"]);
	assert.ok(rows[0]!.startsWith(bgOf("toolDiffRemoved", 0.2)));
	assert.ok(rows[1]!.startsWith(bgOf("toolDiffAdded", 0.2)));
	for (const r of rows) assert.equal(visibleWidth(r), 40);
	assert.ok(!rows[2]!.includes("\x1b[48"));
});

test("resets inside a highlighted, truncated row set the background again", () => {
	const long = `+1 const x = /* note */ "${"y".repeat(80)}";`;
	const [row] = renderEditDiff(long, "a.ts", theme, 30, false, HINT);
	assert.equal(visibleWidth(row!), 30);
	assert.ok(stripVTControlCharacters(row!).endsWith("…"));
	const body = row!.slice(0, -"\x1b[49m".length);
	const resets = [...body.matchAll(/\x1b\[(?:0|49)?m/g)];
	assert.ok(resets.length > 0);
	for (const m of resets) assert.equal(body.slice(m.index + m[0].length, m.index + m[0].length + 5), "\x1b[48;");
});

test("long rows are cut, not wrapped, context rows too", () => {
	const rows = renderEditDiff(` 1 ${"c".repeat(100)}\n+2 ${"a".repeat(100)}`, "x.txt", theme, 20, false, HINT);
	assert.equal(rows.length, 2);
	for (const r of rows) assert.equal(visibleWidth(r), 20);
});

test("one line replaced by one line marks only the changed word", () => {
	const strong = { "-": bgOf("toolDiffRemoved", 0.4), "+": bgOf("toolDiffAdded", 0.4) };
	const rows = renderEditDiff("-1 const a = 1;\n+1 const a = 2;", "x.txt", theme, 40, false, HINT);
	for (const [row, sign, word] of [[rows[0]!, "-", "1"], [rows[1]!, "+", "2"]] as const) {
		const at = row.indexOf(strong[sign]);
		assert.ok(at > 0);
		assert.equal(row.indexOf(strong[sign], at + 1), -1);
		const marked = row.slice(at + strong[sign].length).split(bgOf(sign === "-" ? "toolDiffRemoved" : "toolDiffAdded", 0.2))[0]!;
		assert.equal(stripVTControlCharacters(marked), word);
	}
	// Two lines replaced: no word marks.
	const two = renderEditDiff("-1 a\n-2 b\n+1 c", "x.txt", theme, 40, false, HINT);
	assert.ok(two.every((r) => !r.includes(strong["-"]) && !r.includes(strong["+"])));
});

test("more than 20 rows fold until expanded", () => {
	const diff = Array.from({ length: 30 }, (_, i) => `+${String(i + 1).padStart(2)} line`).join("\n");
	const folded = renderEditDiff(diff, "x.txt", theme, 60, false, HINT);
	assert.equal(folded.length, 21);
	assert.equal(stripVTControlCharacters(folded[20]!), "… +10 lines (ctrl+o to expand)");
	assert.equal(renderEditDiff(diff, "x.txt", theme, 60, true, HINT).length, 30);
});

const register = () => {
	let tool: any;
	editDiff({ registerTool: (t: any) => (tool = t) } as any);
	return tool;
};

test("the registered edit is pi's own tool with a new call display", () => {
	const tool = register();
	assert.equal(tool.name, "edit");
	assert.ok(tool.parameters && tool.execute);
	assert.equal(tool.renderShell, "self");
});

// Mirrors ToolExecutionComponent: one state per row, renderCall then renderResult in each update, each handed its
// last component back, and an invalidate that invalidates the mounted components and runs the update again.
function host(args: any, cwd: string, outputPad = 1) {
	const tool = register();
	const state = {};
	let call: any, shown: any, result: any;
	let invalidated = () => {};
	const ctx = (last: any) => ({
		args, toolCallId: "t", state, cwd, argsComplete: true, executionStarted: true, isPartial: !result,
		expanded: false, isError: result?.isError ?? false, outputPad, lastComponent: last,
		keyText: () => "ctrl+o", keyHint: (_k: string, d: string) => `ctrl+o ${d}`,
		invalidate: () => (call?.invalidate(), shown?.invalidate?.(), update(), invalidated()),
	});
	const update = () => {
		call = tool.renderCall(args, theme, ctx(call));
		if (result) shown = tool.renderResult(result, { expanded: false, isPartial: false }, theme, ctx(shown));
	};
	update();
	return {
		state: state as any,
		get call() { return call; },
		render: (w: number) => [...call.render(w), ...(shown?.render(w) ?? [])],
		preview: () => new Promise<void>((resolve) => (invalidated = resolve)),
		finish: (r: any) => ((result = r), update()),
	};
}

test("the row shows pi's pending box, then the diff without the box background, and follows the result", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "edit-diff-"));
	writeFileSync(join(cwd, "f.ts"), "const a = 1;\nconst b = 2;\n");
	const h = host({ path: "f.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 3;" }] }, cwd);
	const inner = h.state.callComponent;
	assert.ok(h.render(60).join("\n").includes("[toolPendingBg]"));
	await h.preview();
	const text = h.render(60).join("\n");
	assert.ok(text.includes("edit") && text.includes("│ - ") && text.includes("│ + "), text);
	assert.ok(!text.includes("[toolSuccessBg]") && !text.includes("[toolPendingBg]"));
	assert.equal(h.state.callComponent, inner);
	// The result's diff reaches the wrapper already mounted, since renderResult runs after renderCall.
	const mounted = h.call;
	h.finish({ content: [], details: { diff: "-1 const a = 1;\n+1 const a = 9;" } });
	assert.equal(h.state.callComponent, inner);
	assert.match(stripVTControlCharacters(mounted.render(60).join("\n")), /const a = 9/);
});

test("a missing file shows pi's error", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "edit-diff-"));
	const h = host({ path: "nope.ts", edits: [{ oldText: "a", newText: "b" }] }, cwd);
	await h.preview();
	assert.match(stripVTControlCharacters(h.render(60).join("\n")), /Could not edit file/);
});

test("outputPad never pushes rows past the outer width", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "edit-diff-"));
	writeFileSync(join(cwd, "f.ts"), `${"z".repeat(200)}\n`);
	const h = host({ path: "f.ts", edits: [{ oldText: "z".repeat(200), newText: "q".repeat(200) }] }, cwd, 3);
	await h.preview();
	const lines = h.render(50);
	assert.ok(stripVTControlCharacters(lines.join("\n")).includes("│ + "));
	for (const l of lines) assert.ok(visibleWidth(l) <= 50, `${visibleWidth(l)}`);
});
