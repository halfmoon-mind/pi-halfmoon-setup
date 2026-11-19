/**
 * pi's tools for the Claude CLI, served by mcp-schema-server.cjs.
 *
 * The CLI calls every pi tool through that MCP server. Its tools/call waits on
 * a unix socket here until pi has run the tool and the provider hands the
 * result to deliverToolResult, so the CLI gets a real tool result and goes on.
 */

import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** A pi tool definition with MCP-compatible schema. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The MCP definitions of the given pi tools.
 *
 * @param tools - The tools pi declares to the model
 * @returns Array of tool definitions
 */
export function getToolDefs(tools: any[]): McpToolDef[] {
  return tools.map((tool: any) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }));
}

/** MCP calls waiting for pi's result, by tool_use id. */
const waiting = new Map<string, (result: unknown) => void>();
/** Results pi sent before the CLI made the call. */
const early = new Map<string, unknown>();

/** Answer the CLI's MCP call for this tool_use id, now or when it arrives. */
export function deliverToolResult(id: string, result: unknown): void {
  const reply = waiting.get(id);
  if (!reply) {
    early.set(id, result);
    return;
  }
  waiting.delete(id);
  reply(result);
}

const socketPath = join(tmpdir(), `pi-claude-cli-${process.pid}.sock`);
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  rmSync(socketPath, { force: true });
  createServer((conn) => {
    // The CLI may be killed while it waits, closing the connection.
    conn.on("error", () => {});
    createInterface({ input: conn }).once("line", (line) => {
      let id: string;
      try {
        id = JSON.parse(line).id;
      } catch {
        conn.destroy();
        return;
      }
      const reply = (result: unknown) =>
        conn.end(JSON.stringify(result) + "\n");
      if (early.has(id)) {
        reply(early.get(id));
        early.delete(id);
        return;
      }
      waiting.set(id, reply);
      conn.on("close", () => {
        if (waiting.get(id) === reply) waiting.delete(id);
      });
    });
  })
    .listen(socketPath)
    .unref();
}

/**
 * Write the MCP config and tool schemas to temp files, and start listening
 * for the MCP server's tool calls.
 *
 * @param toolDefs - Array of pi tool definitions
 * @returns Path to the MCP config file
 */
export function writeMcpConfig(toolDefs: McpToolDef[]): string {
  // Named by the tool set, so a changed set gets a new config path and a new CLI process.
  const json = JSON.stringify(toolDefs);
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 12);

  // Write tool schemas to temp file
  const schemaFilePath = join(
    tmpdir(),
    `pi-claude-mcp-schemas-${process.pid}-${hash}.json`,
  );
  writeFileSync(schemaFilePath, json);

  listen();

  // Resolve path to the schema server .cjs file (sibling of this module)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const serverPath = join(__dirname, "mcp-schema-server.cjs");

  // Build MCP config
  const config = {
    mcpServers: {
      "custom-tools": {
        command: "node",
        args: [serverPath, schemaFilePath, socketPath],
      },
    },
  };

  // Write config to temp file
  const configFilePath = join(
    tmpdir(),
    `pi-claude-mcp-config-${process.pid}-${hash}.json`,
  );
  writeFileSync(configFilePath, JSON.stringify(config));

  return configFilePath;
}
