/**
 * Pi extension entry point for pi-claude-cli.
 *
 * Registers a custom provider that routes LLM calls through the Claude Code CLI
 * subprocess using stream-json NDJSON protocol.
 *
 * Vendored from pi-claude-cli 0.3.1 (MIT, see LICENSE; github.com/rchern/pi-claude-cli),
 * patched for pi 0.99's context shape, to drop the cross-spawn dependency, to report
 * a CLI error instead of ending the turn with an empty reply, and to keep one CLI process
 * across pi's calls (pi's tools reach it over MCP) instead of resuming a CLI session that
 * lost the tool calls, so the CLI keeps its thinking and its prompt cache, and to give the
 * CLI only the tools pi declares to the model (not deferred, codemode or hidden ones).
 */

import { getCurrentSystemPrompt, getCurrentTools, getModels } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { streamViaCli } from "./src/provider.js";
import {
  validateCliPresence,
  validateCliAuth,
  killAllProcesses,
} from "./src/process-manager.js";
import { getToolDefs, writeMcpConfig } from "./src/mcp-config.js";
import type { ClaudeRateLimitEvent } from "./src/types.js";
import { formatLimits } from "../footer.js";

// Kill all active Claude subprocesses on process exit to prevent orphans
process.on("exit", killAllProcesses);

const PROVIDER_ID = "pi-claude-cli";

let ui: ExtensionContext["ui"] | undefined;

/** The footer status for the subscription's usage: "claude 5h 3% · 7d 64%". */
export function formatRateLimits(
  info: ClaudeRateLimitEvent["rate_limit_info"],
): string | undefined {
  const windows = info.unifiedWindows ?? {};
  const labels = [["five_hour", "5h"], ["seven_day", "7d"]];
  return formatLimits(
    "claude",
    labels.flatMap(([key, label]) => {
      const w = windows[key];
      return w ? [{ label, used: w.utilization, resetsAt: w.resetsAt }] : [];
    }),
    ui?.theme,
  );
}

/** MCP config paths by the tool definitions' JSON. */
const mcpConfigs = new Map<string, string | undefined>();

/**
 * The MCP config for the tools pi declares in this request. A changed set
 * (a tool_search load) gets a new path, which restarts the CLI with it.
 *
 * Uses warn-don't-block: failure logs a warning but does not
 * prevent the provider from answering (without pi's tools).
 */
function mcpConfigFor(tools: any[]): string | undefined {
  const toolDefs = getToolDefs(tools);
  const json = JSON.stringify(toolDefs);
  if (mcpConfigs.has(json)) return mcpConfigs.get(json);
  let path: string | undefined;
  try {
    if (toolDefs.length > 0) path = writeMcpConfig(toolDefs);
  } catch (err) {
    ui?.notify(`pi-claude-cli: MCP config generation failed, pi's tools unavailable: ${err}`, "warning");
  }
  mcpConfigs.set(json, path);
  return path;
}

export default function (pi: ExtensionAPI) {
  try {
    // Startup validation
    validateCliPresence(); // throws if CLI not on PATH
    validateCliAuth(); // warns if not authenticated

    const models = getModels("anthropic").map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));

    // Activate pi's direct tools too: some (find, grep, ls) are registered but not active by default.
    // Deferred, codemode and hidden tools stay as pi set them, so they are not declared to the model.
    pi.on("session_start", async (_event, ctx) => {
      ui = ctx.hasUI ? ctx.ui : undefined;
      const allTools = pi.getAllTools();
      if (Array.isArray(allTools)) {
        const direct = allTools.filter((t: any) => t.exposure === "direct").map((t: any) => t.name);
        // powershell only fails off Windows (and the sandbox blocks it anyway), so the model is not offered it there.
        const offered = (name: string) => name !== "powershell" || process.platform === "win32";
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...direct])].filter(offered));
      }
    });

    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "pi-claude-cli",
      apiKey: "unused",
      api: "pi-claude-cli",
      models,
      streamSimple: (model, context, options) => {
        const configPath = mcpConfigFor(getCurrentTools(context.messages));
        // pi >= 0.9x sends the prompt as role:"system" messages; streamViaCli expects the legacy shape.
        const legacy = {
          systemPrompt: getCurrentSystemPrompt(context.messages),
          messages: context.messages.filter((m: any) => m.role !== "system"),
        };
        return streamViaCli(model, legacy, {
          ...options,
          mcpConfigPath: configPath,
          onRateLimit: (info) => ui?.setStatus("claude", formatRateLimits(info)),
        });
      },
    });
  } catch (err) {
    console.error(`[pi-claude-cli] Failed to register provider:`, err);
  }
}
