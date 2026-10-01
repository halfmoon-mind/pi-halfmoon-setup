/**
 * Provider orchestration for bridging pi requests to the Claude CLI subprocess.
 *
 * One CLI process stays alive across pi's calls and holds the conversation
 * itself, with its thinking and its prompt cache, so each call sends only what
 * is new:
 * 1. A tool call ends pi's turn at message_stop. The CLI keeps waiting in its
 *    MCP call (mcp-config.ts) until pi runs the tool and sends the result on
 *    its next call, then goes on in the same process.
 * 2. After a reply, pi's next user message goes to the same process.
 * 3. Anything else (the first call, another model, effort or system prompt,
 *    a compacted or edited history, an abort, an error) starts a new process
 *    with pi's whole conversation flattened into one prompt.
 *
 * Hardened lifecycle: inactivity timeout while the CLI replies, exit handler
 * with stderr surfacing, abort via SIGKILL, process registry.
 */

import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import {
  AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import {
  buildPrompt,
  buildSystemPrompt,
  buildFinalUserContent,
} from "./prompt-builder.js";
import {
  spawnClaude,
  writeUserMessage,
  captureStderr,
  forceKillProcess,
  registerProcess,
  cleanupSystemPromptFile,
} from "./process-manager.js";
import { parseLine } from "./stream-parser.js";
import { createEventBridge } from "./event-bridge.js";
import { handleControlRequest } from "./control-handler.js";
import { mapThinkingEffort } from "./thinking-config.js";
import { isPiKnownClaudeTool } from "./tool-mapping.js";
import { deliverToolResult } from "./mcp-config.js";
import type { ClaudeRateLimitEvent, NdjsonMessage } from "./types";

/** Inactivity timeout: kill subprocess if no stdout for 180 seconds (3 minutes) while it replies. */
const INACTIVITY_TIMEOUT_MS = 180_000;

/** Extended stream options: pi's SimpleStreamOptions plus optional cwd, mcpConfigPath, and onRateLimit */
type StreamViaCLiOptions = SimpleStreamOptions & {
  cwd?: string;
  mcpConfigPath?: string;
  /** Receives the subscription's usage the CLI reports with each reply. */
  onRateLimit?: (info: ClaudeRateLimitEvent["rate_limit_info"]) => void;
};

/** The CLI process that holds the conversation between pi's calls. */
interface Session {
  proc: ChildProcess;
  /** What the process was started with; a call that needs anything else needs a new process. */
  key: string;
  /** How many of pi's messages the CLI has, counting its latest reply. */
  seen: number;
  /** The latest reply's timestamp, to tell that pi's context goes on from it. */
  replyTimestamp?: number;
  /** Takes the CLI's output for the pi call in progress; unset between calls. */
  turn?: (msg: NdjsonMessage) => void;
  /** Ends the pi call in progress when the CLI exits. */
  exited?: (message: string) => void;
}

// ponytail: one process per pi process, so a second conversation in parallel would restart it each call.
let session: Session | undefined;

/**
 * Stream a response from Claude CLI as an AssistantMessageEventStream.
 *
 * @param model - The model to use (from pi's model catalog)
 * @param context - The conversation context with messages and system prompt
 * @param options - Optional cwd, abort signal, reasoning level, thinking budgets, and mcpConfigPath
 * @returns An AssistantMessageEventStream that receives bridged events
 */
export function streamViaCli(
  model: Model<any>,
  context: { messages: any[]; systemPrompt?: string },
  options?: StreamViaCLiOptions,
): AssistantMessageEventStream {
  // @ts-expect-error — tsc can't verify AssistantMessageEventStream is a value
  // through pi-ai's `export *` re-export chain. The class constructor exists at runtime.
  const stream = new AssistantMessageEventStream();

  try {
    const cwd = options?.cwd ?? process.cwd();
    const effort = mapThinkingEffort(
      options?.reasoning,
      model.id,
      options?.thinkingBudgets,
    );
    const key = JSON.stringify([
      model.id,
      effort,
      context.systemPrompt,
      cwd,
      options?.mcpConfigPath,
    ]);

    const news = session && newMessages(session, key, context.messages);
    const s = news
      ? session!
      : startSession(model, context, key, cwd, effort, options);
    runTurn(s, stream, model, context.messages.length, options);

    // Only now that the turn listens: each of these lets the CLI go on.
    for (const message of news ?? []) {
      if (message.role === "toolResult") {
        deliverToolResult(message.toolCallId, {
          content: message.content,
          isError: message.isError,
        });
      } else {
        writeUserMessage(s.proc, buildFinalUserContent(message.content));
      }
    }
  } catch (err: any) {
    stream.push({
      type: "error",
      reason: "error",
      error: err.message ?? "Unexpected error in streamViaCli",
    } as any);
    stream.end();
  }

  return stream;
}

/**
 * pi's messages since the CLI's latest reply, if pi's context goes on from it
 * and the waiting CLI can take them: a result for each of the reply's tool
 * calls, or one user message after a reply that made none.
 */
function newMessages(
  s: Session,
  key: string,
  messages: any[],
): any[] | undefined {
  const reply = messages[s.seen - 1];
  if (
    s.key !== key ||
    s.turn ||
    reply?.role !== "assistant" ||
    reply.timestamp !== s.replyTimestamp
  ) {
    return undefined;
  }
  const news = messages.slice(s.seen);
  const calls = reply.content
    .filter((c: any) => c.type === "toolCall")
    .map((c: any) => c.id);
  const fits = calls.length
    ? news.length === calls.length &&
      news.every(
        (m) => m.role === "toolResult" && calls.includes(m.toolCallId),
      )
    : news.length === 1 && news[0].role === "user";
  return fits ? news : undefined;
}

/** Start a CLI process with pi's whole conversation, replacing the running one. */
function startSession(
  model: Model<any>,
  context: { messages: any[]; systemPrompt?: string },
  key: string,
  cwd: string,
  effort: ReturnType<typeof mapThinkingEffort>,
  options?: StreamViaCLiOptions,
): Session {
  if (session) forceKillProcess(session.proc);

  const proc = spawnClaude(
    model.id,
    buildSystemPrompt(context, cwd) || undefined,
    { cwd, effort, mcpConfigPath: options?.mcpConfigPath },
  );
  registerProcess(proc);
  // A waiting process must not keep pi from exiting; the inactivity timer keeps pi up while it replies.
  for (const handle of [proc, proc.stdin, proc.stdout, proc.stderr]) (handle as any)?.unref?.();
  const getStderr = captureStderr(proc);
  // A write to a CLI that just died fails here; its close handler reports the exit.
  proc.stdin!.on("error", () => {});
  const s: Session = { proc, key, seen: context.messages.length };

  // NOTE: Using 'line' event instead of `for await` because the async
  // iterator batches lines, breaking real-time streaming to pi.
  createInterface({
    input: proc.stdout!,
    crlfDelay: Infinity,
    terminal: false,
  }).on("line", (line: string) => {
    const msg = parseLine(line);
    if (!msg) return;
    // The CLI asks before each tool call, also after pi's turn ended at that call.
    if (msg.type === "control_request") handleControlRequest(msg, proc.stdin!);
    // It can come after pi's turn ended at a tool call, so it does not go through the turn.
    else if (msg.type === "rate_limit_event") options?.onRateLimit?.(msg.rate_limit_info);
    else s.turn?.(msg);
  });

  proc.on("error", (err: Error) => s.exited?.(getStderr() || err.message));
  // stdout has closed by now, so every line was handled first.
  proc.on("close", (code: number | null) => {
    if (session === s) session = undefined;
    const stderr = getStderr().trim();
    s.exited?.(
      code
        ? stderr
          ? `Claude CLI exited with code ${code}: ${stderr}`
          : `Claude CLI exited unexpectedly with code ${code}`
        : stderr || "Claude CLI exited before it finished the reply",
    );
  });

  writeUserMessage(proc, buildPrompt(context));
  session = s;
  return s;
}

/** Bridge the CLI's output into pi's stream until its reply ends or stops at pi's tool calls. */
function runTurn(
  s: Session,
  stream: AssistantMessageEventStream,
  model: Model<any>,
  seen: number,
  options?: StreamViaCLiOptions,
): void {
  const bridge = createEventBridge(stream, model);
  let sawPiTool = false;
  let ended = false;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

  function finish(error?: string, aborted = false) {
    if (ended) return;
    ended = true;
    s.turn = s.exited = undefined;
    clearTimeout(inactivityTimer);
    options?.signal?.removeEventListener("abort", onAbort);
    cleanupSystemPromptFile();

    const output = bridge.getOutput();
    let message;
    if (error || aborted) {
      // The CLI's conversation no longer matches pi's; the next call starts over.
      forceKillProcess(s.proc);
      if (session === s) session = undefined;
      message = error
        ? {
            ...output,
            content: [
              ...(output.content ?? []),
              { type: "text" as const, text: `Error: ${error}` },
            ],
            stopReason: "stop" as const,
          }
        : output;
    } else {
      s.seen = seen + 1;
      s.replyTimestamp = output.timestamp;
      // A tool_use stop without a tool call for pi means only the CLI's own tools ran.
      const piToolCalls = output.content.some((c: any) => c.type === "toolCall");
      message = {
        ...output,
        stopReason:
          output.stopReason === "toolUse" && !piToolCalls
            ? ("stop" as const)
            : output.stopReason,
      };
    }

    const reason =
      message.stopReason === "toolUse" || message.stopReason === "length"
        ? message.stopReason
        : "stop";
    // Pushing done synchronously inside the line handler prevents pi from executing tools.
    setImmediate(() => {
      stream.push({ type: "done", reason, message } as any);
      stream.end();
    });
  }

  const onAbort = () => finish(undefined, true);

  function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(
      () =>
        finish(
          `Claude CLI subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
        ),
      INACTIVITY_TIMEOUT_MS,
    );
  }

  s.exited = (message) => finish(message);
  s.turn = (msg) => {
    resetInactivityTimer();
    if (msg.type === "stream_event") {
      // Sub-agent events (parent_tool_use_id set) are internal to the CLI.
      if ((msg as any).parent_tool_use_id) return;
      bridge.handleEvent(msg.event);
      if (
        msg.event.type === "content_block_start" &&
        msg.event.content_block?.type === "tool_use" &&
        isPiKnownClaudeTool(msg.event.content_block.name ?? "")
      ) {
        sawPiTool = true;
      }
      // pi runs the tools; the CLI waits in its MCP calls for the results.
      if (msg.event.type === "message_stop" && sawPiTool) finish();
    } else if (msg.type === "result") {
      finish(
        msg.is_error || msg.subtype !== "success"
          ? msg.errors?.join("\n") || msg.result || msg.subtype
          : undefined,
      );
    }
  };

  resetInactivityTimer();
  if (options?.signal?.aborted) onAbort();
  else options?.signal?.addEventListener("abort", onAbort, { once: true });
}
