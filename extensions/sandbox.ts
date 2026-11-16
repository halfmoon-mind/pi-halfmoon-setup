// bash runs in @anthropic-ai/sandbox-runtime's OS sandbox (sandbox-exec on macOS, bubblewrap on Linux):
// it writes only in the project and temp dirs, reaches only allowed hosts (others are asked about, or
// denied with no UI), and cannot read the listed credential paths. pi's in-process file tools (read,
// grep, find, ls, write, edit, handoff's plan) are checked here against the same paths. sudo, git push,
// rm -r and .env writes ask first; with no UI they are blocked. Fails closed: until the sandbox is up,
// or when it cannot start, bash and those tools are blocked. PI_SANDBOX=off turns all of it off.
// Not covered: this file itself failing to load, trusted extensions, user-typed !commands.
import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type BashOperations, createLocalBashOperations, type ExtensionAPI, type ExtensionUIContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

type Runtime = typeof import("@anthropic-ai/sandbox-runtime");
type Policy = { network: Record<string, unknown>; filesystem: Record<"allowWrite" | "denyWrite" | "denyRead" | "allowRead", string[]> };

const FIX =
	"Fix: in a local checkout of this package run `npm ci`; macOS needs ripgrep (brew install ripgrep); Linux needs bubblewrap, socat and ripgrep. Or set PI_SANDBOX=off to run without the sandbox.";
