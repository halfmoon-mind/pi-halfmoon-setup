/**
 * Plan first, then build from a clean context. For a code change bigger than a quick fix, the model
 * writes a plan file under docs/plans/ and calls `handoff`, which reads the session's state and picks
 * where the build runs: a new session when this one is full or compacted (or the model says it is
 * messy), else here, through the worker subagent. The plan file carries the work across sessions, and
 * the review gate checks its ticked steps. Only interactive sessions (and print mode under the eval,
 * PI_EVAL=1) get the tool, so a subagent's own pi never plans or hands off. `/handoff <plan>` starts a
 * plan in a new session by hand.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { gated, lintPlan } from "./checks.ts";

export const FULL_PERCENT = 50;
export const PLAN_ENTRY = "handoff-plan";
export const PLANS_DIR = "docs/plans/";

type Entry = { type: string; customType?: string; data?: any; message?: any };

/** What the session shows about its own state: context use, compactions, failed tool calls, review-gate BLOCKs. */
export function signals(branch: Entry[], percent: number | null | undefined) {
	let compactions = 0;
	let toolErrors = 0;
	let blocks = 0;
	for (const e of branch) {
		if (e.type === "compaction") compactions++;
		else if (e.type === "message" && e.message?.role === "toolResult" && e.message.isError) toolErrors++;
		else if (e.type === "custom" && e.customType === "review-gate" && String(e.data?.verdict).startsWith("BLOCK")) blocks++;
	}
	return { percent: percent ?? null, compactions, toolErrors, blocks };
}

/** Why the build must leave this session, or undefined when it may stay. */
export function forcedReason(s: ReturnType<typeof signals>): string | undefined {
	if (s.percent != null && s.percent >= FULL_PERCENT) return `context is ${Math.round(s.percent)}% full`;
	if (s.compactions > 0) return `the session was compacted ${s.compactions} time(s), so details are already lost`;
	return undefined;
}

/**
 * Keeps plan files out of git in this repository only, through .git/info/exclude, so they are never
 * committed and the review gate does not review a plan as a change.
 */
