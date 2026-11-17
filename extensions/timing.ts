/**
 * Times each prompt. While it runs, the footer status ticks every second with the total so far, the agent
 * time so far and the longest-running open tool; once it settles, one dim chat line gives the wall time,
 * the agent time (model + tools) and the top tools by time. Only interactive sessions are timed, so a
 * subagent's own pi and print/json mode show nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Tools = Map<string, { ms: number; n: number }>;

/** `0.9s`, `12s`, `1m 23s`. */
export function fmt(ms: number): string {
	if (ms < 9950) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
	// ponytail: no hours, 75m shows as "75m 0s"
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The line shown once a prompt settles: `⏱ total 1m 23s · agent 58s · bash 41s ×12, read 2s ×5`. */
export function summary(r: { total: number; agent: number; tools: Tools; aborted: boolean }): string {
	const top = [...r.tools].sort((a, b) => b[1].ms - a[1].ms).slice(0, 3).map(([name, t]) => `${name} ${fmt(t.ms)} ×${t.n}`);
	return `⏱ total ${fmt(r.total)} · agent ${fmt(r.agent)}${top.length ? ` · ${top.join(", ")}` : ""}${r.aborted ? " (aborted)" : ""}`;
}

/** The footer status while a prompt runs: `⏱ 42s · agent 30s · bash 12s`. */
export function live(r: { total: number; agent: number; running?: { name: string; ms: number } }): string {
	return `⏱ ${fmt(r.total)} · agent ${fmt(r.agent)}${r.running ? ` · ${r.running.name} ${fmt(r.running.ms)}` : ""}`;
}

type Run = { start: number; agent: number; agentStart?: number; tools: Tools; open: Map<string, { name: string; start: number }> };
let run: Run | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

export default function (pi: ExtensionAPI) {
	const status = (ctx: ExtensionContext, r: Run) => {
		const now = Date.now();
		const first = r.open.values().next().value; // open calls in start order
		const agent = r.agent + (r.agentStart === undefined ? 0 : now - r.agentStart);
		ctx.ui.setStatus("time", live({ total: now - r.start, agent, running: first && { name: first.name, ms: now - first.start } }));
	};

	pi.on("before_agent_start", (_event, ctx) => {
		// ponytail: a run that fails while starting never settles; its status ticks until the next prompt
		clearInterval(timer);
		if (ctx.mode !== "tui") return void (run = undefined);
		const r: Run = { start: Date.now(), agent: 0, tools: new Map(), open: new Map() };
		run = r;
		status(ctx, r);
		timer = setInterval(() => {
			try {
				status(ctx, r);
			} catch {} // a replaced session leaves ctx stale
		}, 1000);
	});
	pi.on("agent_start", () => {
		if (run) run.agentStart = Date.now();
	});
	pi.on("agent_end", () => {
		if (run?.agentStart === undefined) return;
		run.agent += Date.now() - run.agentStart;
		run.agentStart = undefined;
	});
	// Nested calls (a codemode script's) are skipped, so they aren't counted twice.
	// ponytail: a UI prompt's wait keeps counting (total, agent, live tool), add ui_prompt_* if it misleads
	pi.on("tool_execution_start", (event) => {
		if (run && !event.parentToolCallId) run.open.set(event.toolCallId, { name: event.toolName, start: Date.now() });
	});
	pi.on("tool_execution_end", (event) => {
		if (!run || event.parentToolCallId) return;
		run.open.delete(event.toolCallId);
		if (event.durationMs === undefined) return; // the tool never ran
		const t = run.tools.get(event.toolName) ?? { ms: 0, n: 0 };
		run.tools.set(event.toolName, { ms: t.ms + event.durationMs, n: t.n + 1 });
	});
	pi.on("agent_settled", (event, ctx) => {
		if (!run) return;
		const now = Date.now();
		// ponytail: abort without agent_end counts up to settle
		if (run.agentStart !== undefined) run.agent += now - run.agentStart;
		clearInterval(timer);
		ctx.ui.setStatus("time", undefined);
		ctx.ui.notify(summary({ total: now - run.start, agent: run.agent, tools: run.tools, aborted: event.aborted }), "info");
		run = undefined;
	});
	// No setStatus: ctx may be stale.
	pi.on("session_shutdown", () => {
		clearInterval(timer);
		run = undefined;
	});
}