const PKG = real(dirname(dirname(fileURLToPath(import.meta.url))));
const HOSTS = ["github.com", "*.github.com", "*.githubusercontent.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];
// Mirrors sandbox-runtime 0.0.83's mandatory write denies (sandbox-utils.js DANGEROUS_FILES and
// getDangerousDirectories, plus .git/hooks and .git/config), compared case-insensitively as it does.
const MANDATORY = /\/(\.gitconfig|\.gitmodules|\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile|\.ripgreprc|\.mcp\.json)$|\/(\.vscode|\.idea|\.claude\/commands|\.claude\/agents|\.git\/hooks|\.git\/config)(\/|$)/i;
const GATED = new Set(["bash", "read", "write", "edit", "grep", "find", "ls", "handoff"]);

/** Test seam: how the runtime loads, and which temp dirs are writable. */
export const seam = { load: (): Promise<Runtime> => import("@anthropic-ai/sandbox-runtime"), temps: () => [tmpdir(), "/tmp"] };

let off = false;
let ui: ExtensionUIContext | undefined;
let config: Policy | undefined;
let runtime: Runtime | undefined;
let ready: Promise<void> | undefined; // undefined: startup never ran, or the session shut down
let failure: string | undefined;
const asked = new Map<string, Promise<boolean>>();

/** The path the OS opens for p, following symlinks even when they dangle. Throws on a symlink loop. */
export function real(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {}
	// Walk as the OS does: each component's link is followed before the next, so a `..` in a link
	// target applies to the dir the link before it resolved to, not to the link's spelling.
	let cur = sep;
	let parts = resolve(p).split(sep);
	let hops = 0;
	for (let i = 0; i < parts.length; i++) {
		const c = parts[i]!;
		if (!c || c === ".") continue;
		if (c === "..") {
			cur = dirname(cur);
			continue;
		}
		const next = join(cur, c);
		let link: string | undefined;
		try {
			link = readlinkSync(next);
		} catch {}
		if (link === undefined) {
			cur = next; // not a link, or missing
			continue;
		}
		if (++hops > 40) throw new Error(`too many symlinks resolving ${p}`);
		if (isAbsolute(link)) cur = sep;
		parts = [...link.split(sep), ...parts.slice(i + 1)];
		i = -1;
	}
	return cur;
}

// macOS file systems are case-insensitive by default, so `/X/.SSH` is `/x/.ssh` there.
const fold = (p: string) => (process.platform === "darwin" ? p.toLowerCase() : p);
const within = (parent: string, child: string) => {
	const [a, b] = [fold(parent), fold(child)];
	return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
};

/** pi's resolveToCwd (dist/core/tools/path-utils.js), which write, edit, grep, find and ls open. */
export function toCwd(path: string, cwd: string): string {
	let p = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
	if (p === "~") p = homedir();
	else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	if (p.startsWith("file://")) p = fileURLToPath(p);
	return resolve(cwd, p);
}

/** Every file read may open: pi's resolveReadPath and its macOS filename fallbacks, and pdf-read.ts's resolve. */
function readTargets(path: string, cwd: string): string[] {
	const p = toCwd(path, cwd);
	const curly = (s: string) => s.replace(/'/g, "\u2019");
	return [p, p.replace(/ (AM|PM)\./gi, "\u202F$1."), p.normalize("NFD"), curly(p), curly(p.normalize("NFD")), resolve(cwd, path.replace(/^@/, "").replace(/^~(?=$|\/)/, homedir()))];
}

export function policy(root: string): Policy {
	const home = homedir();
	const agent = real(getAgentDir());
	const sock = process.env.SSH_AUTH_SOCK;
	return {
		// On macOS the agent socket is then reachable; on Linux the runtime ignores the list (see its README).
		network: { allowedDomains: [...HOSTS], deniedDomains: [], allowLocalBinding: false, ...(sock ? { allowUnixSockets: [real(sock)] } : {}) },
		filesystem: {
			allowWrite: [real(root), ...seam.temps().map((t) => real(t))],
			// The runtime also makes ~/.npm/_logs and ~/.claude/debug writable (getDefaultWritePaths); deny them back.
			denyWrite: [agent, ...[".npm/_logs", ".claude/debug"].map((p) => real(join(home, p))), ...["node_modules", "package.json", "package-lock.json", ".npmrc"].map((n) => join(PKG, n))],
			denyRead: [...[".ssh", ".aws", ".gnupg", ".netrc", ".config/gh"].map((p) => real(join(home, p))), join(agent, "auth.json")],
			allowRead: [real(join(home, ".ssh/known_hosts")), real(join(home, ".ssh/config"))],
		},
	};
}

/** sandbox.json over the defaults: arrays are appended, scalars replace; filesystem entries are resolved paths, never globs. */
export function merge(base: Policy, extra: unknown, root: string): Policy {
	if (typeof extra !== "object" || extra === null || Array.isArray(extra)) throw new Error("sandbox.json must be a JSON object");
	for (const [section, values] of Object.entries(extra)) {
		if (section !== "filesystem" && section !== "network") throw new Error(`sandbox.json: unsupported section "${section}" (filesystem and network are)`);
		if (typeof values !== "object" || values === null || Array.isArray(values)) throw new Error(`sandbox.json: ${section} must be an object`);
		for (let [key, value] of Object.entries(values)) {
			if (section === "filesystem") {
				if (!Array.isArray(value) || value.some((e) => typeof e !== "string")) throw new Error(`sandbox.json: filesystem.${key} must be a list of paths`);
				const glob = value.find((e: string) => /[*?[]/.test(e));
				if (glob) throw new Error(`sandbox.json: filesystem.${key} has a glob (${glob}); name paths only`);
				value = value.map((e: string) => real(resolve(root, e.replace(/^~(?=$|\/)/, homedir()))));
			}
			const target = base[section] as Record<string, unknown>;
			target[key] = Array.isArray(value) && Array.isArray(target[key]) ? [...(target[key] as unknown[]), ...value] : value;
		}
	}
	return base;
}

function cantRead(path: string): string | undefined {
	const { denyRead, allowRead } = config!.filesystem;
	for (const p of [path, real(path)]) {
		// A more specific allowRead wins, as in the runtime.
		const deny = denyRead.find((d) => within(d, p) && !allowRead.some((a) => within(d, a) && within(a, p)));
		if (deny) return `sandbox: reading ${path} is blocked (${deny} is a credential path)`;
	}
}

function cantWrite(path: string): string | undefined {
	const { allowWrite, denyWrite } = config!.filesystem;
	const r = real(path);
	if (!allowWrite.some((a) => within(a, r))) return `sandbox: ${path} is outside the writable dirs (${allowWrite.join(", ")}); add it to filesystem.allowWrite in ${join(getAgentDir(), "sandbox.json")} if it must be written`;
	for (const p of [path, r]) {
		if (denyWrite.some((d) => within(d, p)) || MANDATORY.test(p)) return `sandbox: ${path} is write-protected; change it from your own terminal`;
	}
}

/** Why the sandbox blocks this file tool call, if it does. */
export function blocked(tool: string, input: Record<string, unknown>, cwd: string): string | undefined {
	const path = toCwd(String(input.path || "."), cwd);
	if (tool === "read") return readTargets(String(input.path ?? ""), cwd).map(cantRead).find(Boolean);
	if (tool === "ls" || tool === "find") return cantRead(path);
	if (tool === "grep") {
		const inside = config!.filesystem.denyRead.find((d) => within(path, d) || within(real(path), d));
		return cantRead(path) ?? (inside ? `sandbox: grep over ${path} would search ${inside}, a credential path; grep a narrower dir` : undefined);
	}
	if (tool === "write") return cantWrite(path);
	if (tool === "edit") return cantRead(path) ?? cantWrite(path); // edit reads the file before writing it
	if (tool === "handoff") return cantRead(resolve(cwd, String(input.plan ?? "").replace(/^@/, "")));
}

/** What the user should confirm first; a speed bump, not a boundary. */
export function risky(tool: string, input: Record<string, unknown>, cwd: string): string | undefined {
	if (tool === "bash") {
		const c = String(input.command ?? "");
		if (/\bsudo\b/.test(c)) return "bash runs sudo";
		if (/\bgit\b[^;&|\n]*\bpush\b/.test(c)) return "bash runs git push";
		if (/\brm\b[^;&|\n]*\s(-[a-zA-Z]*[rR]|--recursive)/.test(c)) return "bash deletes recursively (rm -r)";
	}
	if ((tool === "write" || tool === "edit") && basename(toCwd(String(input.path ?? ""), cwd)).startsWith(".env")) return `${tool} changes ${input.path}`;
}

/** Why bash and the checked tools cannot run now, if they cannot. */
async function notReady(): Promise<string | undefined> {
	if (!ready) return `sandbox: not started (no session_start, or the session ended). ${FIX}`;
	await ready;
	return failure;
}

/** An unknown host: asked once per host per session, concurrent requests sharing the question; no UI denies. */
function ask({ host, port }: { host: string; port: number | undefined }): Promise<boolean> {
	if (!ui) return Promise.resolve(false);
	let answer = asked.get(host);
	if (!answer) {
		answer = ui.confirm("Sandbox: allow network host?", `bash wants to reach ${host}${port ? `:${port}` : ""}. Allow it for this session?`).catch(() => false);
		asked.set(host, answer);
	}
	return answer;
}

export async function wrap(command: string): Promise<string> {
	const reason = await notReady();
	if (reason) throw new Error(reason);
	return runtime!.SandboxManager.wrapWithSandbox(command);
}

const local = createLocalBashOperations();

const run: BashOperations["exec"] = async (command, cwd, options) => {
	if (off) return local.exec(command, cwd, options);
	const wrapped = await wrap(command); // throws before anything runs
	try {
		return await local.exec(wrapped, cwd, options);
	} finally {
		runtime?.SandboxManager.cleanupAfterCommand();
	}
};

// pi loads each extension in its own module instance (jiti, moduleCache: false), so compact-tools' copy of
// this file is not the one whose session_start ran. The factory publishes its exec here; without it, bash fails closed.
const LIVE = Symbol.for("pi-halfmoon-setup/sandbox-exec");

export const sandboxedBash: BashOperations = {
	exec: (command, cwd, options) => (((globalThis as any)[LIVE] as typeof run | undefined) ?? run)(command, cwd, options),
};

export default function (pi: ExtensionAPI) {
	off = process.env.PI_SANDBOX === "off";
	(globalThis as any)[LIVE] = run;
	pi.on("tool_call", async (event, ctx) => {
		if (off) return;
		if (event.toolName === "powershell") return { block: true, reason: "sandbox: powershell runs outside the OS sandbox; use bash" };
		if (GATED.has(event.toolName)) {
			let reason: string | undefined;
			try {
				reason = (await notReady()) ?? blocked(event.toolName, event.input, ctx.cwd);
			} catch (e) {
				reason = `sandbox: ${(e as Error).message}`; // a path that cannot be resolved is not allowed
			}
			if (reason) return { block: true, reason };
		}
		const r = risky(event.toolName, event.input, ctx.cwd);
		if (!r) return;
		if (!ctx.hasUI) return { block: true, reason: `${r}, which needs the user's confirmation and this pi has no UI: ask the user to run it themselves` };
		if (!(await ctx.ui.confirm("Sandbox: confirm", `${r}. Allow it?`))) return { block: true, reason: `the user declined: ${r}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		if (off) {
			if (ctx.hasUI) ctx.ui.notify("sandbox: PI_SANDBOX=off, so bash and the file tools run without the sandbox", "warning");
			return;
		}
		ui = ctx.hasUI ? ctx.ui : undefined;
		asked.clear();
		failure = undefined;
		let done!: () => void;
		ready = new Promise((r) => (done = r));
		try {
			try {
				runtime = await seam.load();
			} catch (e) {
				throw new Error(`sandbox-runtime did not load (${(e as Error).message})`);
			}
			await runtime.SandboxManager.reset();
			// A subagent or other UI-less pi keeps the root it inherited, so its cwd cannot widen what is writable.
			const root = (!ui && process.env.PI_SANDBOX_ROOT) || ctx.cwd;
			process.env.PI_SANDBOX_ROOT = root;
			const file = join(getAgentDir(), "sandbox.json");
			const merged = merge(policy(root), existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}, root);
			const parsed = runtime.SandboxRuntimeConfigSchema.safeParse(merged);
			if (!parsed.success) throw new Error(`invalid sandbox policy: ${parsed.error.message}`);
			config = merged;
			await runtime.SandboxManager.initialize(parsed.data as SandboxRuntimeConfig, ask);
			if (ui && within(real(root), PKG)) {
				ui.notify(`sandbox: this project holds the loaded pi package (${PKG}); edits to its code run unsandboxed on /reload, restart or the next subagent startup`, "warning");
			}
		} catch (e) {
			failure = `sandbox: could not start, so bash and the file tools are blocked: ${(e as Error).message}. ${FIX}`;
			if (ui) ui.notify(failure, "error");
		} finally {
			done();
		}
	});

	pi.on("session_shutdown", async () => {
		ready = undefined;
		// Idempotent, and a cleanup error must not hide why startup failed.
		await runtime?.SandboxManager.reset().catch(() => {});
	});
}
