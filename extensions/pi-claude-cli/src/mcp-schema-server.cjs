#!/usr/bin/env node
// MCP server for pi's tools. Reads tool schemas from a JSON file.
// tools/call does not run anything: it asks pi over the socket in argv[3]
// (see mcp-config.ts) and answers with the result once pi has run the tool.
"use strict";

const fs = require("fs");
const net = require("net");
const readline = require("readline");

const schemaPath = process.argv[2];
const socketPath = process.argv[3];
if (!schemaPath || !socketPath) {
  process.exit(1);
}

let tools = [];
try {
  tools = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
} catch {
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    const resp = {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "custom-tools", version: "1.0.0" },
      },
    };
    process.stdout.write(JSON.stringify(resp) + "\n");
  } else if (msg.method === "tools/list") {
    const resp = { jsonrpc: "2.0", id: msg.id, result: { tools } };
    process.stdout.write(JSON.stringify(resp) + "\n");
  } else if (msg.method === "tools/call") {
    callPi(msg);
  }
  // notifications/initialized: no response needed (notification)
});

// The CLI tags each call with its tool_use id, which is also the id of pi's tool call.
function callPi(msg) {
  let answered = false;
  const answer = (result) => {
    if (answered) return;
    answered = true;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  };
  const failed = (text) => answer({ content: [{ type: "text", text }], isError: true });
  const id = msg.params?._meta?.["claudecode/toolUseId"];
  if (!id) return failed("pi-claude-cli: the tool call has no tool_use id");

  let reply = "";
  const conn = net.connect(socketPath, () => conn.write(JSON.stringify({ id }) + "\n"));
  conn.on("data", (data) => (reply += data));
  conn.on("end", () => {
    try {
      answer(JSON.parse(reply));
    } catch {
      failed("pi-claude-cli: pi stopped before it returned the tool result");
    }
  });
  conn.on("error", () => failed("pi-claude-cli: pi is not reachable"));
}

// The CLI closes stdin when it exits.
process.stdin.on("end", () => process.exit(0));
