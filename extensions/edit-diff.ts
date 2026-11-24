// edit's diff drawn delta-style: a dim line-number gutter and `│`, a +/- marker, syntax-highlighted code, and a
// red/green background per changed line instead of the tool box's background. Long diffs fold to FOLD rows until
// ctrl+o. pi's own renderer still runs underneath (its preview, async invalidate, error display and the swap to the
// result diff); this only draws what it computed, since pi does not export computeEditsDiff.
import { createEditToolDefinition, type ExtensionAPI, getLanguageFromPath, highlightCode, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, type Component, backgroundAnsi, mixColors, rgbColor, sliceByColumn, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const FOLD = 20;
// ponytail: line/word backgrounds are the diff colors mixed 20%/40% into black (dark) or white (light); tune here.
const LINE_MIX = 0.2;
const WORD_MIX = 0.4;

type Row = { sign: string; num: string; text: string; code?: string; span?: [number, number] };
type Preview = { diff: string } | { error: string } | undefined;

/** pi's display diff ("+12 code", "-12 code", " 12 code", "    ...") as delta-style rows, each exactly `width` wide. */
export function renderEditDiff(diff: string, path: string, theme: any, width: number, expanded: boolean, hint: string): string[] {
	const rows: Row[] = diff.split("\n").map((line) => {
		const m = /^([+-\s])(\s*\d*)\s(.*)$/.exec(line);
		return m ? { sign: m[1]!, num: m[2]!, text: m[3]!.replace(/\t/g, "   ") } : { sign: " ", num: "", text: line };
	});
	const skip = (r: Row) => r.sign === " " && !r.num.trim();
	// Each side is highlighted as one blob, so a multi-line comment or string keeps its color on every line.
	const side = (keep: string) => {
		const own = rows.filter((r) => !skip(r) && (r.sign === " " || r.sign === keep));
		const lines = highlightCode(own.map((r) => r.text).join("\n"), getLanguageFromPath(path));
		if (lines.length === own.length) own.forEach((r, i) => (r.code ??= lines[i]));
	};
	side("+"); // context rows take the new side's colors
	side("-");
	// Like pi, words are marked only when exactly one line was replaced by one line: the span between their common prefix and suffix.
	for (let i = 0; i + 1 < rows.length; i++) {
		const [a, b] = [rows[i]!, rows[i + 1]!];
		if (a.sign !== "-" || b.sign !== "+" || rows[i - 1]?.sign === "-" || rows[i + 2]?.sign === "+") continue;
		let p = 0;
		while (p < a.text.length && a.text[p] === b.text[p]) p++;
		let s = 0;
		while (s < Math.min(a.text.length, b.text.length) - p && a.text.at(-1 - s) === b.text.at(-1 - s)) s++;
		for (const r of [a, b]) r.span = [visibleWidth(r.text.slice(0, p)), visibleWidth(r.text.slice(p, r.text.length - s))];
	}
	const base = theme.appearance === "dark" ? rgbColor(0, 0, 0) : rgbColor(255, 255, 255);
	const bg = (token: string, mix: number) => backgroundAnsi(mixColors(base, theme.colors[token], mix, "srgb"), theme.getColorMode());
	const out = rows.map((r) => {
		const token = r.sign === "+" ? "toolDiffAdded" : r.sign === "-" ? "toolDiffRemoved" : undefined;
		let code = skip(r) ? theme.fg("dim", r.text) : (r.code ?? r.text);
		const lineBg = token ? bg(token, LINE_MIX) : "";
		if (token && r.span && r.span[1] > 0) {
			const [start, len] = r.span;
			code = sliceByColumn(code, 0, start) + bg(token, WORD_MIX) + sliceByColumn(code, start, len) + lineBg + sliceByColumn(code, start + len, Infinity);
		}
		const marker = token ? theme.fg(token, r.sign) : " ";
		const row = truncateToWidth(`${theme.fg("dim", `${r.num} │`)} ${marker} ${code}`, width, "…", true);
		// Resets inside the row (from truncation or the highlighter) would drop the line's background, so it is set again after each.
		return token ? `${lineBg}${row.replace(/\x1b\[(?:0|49)?m/g, (m) => m + lineBg)}\x1b[49m` : row;
	});
	if (expanded || out.length <= FOLD) return out;
	const more = `${theme.fg("muted", `… +${out.length - FOLD} lines (`)}${hint}${theme.fg("muted", ")")}`;
	return [...out.slice(0, FOLD), truncateToWidth(more, width, "…")];
}

export default function (pi: ExtensionAPI) {
	const def = createEditToolDefinition(process.cwd());
	const renderCall = def.renderCall!;
	pi.registerTool({
		...def,
		renderCall(args, theme, ctx) {
			// pi's renderer adopts any Box handed back as its own, so it gets none and keeps its Box in state.callComponent.
			renderCall(args, theme, { ...ctx, lastComponent: undefined });
			const s = ctx.state as { callComponent: Box & { preview: Preview }; cache?: { key: string; colors: object; lines: string[] } };
			const inner = s.callComponent;
			const path = String(args?.file_path ?? args?.path ?? "");
			const hint = ctx.keyHint("app.tools.expand", "to expand");
			const rows: Component = {
				render(width) {
					const diff = (inner.preview as { diff: string }).diff;
					const key = JSON.stringify([diff, path, width, ctx.expanded, theme.appearance, theme.getColorMode(), hint]);
					if (s.cache?.key !== key || s.cache.colors !== theme.colors) {
						s.cache = { key, colors: theme.colors, lines: renderEditDiff(diff, path, theme, width, ctx.expanded, hint) };
					}
					return s.cache.lines;
				},
				invalidate() {},
			};
			// The preview arrives later (async, or from renderResult in the same update), so it is read when drawn.
			return {
				render(width) {
					const preview = inner.preview;
					if (!preview || "error" in preview) return inner.render(width);
					const box = new Box(ctx.outputPad, 1);
					box.addChild(inner.children[0]!);
					box.addChild(new Spacer(1));
					box.addChild(rows);
					return box.render(width);
				},
				// Not ctx.invalidate(): the host's invalidate re-runs renderCall, which would come back here.
				invalidate() {
					s.cache = undefined;
					inner.invalidate();
				},
			};
		},
	} as ToolDefinition<any, any>);
}
