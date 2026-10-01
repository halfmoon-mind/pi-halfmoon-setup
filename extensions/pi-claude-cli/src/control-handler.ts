/**
 * Control protocol handler for Claude CLI stream-json communication.
 *
 * Processes control_request messages from Claude CLI stdout and writes
 * control_response messages to stdin.
 *
 * Every tool call is allowed: pi's tools (mcp__custom-tools__*) only wait for
 * the result pi sends after running them (see mcp-config.ts), and the CLI keeps
 * only its own web tools and the user's MCP servers.
 */

import type { ClaudeControlRequest } from "./types";

interface ControlResponse {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response: {
      behavior: "allow";
      updatedInput: Record<string, unknown>;
    };
  };
}

/**
 * Handle a control_request from the Claude CLI by allowing the tool call.
 *
 * @returns false if the request was malformed and got no response
 */
export function handleControlRequest(
  msg: ClaudeControlRequest,
  stdin: NodeJS.WritableStream,
): boolean {
  if (!msg.request_id || !msg.request) {
    console.error(
      "[pi-claude-cli] Malformed control_request: missing request_id or request object",
      msg,
    );
    return false;
  }

  const response: ControlResponse = {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: msg.request_id,
      response: { behavior: "allow", updatedInput: msg.request.input },
    },
  };

  stdin.write(JSON.stringify(response) + "\n");
  return true;
}
