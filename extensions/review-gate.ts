/**
 * A stop-time review gate, as the codex plugin adds to Claude Code: when the run for a prompt changed
 * the repository, the `reviewer` agent (another model family) reviews those changes before pi settles,
 * and a blocking finding goes back to the model for another pass. The model gets at most
 * MAX_REVIEWS reviews per prompt, and only interactive sessions are gated, so a subagent's own pi
 * never reviews itself. `/review-gate on|off` switches it for every pi (saved in <agent dir>/review-gate.json).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./subagent/agents.ts";
import { getResultOutput, isFailedResult, runSingleAgent } from "./subagent/index.ts";

const MAX_REVIEWS = 3;
// ponytail: Esc cannot stop a review, since pi hands this boundary no abort signal; the timeout bounds the wait.
const REVIEW_TIMEOUT_MS = 10 * 60_000;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

// Changes when a commit, an edit to a tracked file, or a new or deleted file does.
// ponytail: an edit to an already-untracked file goes unnoticed; hash untracked contents if that matters.
function snapshot(cwd: string): string | undefined {
	try {
		return git(cwd, "rev-parse", "HEAD") + git(cwd, "status", "--porcelain", "-uall") + git(cwd, "diff", "HEAD");
	} catch {
		return undefined; // not a repository, or no commit yet
	}
}

export default function (pi: ExtensionAPI) {
	const switchPath = join(getAgentDir(), "review-gate.json");
	const off = () => {
		try {
			return JSON.parse(readFileSync(switchPath, "utf8")).enabled === false;
		} catch {
			return false;
		}
	};

	// The switch applies to every pi, so a gate left off stays in sight; on is the normal case and shows nothing.
	const showSwitch = (ctx: ExtensionContext) => ctx.ui.setStatus("review", off() ? ctx.ui.theme.fg("warning", "review off") : undefined);
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") showSwitch(ctx);
	});

	let base: string | undefined; // HEAD when the prompt started
	let seen: string | undefined; // the repository at the prompt's start, then at the latest review
	let reviews = 0;

	pi.on("before_agent_start", (_event, ctx) => {
		seen = snapshot(ctx.cwd);
		base = seen?.split("\n", 1)[0];
		reviews = 0;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (ctx.mode !== "tui" || event.outcome !== "completed" || !base || reviews >= MAX_REVIEWS || off()) return;
		const now = snapshot(ctx.cwd);
		if (!now || now === seen) return;
		seen = now;
		reviews++;

		const last = event.context.llmMessages.findLast((m) => m.role === "assistant");
		const summary = last?.role === "assistant" ? last.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n") : "";
		const task = [
			"Review the code changes made for the user's latest request, before they ship.",
			`\`git diff ${base}\` shows every change since that request started, committed or not, plus any uncommitted changes from before it; \`git status\` lists new files.`,
			"Your first line must be exactly `ALLOW: <short reason>` or `BLOCK: <short reason>`. BLOCK only for a Critical issue in these changes. Then give your usual review.",
			`Judge from the diff first. The assistant's final message, describing what it did, is for comparing at the end only:\n\n${summary}`,
		].join("\n\n");

		ctx.ui.setStatus("review", "reviewing…");
		let output = "";
		let failure = "";
		try {
			const agents = discoverAgents(ctx.cwd, "user").agents;
			const result = await runSingleAgent(ctx.cwd, {}, agents, "reviewer", task, undefined, undefined, AbortSignal.timeout(REVIEW_TIMEOUT_MS), undefined, (results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }));
			if (isFailedResult(result)) failure = `exit ${result.exitCode}, ${result.stopReason ?? "no stop reason"}: ${getResultOutput(result).trim()}`;
			else output = getResultOutput(result).trim();
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err); // the timeout lands here
		} finally {
			ctx.ui.setStatus("review", undefined);
		}

		const verdict = output.split("\n", 1)[0];
		if (verdict.startsWith("BLOCK:")) {
			const content = `The reviewer found an issue to fix before finishing. Fix it, or explain why it is not one.\n\n${output}`;
			return { entries: [...event.entries, { type: "custom_message", customType: "review-gate", content, display: true }], continue: true };
		}
		// A failed review never blocks: looping the model on a reviewer outage helps no one.
		if (verdict.startsWith("ALLOW:")) ctx.ui.notify(`review: ${verdict.slice(6).trim()}`, "info");
		else ctx.ui.notify(`review gate: the reviewer gave no verdict, so this turn went unreviewed (first line: ${verdict ? JSON.stringify(verdict.slice(0, 200)) : `none, the review failed: ${(failure || "no error given").slice(0, 300)}`})`, "warning");
	});

	pi.registerCommand("review-gate", {
		description: "Show the stop-time review gate, or switch it for every pi: /review-gate [on|off]",
		getArgumentCompletions: (prefix) => ["on", "off"].filter((arg) => arg.startsWith(prefix)).map((arg) => ({ value: arg, label: arg })),
		async handler(args, ctx) {
			const arg = args.trim();
			if (arg !== "" && arg !== "on" && arg !== "off") return ctx.ui.notify("usage: /review-gate [on|off]", "warning");
			if (arg) {
				mkdirSync(dirname(switchPath), { recursive: true });
				writeFileSync(switchPath, `${JSON.stringify({ enabled: arg === "on" })}\n`);
			}
			showSwitch(ctx);
			ctx.ui.notify(off() ? "review gate off" : "review gate on: the reviewer agent checks each prompt's changes before pi stops", "info");
		},
	});
}
