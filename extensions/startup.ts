/**
 * The first screen: until the first prompt, a line above the editor names this package's workflow
 * commands; and at startup, a warning names each tool or login the package needs that this machine
 * lacks, with how to fix it. A machine with everything set up sees no warning. laya-serve is not
 * checked here: router.ts already says when it cannot start.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claudeToken } from "./footer.ts";

const WORKFLOWS = "/scout-and-plan plan · /implement plan → build · /implement-and-review build → review · /deep logic-heavy goal";

const onPath = (bin: string) => (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, bin)));

/** What this machine is missing, each with its fix; empty when nothing is. */
export async function missing(ctx: Pick<ExtensionContext, "modelRegistry">): Promise<string[]> {
	const found: string[] = [];
	if (!onPath("claude")) found.push("claude CLI not found, so no Claude model can run: install Claude Code");
	else if (!(await claudeToken().then(Boolean, () => false))) found.push("claude CLI is not logged in, so no Claude model can run: claude auth login");
	if (!ctx.modelRegistry.getProviderAuthStatus("openai").configured) {
		found.push("openai has no credentials, so the review gate, reviewer, plan-reviewer and deep-worker fail: /login or OPENAI_API_KEY");
	}
	if (!onPath("pdftotext")) found.push("poppler not found, so read cannot open PDFs: brew install poppler");
	if (!onPath("pandoc")) found.push("pandoc not found, so read cannot open .docx: brew install pandoc");
	if (!onPath("soffice")) found.push("LibreOffice not found, so read sends .pptx slides without diagrams and shape colors: brew install --cask libreoffice");
	return found;
}

export default function (pi: ExtensionAPI) {
	let checked = false; // once per pi: /new and /resume would repeat the same warnings
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// A resumed session is already past its first prompt.
		if (!ctx.sessionManager.getEntries().some((entry) => entry.type === "message")) ctx.ui.setWidget("workflows", [ctx.ui.theme.fg("dim", WORKFLOWS)]);
		if (checked) return;
		checked = true;
		for (const problem of await missing(ctx)) ctx.ui.notify(`setup: ${problem}`, "warning");
	});
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setWidget("workflows", undefined);
	});
}