export function ignorePlans(cwd: string) {
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	try {
		git("rev-parse", "--git-dir");
	} catch {
		return; // not a repository
	}
	try {
		git("check-ignore", "-q", `${PLANS_DIR}plan.md`);
		return; // already ignored
	} catch {}
	// Exclude patterns are relative to the repository root, and pi may start below it.
	const line = `/${git("rev-parse", "--show-prefix")}${PLANS_DIR}`.replace(/[*?[\\]/g, "\\$&");
	const exclude = resolve(cwd, git("rev-parse", "--git-path", "info/exclude"));
	mkdirSync(dirname(exclude), { recursive: true });
	appendFileSync(exclude, `\n${line}\n`);
}

/** A plan file's ticked and open checkbox steps, or undefined when the file is gone. */
export function steps(cwd: string, path: string): { done: number; open: number } | undefined {
	let text: string;
	try {
		text = readFileSync(resolve(cwd, path), "utf8");
	} catch {
		return undefined;
	}
	return { done: text.match(/^\s*[-*] \[[xX]\]/gm)?.length ?? 0, open: text.match(/^\s*[-*] \[ \]/gm)?.length ?? 0 };
}

/** The latest plan this session works from, for the review gate. */
export function activePlan(branch: Entry[]): string | undefined {
	return branch.findLast((e) => e.type === "custom" && e.customType === PLAN_ENTRY)?.data?.path;
}

const accepted = (branch: Entry[], path: string) => branch.some((e) => e.type === "custom" && e.customType === PLAN_ENTRY && e.data?.path === path);

/** A plan reviewed by plan-reviewer in this session, or one this session already builds from (accepted earlier, or opened by /handoff). */
export function reviewed(branch: Entry[], path: string): boolean {
	return branch.some(
		(e) =>
			(e.type === "custom" && e.customType === PLAN_ENTRY && e.data?.path === path) ||
			(e.type === "message" &&
				e.message?.role === "toolResult" &&
				e.message.toolName === "subagent" &&
				(e.message.details?.results ?? []).some(
					(r: any) => r.agent === "plan-reviewer" && r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted",
				)),
	);
}

const KICKOFF_START = "Implement the plan in ";
// Workers in one parallel call share the working tree and the plan file, so each edits only its step's files and the caller ticks.
const PARALLEL =
	"Steps tagged with the same (parallel A) letter run as one subagent call: a `tasks` array with one worker per step, each told its step and files, to edit only those files, and not to edit the plan file. When it returns, run each step's check and tick the steps that pass yourself.";
export const kickoff = (path: string) =>
	[
		`${KICKOFF_START}${path}. This session starts empty, so read the plan first; it is your whole context, except that its \`## Sources\`, when it has them, are the originals to read when a requirement needs more than its quote.`,
		"Build it yourself, step by step in order. Tick a step ([x]) in the plan file once its check passes.",
		PARALLEL,
		`Call handoff with ${path} between steps, so the rest moves to a fresh session if this one fills up.`,
		"Run every command under the plan's success criteria and show its output. Do not finish while one fails.",
	].join("\n");

// Sent beside each user message: as the tool's guidelines the model read them as applying only once a plan
// existed, and as a system prompt section it overlooked them; next to the request it weighs them.
export const PLAN_FIRST = [
	"Before you edit code for this message, decide whether it needs a plan.",
	"- A quick fix is one change you can state in one sentence with no design choice: a typo, a one-line bug, a rename, a small isolated addition. Build it directly.",
	"- Any other code change gets a plan before you edit code, even when it fits in one or two files: several requirements, a data or file format change, a migration, or a choice between designs. Read the code (the scout subagent for wide searches; scouts on separate areas run at once in one parallel subagent call), look up outside APIs or docs with web search if you have it, run the planner then plan-reviewer agents on what you found (the subagent tool; find it with tool_search if it is not listed), and write the reviewed plan to docs/plans/<short-name>.md: each checkbox step line ends with ``- files: a.ts, b.ts (new) - check: `<command>` ``, and `## Success criteria` has one `` - `<command>` `` line per command.",
	"- When the request rests on documents (a PRD, an API or server spec, Notion or Figma pages), read them yourself and give the plan `## Sources` (one `- <path or URL>` line each) and `## Requirements` before `## Plan`: one `- R1. \"<quote>\" — src: <where> - step: N` line per requirement, quoted, not summarised, ending ` - out: <reason, who agreed>` instead when it is left out. Each error code, allowed format, response field, expiry or retry rule, and Figma icon or button placement is its own line. A Figma value that looks like a component default (its layer still named with the component's placeholder text) is `out: unconfirmed`: ask the user and replace it with a step or `out: <their answer>`, since handoff refuses an unconfirmed requirement. Give the planner each source's path, or for one it cannot open (a URL) its text as you read it, never your summary. If a source cannot be read, tell the user before planning instead of leaving that part for later.",
	"- If the plan touches three or more files, or changes a stored data format or a public interface, show the user a short summary and wait for their go-ahead. Otherwise go straight on.",
	"- Then call the handoff tool with the plan file; it decides whether the build moves to a new session, and you follow what it returns.",
	"- While building from a plan, tick each step ([x]) in the plan file once its check passes, call handoff between steps, and do not finish until every success criteria command passes; show their output.",
].join("\n");

export default function (pi: ExtensionAPI) {
	let pending: string | undefined; // the plan to open in a new session once this run settles

	pi.on("before_agent_start", (event, ctx) => {
		if (!gated(ctx.mode) || event.messageType !== "user") return;
		if (event.prompt.startsWith(KICKOFF_START)) {
			// A kickoff typed or passed in (pi -p under the eval) records its plan, as /handoff does, for the review gate.
			const path = event.prompt.match(/^Implement the plan in (\S+?)\.(?:\s|$)/)?.[1];
			if (path && !accepted(ctx.sessionManager.getBranch() as Entry[], path)) pi.appendEntry(PLAN_ENTRY, { path });
			return;
		}
		// Under the eval no one answers, so a run that waited for a go-ahead would end with nothing built.
		const content = process.env.PI_EVAL === "1" ? PLAN_FIRST.replace(/show the user a short summary and wait for their go-ahead/, "no one is there to approve it, so write the summary in your final reply and go straight on") : PLAN_FIRST;
		return { message: { customType: "plan-first", content, display: false } };
	});

	pi.on("session_start", (_event, ctx) => {
		if (!gated(ctx.mode)) return;
		ignorePlans(ctx.cwd);
		pi.registerTool({
			name: "handoff",
			label: "Handoff",
			description:
				"Call with a plan file before building it, and between its steps. Moves the build to a new session when this one is full or compacted, or when you pass newSession; otherwise says to continue here.",
			promptSnippet: "Decide whether a plan's build runs in this session or a new one",
			// Models often write or tick the plan and call handoff in one batch; run in order, so it reads the file as written.
			executionMode: "sequential",
			parameters: Type.Object({
				plan: Type.String({ description: "Plan file path, e.g. docs/plans/theme-option.md" }),
				newSession: Type.Optional(
					Type.Boolean({ description: "true when this session is messy: many failed attempts, abandoned approaches, or course corrections from the user" }),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
				const path = params.plan.replace(/^@/, "");
				if (!existsSync(resolve(ctx.cwd, path))) throw new Error(`no plan file at ${path}; write the plan there first`);
				const branch = ctx.sessionManager.getBranch() as Entry[];
				if (!reviewed(branch, path)) throw new Error(`${path} was not reviewed: run the plan-reviewer subagent on it, write the reviewed plan to ${path}, then call handoff again`);
				// A plan this session already accepted, or one /handoff opened, is exempt.
				if (!accepted(branch, path)) {
					const problems = lintPlan(ctx.cwd, readFileSync(resolve(ctx.cwd, path), "utf8"));
					if (problems.length) throw new Error(`${path} is not in the plan format:\n- ${problems.join("\n- ")}\nFix the plan file and call handoff again`);
				}
				pi.appendEntry(PLAN_ENTRY, { path });

				const s = signals(ctx.sessionManager.getBranch() as Entry[], ctx.getContextUsage()?.percent);
				// ponytail: under the eval the build never moves, so the one-shot measured run stays in one session rather than relying on a queued post-settle /handoff.
				const reason = process.env.PI_EVAL === "1" ? undefined : (forcedReason(s) ?? (params.newSession ? "you judged this session messy" : undefined));
				if (reason) {
					pending = path;
					const text = `A new session opens after this turn and builds ${path} (${reason}). Stop here.`;
					return { content: [{ type: "text", text }], details: s, terminate: true };
				}
				const left = steps(ctx.cwd, path)?.open ?? 0;
				const text = [
					`Continue in this session (context ${s.percent == null ? "unknown" : `${Math.round(s.percent)}%`}, ${s.toolErrors} failed tool calls, ${s.blocks} review BLOCKs; ${left} plan step(s) left).`,
					// A worker's pi has no handoff tool, so it stops when compacted, and its next step goes to a fresh worker from here.
					`In the session you planned in, hand the build to the worker subagent: "${kickoff(path).split("\n")[0]} Build the steps not yet ticked, in order, and tick each one ([x]) once its check passes. Stop before a step tagged (parallel ...) and report the steps left. If your context gets compacted, finish and tick the step you are on, then stop and report the steps left. Once all are ticked, run every success criteria command and report its output." When the next step not yet ticked is in a parallel group, or the worker stopped at one, run that group here. ${PARALLEL} When the worker returns with steps left, call handoff again before running a fresh worker on them. In a session handoff opened, keep building yourself.`,
					"If this session is messy (many failed attempts, abandoned approaches, the user correcting course), call handoff again with newSession: true instead.",
				].join("\n");
				return { content: [{ type: "text", text }], details: s };
			},
			// The rest is instructions for the model; the user sees the verdict line, ctrl+o shows all, errors show whole.
			renderResult(result, { expanded }, theme, ctx) {
				const block = result.content[0];
				const text = block?.type === "text" ? block.text : "";
				return new Text(theme.fg("toolOutput", expanded || ctx.isError ? text : text.split("\n")[0]!), 0, 0);
			},
		});
	});

	// Tools cannot replace the session, and pi cannot while the agent runs; the command does it once idle.
	pi.on("agent_settled", (event) => {
		const path = pending;
		pending = undefined;
		if (path && !event.aborted) pi.sendUserMessage(`/handoff ${path}`, { expandPromptTemplates: true });
	});

	pi.registerCommand("handoff", {
		description: "Build a plan file in a new session: /handoff <plan>",
		async handler(args, ctx) {
			const path = args.trim().replace(/^@/, "");
			if (!path || !existsSync(resolve(ctx.cwd, path))) return ctx.ui.notify(`usage: /handoff <plan file> (no file at ${path || "?"})`, "warning");
			// The router classifies a session from its first message, so the plan rides along; the file stays the one to tick.
			const message = `${kickoff(path)}\n\nThe plan as of this handoff (tick steps in the file, not here):\n\n${readFileSync(resolve(ctx.cwd, path), "utf8")}`;
			await ctx.newSession({
				parentSession: ctx.sessionManager.getSessionFile(),
				setup: async (sm) => {
					sm.appendCustomEntry(PLAN_ENTRY, { path });
				},
				withSession: async (next) => {
					await next.sendUserMessage(message);
				},
			});
		},
	});
}
