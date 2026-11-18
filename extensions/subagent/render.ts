import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentScope } from "./agents.ts";
import type { SubagentParams } from "./index.ts";
import { getFinalOutput, isFailedResult, type SingleResult, type SubagentDetails } from "./run.ts";

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

export const renderCall: NonNullable<ToolDefinition<typeof SubagentParams, SubagentDetails>["renderCall"]> = (args, theme, context) => {
	// Collapsed, the user sees which agents run; the task text is for the agent, ctrl+o shows it.
	const scope: AgentScope = args.agentScope ?? "user";
	if (args.chain && args.chain.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `chain (${args.chain.length} steps)`) +
			theme.fg("muted", ` [${scope}]`);
		for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
			const step = args.chain[i];
			// Clean up {previous} placeholder for display
			const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
			const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
			text +=
				"\n  " +
				theme.fg("muted", `${i + 1}.`) +
				" " +
				theme.fg("accent", step.agent) +
				(context.expanded ? theme.fg("dim", ` ${preview}`) : "");
		}
		if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	if (args.tasks && args.tasks.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
			theme.fg("muted", ` [${scope}]`);
		for (const t of args.tasks.slice(0, 3)) {
			const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
			text += `\n  ${theme.fg("accent", t.agent)}${context.expanded ? theme.fg("dim", ` ${preview}`) : ""}`;
		}
		if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	const agentName = args.agent || "...";
	const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", agentName) +
		theme.fg("muted", ` [${scope}]`);
	if (context.expanded) text += `\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
};

export const renderResult: NonNullable<ToolDefinition<typeof SubagentParams, SubagentDetails>["renderResult"]> = (
	result,
	{ expanded, isPartial },
	theme,
	context,
) => {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();
	const statusIcon = (r: SingleResult) =>
		r.exitCode === -1 ? theme.fg("warning", "⏳") : isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
	// A row has no embedded line breaks or tabs and is cut to the width instead of wrapped.
	const row = (line: string): Component => ({
		render: (width: number) => [truncateToWidth(line.replace(/[\r\n\t]+/g, " "), width, "…")],
		invalidate() {},
	});
	// Collapsed, an agent is one row: the tool call it is on while it runs, its answer's first line once done; a failure adds its error, whole.
	const addAgent = (box: Container, r: SingleResult) => {
		const head = `${statusIcon(r)} ${theme.fg("accent", r.agent)}`;
		if (r.exitCode === -1) {
			const last = getDisplayItems(r.messages).findLast((i) => i.type === "toolCall");
			const description = last?.type === "toolCall" && last.name === "bash" ? last.args.description : undefined;
			const now =
				typeof description === "string" && description.trim()
					? theme.fg("toolOutput", description)
					: last?.type === "toolCall"
						? formatToolCall(last.name, last.args, theme.fg.bind(theme))
						: theme.fg("muted", "starting");
			box.addChild(row(`${head}  ${theme.fg("muted", "now: ")}${now}`));
		} else if (isFailedResult(r)) {
			box.addChild(row(`${head}${r.stopReason ? ` ${theme.fg("error", `[${r.stopReason}]`)}` : ""}`));
			if (r.errorMessage) box.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
		} else {
			const first = getFinalOutput(r.messages).split("\n").find((l) => l.trim())?.trim() ?? "(no output)";
			box.addChild(row(`${head} ${theme.fg("muted", "→")} ${theme.fg("toolOutput", first)}`));
		}
	};
	const hint = () => row(theme.fg("muted", "(Ctrl+O to expand)"));

	const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
		const toShow = limit ? items.slice(-limit) : items;
		const skipped = limit && items.length > limit ? items.length - limit : 0;
		let text = "";
		if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
		for (const item of toShow) {
			if (item.type === "text") {
				const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
				text += `${theme.fg("toolOutput", preview)}\n`;
			} else {
				text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
			}
		}
		return text.trimEnd();
	};

	if (details.mode === "single" && details.results.length === 1) {
		const r = details.results[0];
		const isError = r.exitCode !== -1 && isFailedResult(r);
		const icon = statusIcon(r);
		const displayItems = getDisplayItems(r.messages);
		const finalOutput = getFinalOutput(r.messages);

		if (expanded) {
			const container = new Container();
			let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
			if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
			container.addChild(new Text(header, 0, 0));
			if (isError && r.errorMessage)
				container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
			if (displayItems.length === 0 && !finalOutput) {
				container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
			} else {
				for (const item of displayItems) {
					if (item.type === "toolCall")
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0,
								0,
							),
						);
				}
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}
			}
			const usageStr = formatUsageStats(r.usage, r.model);
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}
			return container;
		}

		const box = new Container();
		addAgent(box, r);
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) box.addChild(row(theme.fg("dim", usageStr)));
		box.addChild(hint());
		return box;
	}

	const aggregateUsage = (results: SingleResult[]) => {
		const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
		for (const r of results) {
			total.input += r.usage.input;
			total.output += r.usage.output;
			total.cacheRead += r.usage.cacheRead;
			total.cacheWrite += r.usage.cacheWrite;
			total.cost += r.usage.cost;
			total.turns += r.usage.turns;
		}
		return total;
	};

	if (details.mode === "chain") {
		const steps = context.args.chain!;
		const total = steps.length;
		const successCount = details.results.filter((r) => !isFailedResult(r)).length;
		const icon = isPartial
			? theme.fg("warning", "⏳")
			: successCount === total
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
		const header = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${total} steps`)}`;

		if (expanded) {
			const container = new Container();
			container.addChild(new Text(header, 0, 0));

			for (const r of details.results) {
				const rIcon = statusIcon(r);
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
						0,
						0,
					),
				);
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

				// Show tool calls
				for (const item of displayItems) {
					if (item.type === "toolCall") {
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0,
								0,
							),
						);
					}
				}

				// Show final output as markdown
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}

				const stepUsage = formatUsageStats(r.usage, r.model);
				if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
			}

			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
			}
			return container;
		}

		// Collapsed view
		const box = new Container();
		box.addChild(row(header));
		for (const r of details.results) addAgent(box, r);
		if (isPartial) {
			for (const step of steps.slice(details.results.length)) {
				box.addChild(row(`${theme.fg("muted", "·")} ${theme.fg("accent", step.agent)} ${theme.fg("muted", "waiting")}`));
			}
		}
		const usageStr = formatUsageStats(aggregateUsage(details.results));
		if (usageStr) box.addChild(row(theme.fg("dim", `Total: ${usageStr}`)));
		box.addChild(hint());
		return box;
	}

	if (details.mode === "parallel") {
		const running = details.results.filter((r) => r.exitCode === -1).length;
		const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
		const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
		const isRunning = running > 0;
		const icon = isRunning
			? theme.fg("warning", "⏳")
			: failCount > 0
				? theme.fg("warning", "◐")
				: theme.fg("success", "✓");
		const status = isRunning
			? `${successCount + failCount}/${details.results.length} done, ${running} running`
			: `${successCount}/${details.results.length} tasks`;

		if (expanded && !isRunning) {
			const container = new Container();
			container.addChild(
				new Text(
					`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
					0,
					0,
				),
			);

			for (const r of details.results) {
				const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				container.addChild(new Spacer(1));
				container.addChild(
					new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
				);
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

				// Show tool calls
				for (const item of displayItems) {
					if (item.type === "toolCall") {
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0,
								0,
							),
						);
					}
				}

				// Show final output as markdown
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}

				const taskUsage = formatUsageStats(r.usage, r.model);
				if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
			}

			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
			}
			return container;
		}

		if (expanded) {
			// Expanded and still running: the log preview
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
			for (const r of details.results) {
				const rIcon =
					r.exitCode === -1
						? theme.fg("warning", "⏳")
						: isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
				if (displayItems.length === 0)
					text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
				else text += `\n${renderDisplayItems(displayItems, 5)}`;
			}
			return new Text(text, 0, 0);
		}

		const box = new Container();
		box.addChild(row(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`));
		for (const r of details.results) addAgent(box, r);
		if (!isRunning) {
			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) box.addChild(row(theme.fg("dim", `Total: ${usageStr}`)));
		}
		box.addChild(hint());
		return box;
	}

	const text = result.content[0];
	return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
};
