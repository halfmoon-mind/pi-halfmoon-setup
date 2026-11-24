// Shared fixtures for extensions/sandbox/*.test.ts; each test file runs in its own process, so these are per file.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import compactTools from "../compact-tools.ts";
import sandbox, { sandboxedBash } from "./index.ts";
import { real, seam } from "./policy.ts";

export const PKG = real(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
export const HOME = homedir();
const load = seam.load;
export const temps = seam.temps;
const cwd0 = seam.cwd;
const platform0 = seam.platform;
const judge0 = seam.judge;
const judgeHost0 = seam.judgeHost;
const home0 = seam.home;
export const macOS = { skip: process.platform !== "darwin" && "the real sandbox runs on macOS here" };
export const unique = (name: string) => `${name}-${randomBytes(6).toString("hex")}`;
// Every fixture dir, removed once all tests (and their runtime shutdowns) are done.
export const made: string[] = [];
export const tmp = (prefix: string) => (made.push(mkdtempSync(join(tmpdir(), prefix))), made.at(-1)!);
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

// A fake runtime for policy tests: the real config schema, a SandboxManager that starts nothing. A wrapped command
// runs with IN_SANDBOX set, ALLOW (allowWrite, `:`-joined), BIND (allowLocalBinding) and TRUSTD (enableWeakerNetworkIsolation); `ask` is the host callback it was initialized with,
// `ids` each wrap's commandId, `updates` each updateConfig.
export async function fake(init: (c: any, ask: any) => Promise<void> = async () => {}, violations: (id: string) => { line: string }[] = () => []) {
	const actual = await load();
	const wrapped: string[] = [];
	const ids: (string | undefined)[] = [];
	const got: { ask?: (r: { host: string; port?: number }) => Promise<boolean> } = {};
	const updates: any[] = [];
	let cfg: any;
	const SandboxManager = {
		reset: async () => {},
		initialize: async (c: any, ask: any) => ((cfg = c), (got.ask = ask), init(c, ask)),
		getConfig: () => cfg,
		updateConfig: (c: any) => (updates.push(c), (cfg = c)),
		cleanupAfterCommand: () => {},
		getSandboxViolationStore: () => ({ getViolationsForCommand: (id: string) => violations(id) }),
		wrapWithSandbox: async (c: string, _b?: string, _c?: unknown, _s?: AbortSignal, o?: { commandId?: string }) => (wrapped.push(c), ids.push(o?.commandId), `IN_SANDBOX=1; ALLOW='${cfg.filesystem.allowWrite.join(":")}'; BIND='${cfg.network.allowLocalBinding}'; TRUSTD='${cfg.enableWeakerNetworkIsolation}'; export IN_SANDBOX ALLOW BIND TRUSTD; ${c}`),
	};
	return { runtime: { ...actual, SandboxManager } as any, wrapped, ids, got, updates };
}

/** The sandbox (and compact-tools, for its bash) loaded into a fake pi, with a session started in `cwd`. */
export async function start(cwd: string, { ui, files = {}, extra = {} }: { ui?: any; files?: Record<string, string>; extra?: Record<string, unknown> } = {}) {
	process.env.PI_CODING_AGENT_DIR = tmp("sandbox-agent-");
	seam.cwd = () => cwd; // as if pi runs in `cwd`, where the runtime anchors its protections
	for (const [name, text] of Object.entries(files)) writeFileSync(join(process.env.PI_CODING_AGENT_DIR, name), text);
	const handlers: Record<string, any[]> = {};
	const tools: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const pi = { on: (event: string, h: any) => (handlers[event] ??= []).push(h), registerTool: (t: any) => (tools[t.name] = t), registerCommand: (name: string, c: any) => (commands[name] = c) };
	sandbox(pi as any);
	compactTools(pi as any);
	const ctx = { cwd, hasUI: !!ui, ui, mode: ui ? "tui" : "print", sessionManager: { getEntries: () => [], getSessionId: () => "s", getSessionFile: () => undefined }, ...extra };
	for (const h of handlers.session_start) await h({}, ctx);
	const gate = async (toolName: string, input: any, c: any = ctx) => (await handlers.tool_call[0]({ toolName, input }, c)) as { block: true; reason: string } | undefined;
	const shutdown = async () => {
		for (const h of handlers.session_shutdown) await h({ reason: "quit" }, ctx);
	};
	return { gate, tools, commands, ctx, shutdown, agentDir: process.env.PI_CODING_AGENT_DIR };
}

export async function bash(command: string, cwd: string) {
	let out = "";
	const { exitCode } = await sandboxedBash.exec(command, cwd, { onData: (d) => (out += d), timeout: 30 });
	return { exitCode, out };
}

const env = { ...process.env };
export function restore() {
	for (const k of ["PI_SANDBOX", "PI_SANDBOX_ROOT", "PI_CODING_AGENT_DIR", "PI_SANDBOX_ESCALATE", "PI_SANDBOX_READONLY"]) env[k] === undefined ? delete process.env[k] : (process.env[k] = env[k]);
	seam.load = load;
	seam.temps = temps;
	seam.cwd = cwd0;
	seam.platform = platform0;
	seam.judge = judge0;
	seam.judgeHost = judgeHost0;
	seam.home = home0;
}

// Denied in the (fake) sandbox, exit 3 outside it.
export const F = `if [ -n "$IN_SANDBOX" ]; then echo 'x: Operation not permitted' >&2; exit 1; fi; echo outside; exit 3`;
export const LOW = { risk: "low", reason: "a build cache" };
export const HIGH = { risk: "high", reason: "writes a dotfile" };

/** A session on the fake runtime whose judges record their inputs; `null` keeps the default classifier. */
export async function escalating({ judge = async () => LOW, host = async () => HIGH, ui, extra, violations, files }: { judge?: ((input: any, signal?: AbortSignal) => Promise<unknown>) | null; host?: ((input: any) => Promise<unknown>) | null; ui?: any; extra?: Record<string, unknown>; violations?: (id: string) => { line: string }[]; files?: Record<string, string> } = {}) {
	const project = tmp("sandbox-project-");
	const f = await fake(undefined, violations);
	seam.load = async () => f.runtime;
	const calls: any[] = [];
	const hostCalls: any[] = [];
	if (judge) seam.judge = async (input, signal) => (calls.push(input), judge(input, signal));
	if (host) seam.judgeHost = async (input) => (hostCalls.push(input), host(input));
	delete process.env.PI_SANDBOX_ROOT;
	const s = await start(project, { ui, extra, files });
	return { ...s, ...f, calls, hostCalls, run: (command: string) => bash(command, project) };
}

/** A UI whose confirm gives what `answer` returns now and select what `pick` does, recording every notify and select title. */
export function fakeUI() {
	const u = { answer: async (): Promise<boolean> => false, pick: (_o: string[]): string | undefined => undefined, confirms: [] as string[], selects: [] as string[], notes: [] as [string, string][] };
	const ui = { confirm: async (_t: string, m: string) => (u.confirms.push(m), u.answer()), notify: (m: string, t: string) => u.notes.push([m, t]), select: async (t: string, o: string[]) => (u.selects.push(t), u.pick(o)) };
	return Object.assign(u, { ui });
}

