/**
 * Thinking effort configuration for mapping pi's ThinkingLevel to Claude CLI --effort flags.
 *
 * Every model gets the CLI level of the same name (minimal becomes low), so `claude-opus:high`
 * runs at high. The CLI's max is never sent. claude 2.1.322 accepted xhigh and max from
 * Opus 5.5, Fable 5.1, and Haiku 4.5 alike.
 *
 * IMPORTANT: The CLI does NOT support --thinking-budget. Only --effort is supported.
 */

import type { ThinkingLevel, ThinkingBudgets } from "@mariozechner/pi-ai";

/** CLI effort levels this provider sends via the --effort flag */
export type CliEffortLevel = "low" | "medium" | "high" | "xhigh";

const EFFORT_MAP: Record<ThinkingLevel, CliEffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

/**
 * Map pi's ThinkingLevel to a CLI effort string.
 *
 * When reasoning is undefined, returns undefined so the --effort flag is omitted
 * entirely, letting the CLI use its default behavior. When thinkingBudgets are
 * provided, a console.warn is logged because the CLI only supports effort levels,
 * not token budgets.
 *
 * @param reasoning - Pi's thinking level (undefined = omit flag)
 * @param thinkingBudgets - Custom budgets (logged as unsupported, not applied)
 * @returns CLI effort level string, or undefined if flag should be omitted
 */
export function mapThinkingEffort(
  reasoning?: ThinkingLevel,
  thinkingBudgets?: ThinkingBudgets,
): CliEffortLevel | undefined {
  if (reasoning === undefined) {
    return undefined; // omit --effort flag entirely
  }

  if (thinkingBudgets && Object.keys(thinkingBudgets).length > 0) {
    console.warn(
      "[pi-claude-cli] Custom thinkingBudgets are not supported with CLI subprocess. " +
        "The CLI uses --effort levels instead of token budgets. Budgets will be ignored.",
    );
  }

  return EFFORT_MAP[reasoning];
}
