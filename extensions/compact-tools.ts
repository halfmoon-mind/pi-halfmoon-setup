// Looking around (read, grep, find, ls) shows just its call line, and calls made together share one
// line ("read 3 · grep 1  router.ts, footer.ts, …"). bash shows only its command's first line. ctrl+o
// shows everything, and errors always show. edit and write keep pi's display: their diffs are the work.
// read is overridden in pdf-read.ts, so it wraps itself there with compact().
import { basename } from "node:path";
import {
	createBashToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Text } from "@earendil-works/pi-tui";

type RenderResult = NonNullable<ToolDefinition["renderResult"]>;
type RenderCall = NonNullable<ToolDefinition["renderCall"]>;
type Call = { id: string; name: string; args: Record<string, unknown> };
const LOOK = new Set(["read", "grep", "find", "ls"]);
const COMMAND_CHARS = 100;
const SUMMARY_CHARS = 150;

/** Each call made together with other looking-around calls, mapped to its whole run. */
const groups = new Map<string, Call[]>();
const invalidators = new Map<string, () => void>();

/** Runs of 2+ looking-around calls in an assistant message share one line; another tool breaks a run. */
export function groupCalls(content: unknown) {
	if (!Array.isArray(content)) return;
	let run: Call[] = [];
	const flush = () => {
		if (run.length > 1) for (const c of run) groups.set(c.id, run), invalidators.get(c.id)?.();
		run = [];
	};
	for (const b of content) {
		if (b?.type !== "toolCall") continue;
		if (LOOK.has(b.name)) run.push({ id: b.id, name: b.name, args: b.arguments ?? {} });
		else flush();
	}
	flush();
}

export function summary(run: Call[]): { counts: string; targets: string } {
	const counts = new Map<string, number>();
	for (const c of run) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
	const target = ({ name, args }: Call) =>
		name === "read" ? basename(String(args.path ?? "")) : name === "grep" ? `/${args.pattern}/` : String((name === "find" ? args.pattern : args.path) ?? ".");
	let targets = run.map(target).join(", ");
	if (targets.length > SUMMARY_CHARS) targets = `${targets.slice(0, SUMMARY_CHARS)}…`;
	return { counts: [...counts].map(([n, k]) => `${n} ${k}`).join(" · "), targets };
}

/** A looking-around tool that shows no output until expanded, and shares one line with calls made alongside it. */
export function compact<T extends ToolDefinition<any, any>>(def: T): T {
	const renderCall = def.renderCall!;
	const renderResult = def.renderResult!;
	return {
		...def,
		// Rows we fold must draw nothing at all, which only a self-drawn shell can do.
		renderShell: "self",
		renderCall(args, theme, ctx) {
			invalidators.set(ctx.toolCallId, ctx.invalidate);
			const s = ctx.state as { box?: Box; call?: Component; result?: Component };
			const run = ctx.expanded ? undefined : groups.get(ctx.toolCallId);
			s.box = undefined;
			if (run && run[0]!.id !== ctx.toolCallId && !ctx.isError) return new Container();
			const bg = ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg";
			const box = new Box(ctx.outputPad, 1, (t: string) => theme.bg(bg, t));
			if (run && run[0]!.id === ctx.toolCallId) {
				const { counts, targets } = summary(run);
				box.addChild(new Text(`${theme.fg("toolTitle", theme.bold(counts))}  ${theme.fg("accent", targets)}`, 0, 0));
			} else {
				s.call = renderCall(args, theme, { ...ctx, lastComponent: s.call });
				box.addChild(s.call);
			}
			s.box = box;
			return box;
		},
		renderResult(result, options, theme, ctx) {
			const s = ctx.state as { box?: Box; result?: Component };
			if (s.box && (options.expanded || ctx.isError)) {
				s.result = renderResult(result, options, theme, { ...ctx, lastComponent: s.result });
				s.box.addChild(s.result);
			}
			return new Container();
		},
	} as T;
}

// pi hands the last returned component back to the renderer to reuse; ours is a blank Text that
// bash's renderer (which reuses a Container) can't take, so a renderer never gets one back.
const blanks = new WeakSet<object>();

export function hideWhenCollapsed<R extends RenderResult>(render: R): R {
	return ((result, options, theme, context) => {
		if (options.expanded || context.isError) {
			const last = context.lastComponent && blanks.has(context.lastComponent) ? undefined : context.lastComponent;
			return render(result, options, theme, { ...context, lastComponent: last });
		}
		const blank = new Text("", 0, 0);
		blanks.add(blank);
		return blank;
	}) as R;
}

/** The command's first line, cut at COMMAND_CHARS, with how many lines are hidden. */
export function shortCommand(command: string): string {
	const lines = command.trim().split("\n");
	let first = lines[0]!;
	if (first.length > COMMAND_CHARS) first = `${first.slice(0, COMMAND_CHARS)}…`;
	return lines.length > 1 ? `${first} … (+${lines.length - 1} lines)` : first;
}

function shortCallWhenCollapsed(render: RenderCall): RenderCall {
	return (args, theme, context) =>
		render(context.expanded || typeof args?.command !== "string" ? args : { ...args, command: shortCommand(args.command) }, theme, context);
}

export default function (pi: ExtensionAPI) {
	for (const def of [createGrepToolDefinition(process.cwd()), createFindToolDefinition(process.cwd()), createLsToolDefinition(process.cwd())]) {
		pi.registerTool(compact(def));
	}
	const bash = createBashToolDefinition(process.cwd());
	pi.registerTool({ ...bash, renderCall: shortCallWhenCollapsed(bash.renderCall!), renderResult: hideWhenCollapsed(bash.renderResult!) });

	pi.on("message_update", (e) => groupCalls(e.message.role === "assistant" ? e.message.content : undefined));
	pi.on("message_end", (e) => groupCalls(e.message.role === "assistant" ? e.message.content : undefined));
	// A resumed session's history: group its calls too.
	pi.on("session_start", (_e, ctx) => {
		groups.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") groupCalls(entry.message.content);
		}
	});
}
