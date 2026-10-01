/**
 * A two-line footer in place of pi's built-in one:
 *
 *   ~/projects/app (main) • session name                              laya starting
 *   ↑12k ↓3.4k CH89% ━━──────── 14%/200k          complex → claude-opus-5-5 • medium
 *
 * Extension statuses go on the right of the first line, except router.ts's "router" status (the
 * session's tier), which leads the model it routed to. Under a virtual model the thinking level is
 * the one the latest response used, shown once.
 */

import { homedir } from "node:os";
import { sep } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ContextUsage, ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "./subagent/index.ts";

// ponytail: assumes the claude CLI is logged in with a subscription, so the API-price cost pi computes
// for it is not money spent. Drop this if it ever runs on an API key.
const SUBSCRIPTION_PROVIDER = "pi-claude-cli";
const BAR_CELLS = 10;

interface Stats {
	input: number;
	output: number;
	cost: number;
	latest?: AssistantMessage; // latest successful response on this branch
	context?: ContextUsage;
}

function sessionStats(ctx: ExtensionContext): Stats {
	const stats: Stats = { input: 0, output: 0, cost: 0, context: ctx.getContextUsage() };
	// Totals cover every branch of the session, as pi's footer does.
	for (const entry of ctx.sessionManager.getEntries()) {
		let usage: Usage | undefined;
		let provider: string | undefined;
		if (entry.type === "usage") ({ usage, provider } = entry);
		else if (entry.type === "message" && entry.message.role === "assistant") ({ usage, provider } = entry.message);
		else if (entry.type === "message" && entry.message.role === "toolResult") usage = entry.message.usage;
		else if (entry.type === "branch_summary" || entry.type === "compaction") usage = entry.usage;
		if (!usage) continue;
		stats.input += usage.input;
		stats.output += usage.output;
		if (provider !== SUBSCRIPTION_PROVIDER) stats.cost += usage.cost.total;
	}
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0 && !stats.latest; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted") {
			stats.latest = entry.message;
		}
	}
	return stats;
}

// `left`, then `right` flush right with at least two spaces between; `right` is cut first.
function spread(left: string, right: string, width: number): string {
	const room = width - visibleWidth(left) - 2;
	if (!right || room <= 0) return truncateToWidth(left, width, "...");
	const cut = truncateToWidth(right, room, "");
	return left + " ".repeat(width - visibleWidth(left) - visibleWidth(cut)) + cut;
}

function contextBar(theme: Theme, context: ContextUsage | undefined): string {
	if (!context) return "";
	const percent = context.percent;
	const filled = percent === null ? 0 : Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS));
	const color = percent !== null && percent > 90 ? "error" : percent !== null && percent > 70 ? "warning" : "muted";
	const label = `${percent === null ? "?" : Math.round(percent)}%/${formatTokens(context.contextWindow)}`;
	return `${theme.fg(color, "━".repeat(filled))}${theme.fg("dim", "─".repeat(BAR_CELLS - filled))} ${theme.fg(color, label)}`;
}

function render(ctx: ExtensionContext, theme: Theme, footerData: ReadonlyFooterDataProvider, stats: Stats, width: number): string[] {
	const home = homedir();
	const cwd = ctx.sessionManager.getCwd();
	let where = cwd === home || cwd.startsWith(home + sep) ? `~${cwd.slice(home.length)}` : cwd;
	const branch = footerData.getGitBranch();
	if (branch) where += ` (${branch})`;
	const name = ctx.sessionManager.getSessionName();
	if (name) where += ` • ${name}`;

	const statuses = footerData.getExtensionStatuses();
	const others = [...statuses]
		.filter(([key]) => key !== "router")
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => text.replace(/\s+/g, " ").trim())
		.join(" · ");

	const { latest } = stats;
	const usage: string[] = [];
	if (stats.input) usage.push(`↑${formatTokens(stats.input)}`);
	if (stats.output) usage.push(`↓${formatTokens(stats.output)}`);
	const prompt = latest ? latest.usage.input + latest.usage.cacheRead + latest.usage.cacheWrite : 0;
	if (latest?.usage.cacheRead && prompt) usage.push(`CH${Math.round((latest.usage.cacheRead / prompt) * 100)}%`);
	if (stats.cost) usage.push(`$${stats.cost.toFixed(3)}`);
	const bar = contextBar(theme, stats.context);
	const left = usage.length ? `${theme.fg("dim", usage.join(" "))}${bar && ` ${bar}`}` : bar;

	// The tier is colored on its own: a reset inside an outer dim would undim the rest.
	const model = ctx.model;
	const virtual = model?.api === "pi-virtual";
	const tier = virtual ? statuses.get("router") : undefined;
	const head = tier ?? model?.id ?? "no-model";
	let tail = virtual && latest ? ` → ${latest.model}` : "";
	const level = (virtual && latest?.thinkingLevel) || ctx.thinkingLevel;
	if (model?.reasoning && level) tail += ` • ${level === "off" ? "thinking off" : level}`;
	const right = theme.fg(tier ? "accent" : "dim", head) + theme.fg("dim", tail);

	return [spread(theme.fg("dim", where), others && theme.fg("muted", others), width), spread(left, right, width)];
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// pi removes this footer before the session (and so this ctx) is replaced, and the next session_start sets it again.
		ctx.ui.setFooter((_tui, theme, footerData) => {
			// Entries are append-only and every append moves the leaf, so the stats change only with it.
			let cache: { leaf: string | null; stats: Stats } | undefined;
			return {
				render(width: number) {
					const leaf = ctx.sessionManager.getLeafId();
					if (!cache || cache.leaf !== leaf) cache = { leaf, stats: sessionStats(ctx) };
					return render(ctx, theme, footerData, cache.stats, width);
				},
				invalidate() {},
			};
		});
	});
}
