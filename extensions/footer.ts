/**
 * A two-line footer in place of pi's built-in one:
 *
 *   ~/projects/app (main*) • session name                claude 5h 3% · 7d 64% · laya starting
 *   CH89% $1.234 ━━──────── 14%/200k (auto)         complex 82% → claude-opus-5-5 • medium
 *
 * Extension statuses go on the right of the first line, except router.ts's "router" status (the
 * session's tier), which leads the model it routed to. Under a virtual model the thinking level is
 * the one the latest response used, shown once. `*` marks uncommitted changes. The cost is what the
 * session, its subagents included, would cost at API prices, subscriptions or not.
 *
 * The "gpt" status, the ChatGPT subscription's usage, is set here; pi-claude-cli sets "claude".
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ContextUsage, ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "./subagent/index.ts";

const BAR_CELLS = 10;
// ponytail: `git status` at most this often, while the footer renders; a file watcher if this lags.
const GIT_STATUS_MS = 5_000;
// A usage window this full shows when it resets, in the warning color.
const LIMIT_WARNING = 0.8;

export interface LimitWindow {
	label: string; // "5h", "7d"
	used: number; // 0-1
	resetsAt: number; // unix seconds
}

/** A subscription's usage as a footer status: "claude 5h 3% · 7d 64%". */
export function formatLimits(name: string, windows: LimitWindow[], theme?: Theme): string | undefined {
	if (!windows.length) return undefined;
	const parts = windows.map(({ label, used, resetsAt }) => {
		const part = `${label} ${Math.round(used * 100)}%`;
		if (used < LIMIT_WARNING) return part;
		const weekday = label.endsWith("d") ? "short" : undefined;
		return `${part} ↻${new Date(resetsAt * 1000).toLocaleString([], { weekday, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
	});
	const text = `${name} ${parts.join(" · ")}`;
	return theme && windows.some((w) => w.used >= LIMIT_WARNING) ? theme.fg("warning", text) : text;
}

interface CodexWindow {
	used_percent: number;
	limit_window_seconds: number;
	reset_at: number;
}

// pi's own `openai` login is rejected here (its token carries no ChatGPT account), so this reads Codex
// CLI's login, as orca does. Codex CLI refreshes that token; a missing or expired one hides the status.
async function gptLimits(theme: Theme): Promise<string | undefined> {
	try {
		const { tokens } = JSON.parse(await readFile(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), "utf8"));
		const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return undefined;
		const { rate_limit } = (await response.json()) as { rate_limit?: Record<string, CodexWindow | null> };
		const windows = [rate_limit?.primary_window, rate_limit?.secondary_window].flatMap((w) => {
			if (!w) return [];
			const hours = w.limit_window_seconds / 3600;
			return [{ label: hours >= 24 ? `${Math.round(hours / 24)}d` : `${Math.round(hours)}h`, used: w.used_percent / 100, resetsAt: w.reset_at }];
		});
		return formatLimits("gpt", windows, theme);
	} catch {
		return undefined;
	}
}

function showGptLimits(ctx: ExtensionContext) {
	// A session replaced while this was fetching leaves `ctx` stale, and its setStatus throws.
	gptLimits(ctx.ui.theme).then((text) => ctx.ui.setStatus("gpt", text)).catch(() => {});
}

interface Stats {
	cost: number;
	latest?: AssistantMessage; // latest successful response on this branch
	context?: ContextUsage;
	autoCompact: boolean;
}

function sessionStats(pi: ExtensionAPI, ctx: ExtensionContext): Stats {
	const stats: Stats = { cost: 0, context: ctx.getContextUsage(), autoCompact: pi.getSettings().compaction?.enabled !== false };
	// Totals cover every branch of the session, as pi's footer does.
	for (const entry of ctx.sessionManager.getEntries()) {
		let usage: Usage | undefined;
		if (entry.type === "usage" || entry.type === "branch_summary" || entry.type === "compaction") usage = entry.usage;
		else if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) usage = entry.message.usage;
		if (usage) stats.cost += usage.cost.total;
		// Subagents run in their own pi; subagent/index.ts reports their usage in the tool result.
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent") {
			for (const result of (entry.message.details as { results?: { usage: { cost: number } }[] } | undefined)?.results ?? []) {
				stats.cost += result.usage.cost;
			}
		}
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

function contextBar(theme: Theme, context: ContextUsage | undefined, autoCompact: boolean): string {
	if (!context) return "";
	const percent = context.percent;
	const filled = percent === null ? 0 : Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS));
	const color = percent !== null && percent > 90 ? "error" : percent !== null && percent > 70 ? "warning" : "muted";
	const label = `${percent === null ? "?" : Math.round(percent)}%/${formatTokens(context.contextWindow)}${autoCompact ? " (auto)" : ""}`;
	return `${theme.fg(color, "━".repeat(filled))}${theme.fg("dim", "─".repeat(BAR_CELLS - filled))} ${theme.fg(color, label)}`;
}

function render(ctx: ExtensionContext, theme: Theme, footerData: ReadonlyFooterDataProvider, stats: Stats, dirty: boolean, width: number): string[] {
	const home = homedir();
	const cwd = ctx.sessionManager.getCwd();
	let where = cwd === home || cwd.startsWith(home + sep) ? `~${cwd.slice(home.length)}` : cwd;
	const branch = footerData.getGitBranch();
	if (branch) where += ` (${branch}${dirty ? "*" : ""})`;
	const name = ctx.sessionManager.getSessionName();
	if (name) where += ` • ${name}`;

	const statuses = footerData.getExtensionStatuses();
	// Each colored on its own, so a status can color itself.
	const others = [...statuses]
		.filter(([key]) => key !== "router")
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => theme.fg("muted", text.replace(/\s+/g, " ").trim()))
		.join(theme.fg("muted", " · "));

	const { latest } = stats;
	const usage: string[] = [];
	const prompt = latest ? latest.usage.input + latest.usage.cacheRead + latest.usage.cacheWrite : 0;
	if (latest?.usage.cacheRead && prompt) usage.push(`CH${Math.round((latest.usage.cacheRead / prompt) * 100)}%`);
	if (stats.cost) usage.push(`$${stats.cost.toFixed(3)}`);
	const bar = contextBar(theme, stats.context, stats.autoCompact);
	const left = usage.length ? `${theme.fg("dim", usage.join(" "))}${bar && ` ${bar}`}` : bar;

	// The tier is colored on its own: a reset inside an outer dim would undim the rest.
	const model = ctx.model;
	const virtual = model?.api === "pi-virtual";
	const tier = virtual ? statuses.get("router") : undefined;
	const head = tier ?? model?.id ?? "no-model";
	let tail = virtual && latest ? ` → ${latest.model}` : "";
	const level = (virtual && latest?.thinkingLevel) || ctx.thinkingLevel;
	if (model?.reasoning && level) tail += ` • ${level === "off" ? "thinking off" : level}`;
	// router.ts marks a tier taken by default with `?`.
	const right = theme.fg(!tier ? "dim" : tier.includes("?") ? "warning" : "accent", head) + theme.fg("dim", tail);

	return [spread(theme.fg("dim", where), others, width), spread(left, right, width)];
}

export default function (pi: ExtensionAPI) {
	// Each prompt's end also covers the subagents it ran, which use the same subscription.
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode === "tui") showGptLimits(ctx);
	});
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		showGptLimits(ctx);
		// pi removes this footer before the session (and so this ctx) is replaced, and the next session_start sets it again.
		ctx.ui.setFooter((tui, theme, footerData) => {
			// Entries are append-only and every append moves the leaf, so the stats change only with it.
			let cache: { leaf: string | null; stats: Stats } | undefined;
			let dirty = false;
			let gitCheckedAt = 0;
			function checkGit() {
				if (!footerData.getGitBranch() || Date.now() - gitCheckedAt < GIT_STATUS_MS) return;
				gitCheckedAt = Date.now();
				execFile("git", ["status", "--porcelain"], { cwd: ctx.sessionManager.getCwd() }, (error, stdout) => {
					const now = !error && stdout.length > 0;
					if (now === dirty) return;
					dirty = now;
					tui.requestRender();
				});
			}
			return {
				render(width: number) {
					const leaf = ctx.sessionManager.getLeafId();
					if (!cache || cache.leaf !== leaf) cache = { leaf, stats: sessionStats(pi, ctx) };
					checkGit();
					return render(ctx, theme, footerData, cache.stats, dirty, width);
				},
				invalidate() {},
			};
		});
	});
}
