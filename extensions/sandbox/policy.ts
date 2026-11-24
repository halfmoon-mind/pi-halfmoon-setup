// The sandbox's path policy: the default allow/deny lists, sandbox.json merging, path resolution and the test seam.
import { lstatSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Runtime = typeof import("@anthropic-ai/sandbox-runtime");
export type Policy = { network: Record<string, unknown>; filesystem: Record<"allowWrite" | "denyWrite" | "denyRead" | "allowRead", string[]>; enableWeakerNetworkIsolation?: boolean };

export const START_FAILED = "sandbox: could not start";
export const NOT_STARTED = "sandbox: not started";

export const PKG = real(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const HOSTS = ["github.com", "*.github.com", "*.githubusercontent.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];
// Mirrors sandbox-runtime 0.0.83's mandatory write denies (sandbox-utils.js DANGEROUS_FILES and
// getDangerousDirectories, plus .git/hooks and .git/config), compared case-insensitively as it does.
// Plus the .git entries that point git at another config and hooks (GIT_REDIRECTS), which the runtime leaves writable.
export const MANDATORY = /\/(\.gitconfig|\.gitmodules|\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile|\.ripgreprc|\.mcp\.json)$|\/(\.vscode|\.idea|\.claude\/commands|\.claude\/agents|\.git\/hooks|\.git\/config|\.git\/config\.worktree|\.git\/commondir|\.git\/modules|\.git\/worktrees)(\/|$)/i;
// commondir and a worktree's or submodule's gitdir can send git to a config in a writable dir (/tmp), whose
// core.fsmonitor or hooksPath then runs unsandboxed at the user's next `git status`.
// ponytail: the project's own .git only; a new `sub/.git` file pointing elsewhere is still writable (option B, not taken).
const GIT_REDIRECTS = ["commondir", "config.worktree", "modules", "worktrees"];
// On Linux the runtime denies an absent path by mounting /dev/null there, and git dies on an empty commondir
// ("failed to read .git/commondir"). So there a repo gets a real one first, naming its own dir ("."), which git
// reads as no redirect at all; the runtime then binds that file read-only for every command.
export function ownCommondir(root: string) {
	const git = join(root, ".git");
	if (seam.platform() !== "linux" || !lstatSync(git, { throwIfNoEntry: false })?.isDirectory()) return;
	if (!lstatSync(join(git, "commondir"), { throwIfNoEntry: false })) writeFileSync(join(git, "commondir"), ".\n", { flag: "wx" });
}
// The first component of every protected dir above. The runtime spells those relative to its cwd, so a cwd at or
// under one (`.git`, where `config` and `hooks` are) would leave the real ones unprotected.
export const PROTECTED_CWD = /\/(\.git|\.claude|\.vscode|\.idea)(\/|$)/i;

/** Test seam: how the runtime loads, which temp dirs are writable, the dir the runtime anchors its protections at, and who rates a blocked command. */
export const seam = {
	load: (): Promise<Runtime> => import("@anthropic-ai/sandbox-runtime"),
	temps: () => [tmpdir(), "/tmp"],
	cwd: () => process.cwd(),
	platform: () => process.platform,
	judge: (input: object, signal?: AbortSignal): Promise<unknown> => Promise.reject(new Error("no classifier")), // set by index.ts, which holds the classifier and its session
	judgeHost: (input: object, signal?: AbortSignal): Promise<unknown> => Promise.reject(new Error("no classifier")), // set by index.ts, which holds the classifier and its session
	home: () => homedir(),
};

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
export const fold = (p: string) => (process.platform === "darwin" ? p.toLowerCase() : p);
export const within = (parent: string, child: string) => {
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
export function readTargets(path: string, cwd: string): string[] {
	const p = toCwd(path, cwd);
	const curly = (s: string) => s.replace(/'/g, "\u2019");
	return [p, p.replace(/ (AM|PM)\./gi, "\u202F$1."), p.normalize("NFD"), curly(p), curly(p.normalize("NFD")), resolve(cwd, path.replace(/^@/, "").replace(/^~(?=$|\/)/, homedir()))];
}

export function policy(root: string | undefined): Policy {
	const home = homedir();
	const agent = real(getAgentDir());
	const sock = process.env.SSH_AUTH_SOCK;
	return {
		// On macOS the agent socket is then reachable; on Linux the runtime ignores the list (see its README).
		network: { allowedDomains: [...HOSTS], deniedDomains: [], allowLocalBinding: false, ...(sock ? { allowUnixSockets: [real(sock)] } : {}) },
		filesystem: {
			allowWrite: [...(root ? [real(root)] : []), ...seam.temps().map((t) => real(t))],
			// The runtime also makes ~/.npm/_logs and ~/.claude/debug writable (getDefaultWritePaths); deny them back.
			denyWrite: [
				agent,
				...[".npm/_logs", ".claude/debug"].map((p) => real(join(home, p))),
				...["node_modules", "package.json", "package-lock.json", ".npmrc"].map((n) => join(PKG, n)),
				...(root ? GIT_REDIRECTS.map((n) => join(real(root), ".git", n)) : []),
				// A linked worktree's .git is a "gitdir:" pointer file, as much a redirect as commondir; Linux's runtime denies it already.
				...(root && seam.platform() !== "linux" && lstatSync(join(real(root), ".git"), { throwIfNoEntry: false })?.isFile() ? [join(real(root), ".git")] : []),
			],
			denyRead: [...[".ssh", ".aws", ".gnupg", ".netrc", ".config/gh"].map((p) => real(join(home, p))), join(agent, "auth.json")],
			allowRead: [real(join(home, ".ssh/known_hosts")), real(join(home, ".ssh/config"))],
		},
	};
}

/** sandbox.json over the defaults: arrays are appended, scalars replace; filesystem entries are resolved paths, never globs. */
export function merge(base: Policy, extra: unknown, root: string): Policy {
	if (typeof extra !== "object" || extra === null || Array.isArray(extra)) throw new Error("sandbox.json must be a JSON object");
	for (const [section, values] of Object.entries(extra)) {
		if (section === "enableWeakerNetworkIsolation") {
			if (typeof values !== "boolean") throw new Error("sandbox.json: enableWeakerNetworkIsolation must be true or false");
			base.enableWeakerNetworkIsolation = values;
			continue;
		}
		if (section !== "filesystem" && section !== "network") throw new Error(`sandbox.json: unsupported section "${section}" (filesystem, network and enableWeakerNetworkIsolation are)`);
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
