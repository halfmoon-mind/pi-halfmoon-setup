// Run: node --import ./extensions/test-hooks.ts --test --test-timeout=60000 extensions/sandbox.test.ts
// From a trusted terminal or CI: the macOS tests start the real sandbox, which cannot nest in another.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createWriteToolDefinition, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import compactTools from "./compact-tools.ts";
import sandbox, { blocked, merge, policy, real, risky, sandboxedBash, scanner, seam, verdict } from "./sandbox.ts";

const PKG = real(dirname(dirname(fileURLToPath(import.meta.url))));
const HOME = homedir();
const load = seam.load;
const temps = seam.temps;
const cwd0 = seam.cwd;
const platform0 = seam.platform;
const judge0 = seam.judge;
const judgeHost0 = seam.judgeHost;
const macOS = { skip: process.platform !== "darwin" && "the real sandbox runs on macOS here" };
const unique = (name: string) => `${name}-${randomBytes(6).toString("hex")}`;
// Every fixture dir, removed once all tests (and their runtime shutdowns) are done.
const made: string[] = [];
const tmp = (prefix: string) => (made.push(mkdtempSync(join(tmpdir(), prefix))), made.at(-1)!);
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

// A fake runtime for policy tests: the real config schema, a SandboxManager that starts nothing. A wrapped command
// runs with IN_SANDBOX set; `ask` is the host callback it was initialized with, `ids` each wrap's commandId.
async function fake(init: (c: any, ask: any) => Promise<void> = async () => {}, violations: (id: string) => { line: string }[] = () => []) {
	const actual = await load();
	const wrapped: string[] = [];
	const ids: (string | undefined)[] = [];
	const got: { ask?: (r: { host: string; port?: number }) => Promise<boolean> } = {};
	const SandboxManager = {
		reset: async () => {},
		initialize: async (c: any, ask: any) => ((got.ask = ask), init(c, ask)),
		cleanupAfterCommand: () => {},
		getSandboxViolationStore: () => ({ getViolationsForCommand: (id: string) => violations(id) }),
		wrapWithSandbox: async (c: string, _b?: string, _c?: unknown, _s?: AbortSignal, o?: { commandId?: string }) => (wrapped.push(c), ids.push(o?.commandId), `IN_SANDBOX=1; export IN_SANDBOX; ${c}`),
	};
	return { runtime: { ...actual, SandboxManager } as any, wrapped, ids, got };
}

/** The sandbox (and compact-tools, for its bash) loaded into a fake pi, with a session started in `cwd`. */
async function start(cwd: string, { ui, files = {}, extra = {} }: { ui?: any; files?: Record<string, string>; extra?: Record<string, unknown> } = {}) {
	process.env.PI_CODING_AGENT_DIR = tmp("sandbox-agent-");
	seam.cwd = () => cwd; // as if pi runs in `cwd`, where the runtime anchors its protections
	for (const [name, text] of Object.entries(files)) writeFileSync(join(process.env.PI_CODING_AGENT_DIR, name), text);
	const handlers: Record<string, any[]> = {};
	const tools: Record<string, any> = {};
	const pi = { on: (event: string, h: any) => (handlers[event] ??= []).push(h), registerTool: (t: any) => (tools[t.name] = t) };
	sandbox(pi as any);
	compactTools(pi as any);
	const ctx = { cwd, hasUI: !!ui, ui, mode: ui ? "tui" : "print", sessionManager: { getEntries: () => [], getSessionId: () => "s", getSessionFile: () => undefined }, ...extra };
	for (const h of handlers.session_start) await h({}, ctx);
	const gate = async (toolName: string, input: any, c: any = ctx) => (await handlers.tool_call[0]({ toolName, input }, c)) as { block: true; reason: string } | undefined;
	const shutdown = async () => {
		for (const h of handlers.session_shutdown) await h({ reason: "quit" }, ctx);
	};
	return { gate, tools, ctx, shutdown, agentDir: process.env.PI_CODING_AGENT_DIR };
}

async function bash(command: string, cwd: string) {
	let out = "";
	const { exitCode } = await sandboxedBash.exec(command, cwd, { onData: (d) => (out += d), timeout: 30 });
	return { exitCode, out };
}

const env = { ...process.env };
function restore() {
	for (const k of ["PI_SANDBOX", "PI_SANDBOX_ROOT", "PI_CODING_AGENT_DIR", "PI_SANDBOX_ESCALATE"]) env[k] === undefined ? delete process.env[k] : (process.env[k] = env[k]);
	seam.load = load;
	seam.temps = temps;
	seam.cwd = cwd0;
	seam.platform = platform0;
	seam.judge = judge0;
	seam.judgeHost = judgeHost0;
}

// Denied in the (fake) sandbox, exit 3 outside it.
const F = `if [ -n "$IN_SANDBOX" ]; then echo 'x: Operation not permitted' >&2; exit 1; fi; echo outside; exit 3`;
const LOW = { risk: "low", reason: "a build cache" };
const HIGH = { risk: "high", reason: "writes a dotfile" };

/** A session on the fake runtime whose judges record their inputs; `null` keeps the default classifier. */
async function escalating({ judge = async () => LOW, host = async () => HIGH, ui, extra, violations }: { judge?: ((input: any, signal?: AbortSignal) => Promise<unknown>) | null; host?: ((input: any) => Promise<unknown>) | null; ui?: any; extra?: Record<string, unknown>; violations?: (id: string) => { line: string }[] } = {}) {
	const project = tmp("sandbox-project-");
	const f = await fake(undefined, violations);
	seam.load = async () => f.runtime;
	const calls: any[] = [];
	const hostCalls: any[] = [];
	if (judge) seam.judge = async (input, signal) => (calls.push(input), judge(input, signal));
	if (host) seam.judgeHost = async (input) => (hostCalls.push(input), host(input));
	delete process.env.PI_SANDBOX_ROOT;
	const s = await start(project, { ui, extra });
	return { ...s, ...f, calls, hostCalls, run: (command: string) => bash(command, project) };
}

/** A UI whose confirm gives what `answer` returns now, recording every notify. */
function fakeUI() {
	const u = { answer: async (): Promise<boolean> => false, confirms: [] as string[], notes: [] as [string, string][] };
	return Object.assign(u, { ui: { confirm: async (_t: string, m: string) => (u.confirms.push(m), u.answer()), notify: (m: string, t: string) => u.notes.push([m, t]) } });
}

test("before startup, bash refuses to run", async () => {
	await assert.rejects(sandboxedBash.exec("true", process.cwd(), { onData: () => {} }), /sandbox/);
});

test("a missing runtime, a failed init, a malformed policy and a shut-down session never run bash unsandboxed", async () => {
	const project = tmp("sandbox-project-");
	const marker = join(project, "ran");
	const cases: [string, () => Promise<any>, Record<string, string>, RegExp][] = [
		["missing runtime", () => Promise.reject(new Error("Cannot find package '@anthropic-ai/sandbox-runtime'")), {}, /did not load.*npm ci/],
		["rejected init", async () => (await fake(() => Promise.reject(new Error("ripgrep (rg) not found")))).runtime, {}, /ripgrep/],
		["malformed JSON", async () => (await fake()).runtime, { "sandbox.json": "{" }, /JSON/],
		["invalid policy", async () => (await fake()).runtime, { "sandbox.json": '{"network": {"allowedDomains": "example.com"}}' }, /invalid sandbox policy/],
	];
	try {
		for (const [name, runtime, files, reason] of cases) {
			delete process.env.PI_SANDBOX_ROOT;
			seam.load = runtime;
			const s = await start(project, { files });
			try {
				await assert.rejects(bash(`touch ${marker}`, project), reason, name);
				assert.match((await s.gate("bash", { command: "ls" }))!.reason, reason, name);
				assert.match((await s.gate("read", { path: "a.txt" }))!.reason, reason, name);
				assert.equal(existsSync(marker), false, name);
			} finally {
				await s.shutdown();
			}
		}
		const { runtime, wrapped } = await fake();
		seam.load = async () => runtime;
		const s = await start(project);
		await s.shutdown();
		await assert.rejects(bash(`touch ${marker}`, project), /not started/);
		assert.match((await s.gate("write", { path: "a.txt" }))!.reason, /not started/);
		assert.deepEqual(wrapped, []);
		assert.equal(existsSync(marker), false);
	} finally {
		restore();
	}
});

test("file tools follow the path policy: project and temp writes, credential reads, protected names, symlinks and resolver variants", async () => {
	const project = tmp("sandbox-project-");
	const spaced = join(project, "a\u00A0b");
	const curly = join(project, "s\u2019s");
	const secret = join(project, "secret.txt");
	writeFileSync(secret, "s");
	seam.load = async () => (await fake()).runtime;
	delete process.env.PI_SANDBOX_ROOT;
	const s = await start(project, { files: { "sandbox.json": JSON.stringify({ filesystem: { denyRead: [secret, spaced, curly] } }) } });
	const may = (tool: string, input: any, cwd = project) => blocked(tool, input, cwd);
	try {
		assert.equal(may("write", { path: "src/a.ts" }), undefined);
		assert.equal(may("write", { path: join(tmpdir(), "x") }), undefined);
		assert.equal(may("write", { path: "/tmp/x" }), undefined);
		assert.match(may("write", { path: join(HOME, unique(".pi-sandbox-probe")) })!, /outside the writable dirs/);
		// Symlinks are followed even when they dangle.
		symlinkSync(join(HOME, unique(".pi-sandbox-probe"), "x"), join(project, "dangling"));
		symlinkSync(HOME, join(project, "home"));
		assert.match(may("write", { path: "dangling" })!, /outside/);
		assert.match(may("edit", { path: "home/notes.txt" })!, /outside/);
		for (const p of [".bashrc", "sub/.ZSHRC", ".git/hooks/pre-commit", ".Git/Config", "a/.vscode/settings.json", ".claude/commands/x.md", ".mcp.json"]) {
			assert.match(may("write", { path: p })!, /write-protected/, p);
		}
		assert.equal(may("write", { path: ".git/HEAD" }), undefined);
		for (const p of [".git/commondir", ".git/config.worktree", ".git/modules/m/config", ".git/worktrees/w/gitdir"]) {
			assert.match(may("write", { path: p })!, /write-protected/, p);
		}
		assert.match(may("write", { path: join(s.agentDir, "settings.json") })!, /write-protected/, "the agent dir, though it is in a temp dir");
		// Reads: credential paths, with SSH's config and known_hosts open.
		for (const p of ["~/.ssh/id_ed25519", "~/.aws/credentials", "~/.config/gh/hosts.yml", "~/.netrc", join(s.agentDir, "auth.json"), "@~/.ssh/id_rsa"]) {
			assert.match(may("read", { path: p })!, /credential path/, p);
		}
		assert.equal(may("read", { path: "~/.ssh/config" }), undefined);
		assert.equal(may("read", { path: "~/.ssh/known_hosts" }), undefined);
		assert.match(may("ls", { path: "~/.ssh" })!, /credential/);
		assert.match(may("find", { path: "~/.gnupg" })!, /credential/);
		assert.match(may("grep", { path: HOME })!, /grep over/, "an ancestor of a denied path");
		assert.match(may("grep", {})!, /grep over/, "the project holds the denied secret.txt");
		assert.equal(may("grep", { path: "src" }), undefined);
		// edit reads the file first: writable but read-denied fails.
		assert.equal(may("write", { path: secret }), undefined);
		assert.match(may("edit", { path: secret })!, /reading/);
		// PDF/Office read, read's filename fallbacks and handoff's plan resolve differently; none gets past.
		assert.match(may("read", { path: "~/.ssh/key.pdf" })!, /credential/);
		assert.match(may("read", { path: "~/.aws/notes.docx" })!, /credential/);
		assert.match(may("read", { path: "a\u00A0b/x.pdf" })!, /credential/, "pdf-read keeps the no-break space pi's resolver drops");
		assert.match(may("read", { path: "s's/x.txt" })!, /credential/, "read's curly-quote fallback");
		assert.match(may("handoff", { plan: `@${HOME}/.ssh/plan.md` })!, /credential/);
		assert.equal(may("handoff", { plan: "docs/plans/x.md" }), undefined);
		await s.shutdown();

		// With this package as the project, its code is writable and its dependencies and manifests are not.
		delete process.env.PI_SANDBOX_ROOT;
		const p = await start(PKG);
		try {
			assert.equal(blocked("write", { path: "extensions/x.ts" }, PKG), undefined);
			for (const f of ["node_modules/zod/index.js", "package.json", "package-lock.json", ".npmrc", ...(process.platform === "darwin" ? ["NODE_MODULES/x"] : [])]) {
				assert.match(blocked("write", { path: f }, PKG)!, /write-protected/, f);
			}
		} finally {
			await p.shutdown();
		}
	} finally {
		await s.shutdown();
		restore();
		rmSync(project, { recursive: true, force: true });
	}
});

test("a pi with no UI writes its cwd only inside the root it inherited, so a subagent cwd cannot widen it; temp dirs stay writable", async () => {
	const a = tmp("sandbox-root-a-");
	const b = tmp("sandbox-root-b-");
	const sub = join(a, "sub");
	mkdirSync(sub);
	seam.load = async () => (await fake()).runtime;
	seam.temps = () => []; // a and b stand in for dirs outside every temp dir
	process.env.PI_SANDBOX_ROOT = a;
	try {
		// cwd outside the inherited root: no project at all, and the root handed on stays a.
		let s = await start(b);
		assert.equal(process.env.PI_SANDBOX_ROOT, a);
		assert.match(blocked("write", { path: "x" }, b)!, /outside/);
		assert.match(blocked("write", { path: join(a, "x") }, b)!, /outside/);
		await s.shutdown();
		// cwd inside it: only that cwd, where the runtime's protections are anchored.
		process.env.PI_SANDBOX_ROOT = a;
		s = await start(sub);
		assert.equal(process.env.PI_SANDBOX_ROOT, real(sub));
		assert.equal(blocked("write", { path: "x" }, sub), undefined);
		assert.match(blocked("write", { path: join(a, "x") }, sub)!, /outside/);
		await s.shutdown();
		seam.temps = temps;
		process.env.PI_SANDBOX_ROOT = a;
		s = await start(b);
		assert.equal(blocked("write", { path: join(tmpdir(), "x") }, b), undefined);
		await s.shutdown();
		// A pi with a UI is the first pi: its cwd is the root, handed to its children.
		s = await start(b, { ui: { confirm: async () => true, notify: () => {} } });
		assert.equal(process.env.PI_SANDBOX_ROOT, real(b));
		await s.shutdown();
	} finally {
		restore();
	}
});

test("sudo, git push, rm -r and .env writes ask first; no UI blocks them", async () => {
	const project = tmp("sandbox-project-");
	seam.load = async () => (await fake()).runtime;
	delete process.env.PI_SANDBOX_ROOT;
	const s = await start(project);
	const asked: string[] = [];
	const withUI = (answer: boolean) => ({ ...s.ctx, hasUI: true, ui: { confirm: async (_t: string, m: string) => (asked.push(m), answer) } });
	try {
		for (const command of ["sudo ls", "git -C x push origin main", "rm -rf build", "rm -f -r build", "rm --recursive build"]) assert.ok(risky("bash", { command }, project), command);
		for (const command of ["ls", "git status", "rm -f a.txt", "rm --force a-r"]) assert.equal(risky("bash", { command }, project), undefined, command);
		assert.ok(risky("write", { path: ".env.local" }, project));
		assert.equal(risky("write", { path: "a.env" }, project), undefined);

		assert.match((await s.gate("bash", { command: "sudo ls" }))!.reason, /no UI/);
		assert.match((await s.gate("edit", { path: ".env" }))!.reason, /no UI/);
		assert.match((await s.gate("bash", { command: "git push" }, withUI(false)))!.reason, /declined/);
		assert.equal(await s.gate("bash", { command: "git push" }, withUI(true)), undefined);
		assert.equal(await s.gate("write", { path: ".env" }, withUI(true)), undefined);
		assert.equal(asked.length, 3);
		assert.equal(await s.gate("bash", { command: "ls" }), undefined);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("sandbox.json appends arrays and replaces scalars, and a glob is refused", async () => {
	const root = tmp("sandbox-project-");
	const merged = merge(policy(root), { filesystem: { allowWrite: ["~/.npm"] }, network: { allowedDomains: ["example.com"], allowLocalBinding: true } }, root);
	assert.deepEqual(merged.filesystem.allowWrite.slice(0, 1), [real(root)]);
	assert.equal(merged.filesystem.allowWrite.at(-1), real(join(HOME, ".npm")));
	assert.deepEqual((merged.network.allowedDomains as string[]).slice(-2), ["files.pythonhosted.org", "example.com"]);
	assert.equal(merged.network.allowLocalBinding, true);
	assert.throws(() => merge(policy(root), { filesystem: { denyRead: ["~/*.pem"] } }, root), /glob/);
	assert.throws(() => merge(policy(root), { filesystem: { allowWrite: ["src/[ab]"] } }, root), /glob/);
	assert.throws(() => merge(policy(root), { credentials: {} }, root), /unsupported section/);
	assert.throws(() => merge(policy(root), [], root), /object/);

	seam.load = async () => (await fake()).runtime;
	delete process.env.PI_SANDBOX_ROOT;
	const s = await start(root, { files: { "sandbox.json": '{"filesystem": {"denyWrite": ["**/.env"]}}' } });
	try {
		assert.match((await s.gate("bash", { command: "ls" }))!.reason, /glob/);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("PI_SANDBOX=off runs bash unwrapped and checks no file tool", async () => {
	const project = tmp("sandbox-project-");
	process.env.PI_SANDBOX = "off";
	let loaded = false;
	seam.load = async () => ((loaded = true), (await fake()).runtime);
	const s = await start(project);
	try {
		assert.equal(await s.gate("write", { path: join(HOME, ".pi-sandbox-probe") }), undefined);
		assert.equal(await s.gate("read", { path: "~/.ssh/id_rsa" }), undefined);
		assert.deepEqual(await bash("echo plain", project), { exitCode: 0, out: "plain\n" });
		assert.equal(loaded, false);
	} finally {
		await s.shutdown();
		restore();
		sandbox({ on: () => {} } as any); // back on for the next tests
	}
});

test("macOS: the real sandbox lets bash write the project, not outside it, not read a denied file, and reach only allowed hosts", macOS, async () => {
	const secret = join(tmp("sandbox-secret-"), "secret.txt");
	writeFileSync(secret, "s");
	const inside = join(PKG, unique(".sandbox-probe"));
	const outside = join(HOME, unique(".pi-sandbox-probe"));
	delete process.env.PI_SANDBOX_ROOT;
	const s = await start(PKG, { files: { "sandbox.json": JSON.stringify({ filesystem: { denyRead: [secret] } }) } });
	try {
		assert.equal((await bash(`echo ok > ${inside} && cat ${inside}`, PKG)).out, "ok\n");
		assert.notEqual((await bash(`echo x > ${outside}`, PKG)).exitCode, 0);
		assert.equal(existsSync(outside), false);
		assert.notEqual((await bash(`cat ${secret}`, PKG)).exitCode, 0);
		seam.judgeHost = async () => HIGH;
		const status = async (url: string) => (await bash(`curl -sS -m 15 -o /dev/null -w '%{http_code}' ${url}`, PKG)).out;
		assert.doesNotMatch(await status("https://example.com"), /^2\d\d/);
		assert.match(await status("https://registry.npmjs.org/"), /^200/);
	} finally {
		await s.shutdown();
		restore();
		rmSync(inside, { force: true });
		if (existsSync(outside)) rmSync(outside); // only ours: the name is unique
	}
});

test("macOS: the registered bash tool, through the tool_call gate, writes inside the project and not outside it", macOS, async () => {
	const project = join(PKG, unique(".sandbox-project"));
	mkdirSync(project);
	const outside = join(HOME, unique(".pi-sandbox-probe"));
	delete process.env.PI_SANDBOX_ROOT;
	const s = await start(project);
	const run = async (command: string) => {
		const gate = await s.gate("bash", { command });
		assert.equal(gate, undefined);
		return s.tools.bash.execute("call", { command }, undefined, undefined, s.ctx);
	};
	try {
		const result = await run("echo ok > inside.txt && cat inside.txt");
		assert.match(result.content[0].text, /ok/);
		const denied = await run(`echo x > ${outside}`);
		assert.equal(denied.isError, true);
		assert.match(denied.content[0].text, /Operation not permitted/);
		assert.equal(existsSync(outside), false);
	} finally {
		await s.shutdown();
		restore();
		rmSync(project, { recursive: true, force: true });
		if (existsSync(outside)) rmSync(outside);
	}
});

test("a symlink behind many missing dirs, or a symlink loop, is still resolved or blocked; powershell is blocked", async () => {
	const project = tmp("sandbox-project-");
	seam.load = async () => (await fake()).runtime;
	delete process.env.PI_SANDBOX_ROOT;
	const s = await start(project);
	try {
		symlinkSync(HOME, join(project, "escape"));
		const deep = ["escape", ...Array.from({ length: 60 }, (_, i) => `d${i}`), "file.txt"].join("/");
		assert.match(blocked("write", { path: deep }, project)!, /outside/);
		symlinkSync(join(project, "loopB"), join(project, "loopA"));
		symlinkSync(join(project, "loopA"), join(project, "loopB"));
		assert.match((await s.gate("write", { path: "loopA/x" }))!.reason, /too many symlinks/);
		assert.match((await s.gate("powershell", { command: "ls" }))!.reason, /powershell/);
	} finally {
		await s.shutdown();
		restore();
		rmSync(project, { recursive: true, force: true });
	}
});

test("bash runs on the instance whose session started, as under pi's loader, which gives each extension its own module copy", async () => {
	const other = await import("./sandbox.ts?other-instance");
	const project = tmp("sandbox-project-");
	const { runtime, wrapped } = await fake();
	other.seam.load = async () => runtime;
	delete process.env.PI_SANDBOX_ROOT;
	process.env.PI_CODING_AGENT_DIR = tmp("sandbox-agent-");
	const handlers: Record<string, any[]> = {};
	other.default({ on: (event: string, h: any) => (handlers[event] ??= []).push(h) } as any);
	const ctx = { cwd: project, hasUI: false };
	try {
		for (const h of handlers.session_start) await h({}, ctx);
		// sandboxedBash here is this test's (and compact-tools') copy, never started.
		assert.equal((await bash("echo hi", project)).exitCode, 0);
		assert.deepEqual(wrapped, ["echo hi"]);
	} finally {
		for (const h of handlers.session_shutdown) await h({}, ctx);
		delete (globalThis as any)[Symbol.for("pi-halfmoon-setup/sandbox-exec")];
		restore();
		rmSync(project, { recursive: true, force: true });
	}
});

test("a dangling link whose target has `..` after another link is resolved as the OS does, so pi's write tool cannot escape through it", async () => {
	const project = tmp("sandbox-project-");
	const outside = tmp("sandbox-outside-");
	mkdirSync(join(outside, "subdir"));
	seam.load = async () => (await fake()).runtime;
	seam.temps = () => []; // `outside` stands in for a dir outside every writable one
	delete process.env.PI_SANDBOX_ROOT;
	const s = await start(project);
	try {
		symlinkSync(join(outside, "subdir"), join(project, "pivot"));
		symlinkSync("pivot/../new.txt", join(project, "escape"));
		assert.equal(real(join(project, "escape")), join(real(outside), "new.txt"));
		const input = { path: "escape", content: "x" };
		const gate = await s.gate("write", input);
		if (!gate) await createWriteToolDefinition(project).execute("w", input, undefined, undefined, s.ctx as any);
		assert.match(gate?.reason ?? "", /outside/);
		assert.equal(existsSync(join(outside, "new.txt")), false);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("macOS: bash cannot write the dirs the runtime itself makes writable (~/.npm/_logs, ~/.claude/debug)", macOS, async () => {
	delete process.env.PI_SANDBOX_ROOT;
	const s = await start(tmp("sandbox-project-"));
	try {
		for (const dir of [join(HOME, ".npm/_logs"), join(HOME, ".claude/debug")]) {
			mkdirSync(dir, { recursive: true });
			const probe = join(dir, unique("pi-sandbox-probe"));
			try {
				assert.notEqual((await bash(`echo x > ${probe}`, s.ctx.cwd)).exitCode, 0, dir);
				assert.equal(existsSync(probe), false, dir);
			} finally {
				rmSync(probe, { force: true });
			}
		}
	} finally {
		await s.shutdown();
		restore();
	}
});

test("macOS: loaded by pi's own extension loader, the registered bash runs sandboxed", macOS, async () => {
	const project = tmp("sandbox-project-");
	const outside = join(HOME, unique(".pi-sandbox-probe"));
	const agentDir = tmp("sandbox-agent-");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SANDBOX_ROOT;
	const cwd = process.cwd();
	const ctx = { cwd: project, hasUI: false, sessionManager: { getEntries: () => [], getSessionId: () => "s", getSessionFile: () => undefined } };
	let sb: any;
	try {
		process.chdir(project); // that copy's seam anchors at process.cwd(), as in a real pi
		const { extensions, errors } = await discoverAndLoadExtensions([join(PKG, "extensions/sandbox.ts"), join(PKG, "extensions/compact-tools.ts")], project, agentDir);
		assert.deepEqual(errors, []);
		const [loaded, ct] = extensions;
		sb = loaded;
		const bashTool = ct!.tools.get("bash")!;
		const execute = (command: string) => (bashTool.definition ?? bashTool).execute("c", { command }, undefined, undefined, ctx as any) as Promise<any>;
		for (const h of sb!.handlers.get("session_start")!) await h({}, ctx as any);
		assert.match((await execute("echo ok > inside.txt && cat inside.txt")).content[0].text, /ok/);
		const denied = await execute(`echo x > ${outside}`);
		assert.equal(denied.isError, true);
		assert.equal(existsSync(outside), false);
	} finally {
		for (const h of sb?.handlers.get("session_shutdown") ?? []) await h({}, ctx as any);
		delete (globalThis as any)[Symbol.for("pi-halfmoon-setup/sandbox-exec")];
		sandbox({ on: () => {} } as any); // this file's instance runs bash again
		process.chdir(cwd);
		restore();
		if (existsSync(outside)) rmSync(outside);
	}
});

test("macOS: a real subagent pi in a repo's subdir cannot write the repo's .git/config or hooks, nor any of the repo outside its cwd", macOS, async () => {
	const repo = join(PKG, unique(".sandbox-repo")); // outside every temp dir, which stay writable
	const sub = join(repo, "packages/app");
	const script = join(tmp("sandbox-child-"), "child.mjs");
	writeFileSync(script, `
		const { default: sandbox, sandboxedBash } = await import(${JSON.stringify(join(PKG, "extensions/sandbox.ts"))});
		const handlers = {};
		sandbox({ on: (e, h) => (handlers[e] ??= []).push(h) });
		const ctx = { cwd: process.cwd(), hasUI: false };
		for (const h of handlers.session_start) await h({}, ctx);
		const out = {};
		for (const c of JSON.parse(process.argv[2])) out[c] = (await sandboxedBash.exec(c, process.cwd(), { onData: () => {}, timeout: 30 })).exitCode;
		for (const h of handlers.session_shutdown) await h({}, ctx);
		console.log(JSON.stringify(out));
	`);
	const child = (cwd: string, commands: string[]) =>
		new Promise<Record<string, number>>((done, fail) => {
			const env = { ...process.env, PI_SANDBOX_ROOT: repo, PI_CODING_AGENT_DIR: tmp("sandbox-agent-") };
			execFile(process.execPath, ["--import", join(PKG, "extensions/test-hooks.ts"), script, JSON.stringify(commands)], { cwd, env, timeout: 50000 }, (e, stdout, stderr) =>
				e ? fail(new Error(stderr || e.message)) : done(JSON.parse(stdout.trim().split("\n").at(-1)!)),
			);
		});
	try {
		mkdirSync(join(repo, ".git/hooks"), { recursive: true });
		mkdirSync(sub, { recursive: true });
		writeFileSync(join(repo, ".git/config"), "orig");
		// Setup inside try: in a sandboxed pi the .git/config write fails, and the repo must still be removed.
		const fromSub = await child(sub, ["echo x > mine.txt", "echo x >> ../../.git/config", "echo x > ../../.git/hooks/pre-commit", "echo x > ../../top.txt"]);
		assert.equal(fromSub["echo x > mine.txt"], 0);
		for (const [c, code] of Object.entries(fromSub).slice(1)) assert.notEqual(code, 0, c);
		// At the repo itself the runtime's own protections hold, while the rest is writable.
		const fromRepo = await child(repo, [
			"echo x > top.txt",
			"echo x >> .git/config",
			"echo x > .git/hooks/pre-commit",
			"echo /tmp/evil > .git/commondir",
			"echo x > .git/config.worktree",
			"mkdir -p .git/modules/m && echo x > .git/modules/m/config",
			"mkdir -p .git/worktrees/w && echo /tmp/evil > .git/worktrees/w/gitdir",
		]);
		assert.equal(fromRepo["echo x > top.txt"], 0);
		for (const [c, code] of Object.entries(fromRepo).slice(1)) assert.notEqual(code, 0, c);
		assert.equal(readFileSync(join(repo, ".git/config"), "utf8"), "orig");
		assert.equal(existsSync(join(repo, ".git/hooks/pre-commit")), false);
		for (const p of [".git/commondir", ".git/config.worktree", ".git/modules", ".git/worktrees"]) assert.equal(existsSync(join(repo, p)), false, p);
		// Started inside a protected dir, the runtime's cwd-relative names miss the real files: nothing there is writable.
		mkdirSync(join(repo, ".claude/commands"), { recursive: true });
		mkdirSync(join(repo, ".vscode"));
		for (const [cwd, commands] of [
			[".git", ["echo x >> config", "echo x > hooks/pre-commit", "echo x > new.txt"]],
			[".git/hooks", ["echo x > pre-commit"]],
			[".claude", ["echo x > commands/x.md", "mkdir -p agents && echo x > agents/x.md"]],
			[".vscode", ["echo x > settings.json"]],
		] as const) {
			for (const [c, code] of Object.entries(await child(join(repo, cwd), [...commands]))) assert.notEqual(code, 0, `${cwd}: ${c}`);
		}
		assert.equal(readFileSync(join(repo, ".git/config"), "utf8"), "orig");
		assert.equal(existsSync(join(repo, ".git/hooks/pre-commit")), false);
		assert.equal(existsSync(join(repo, ".claude/commands/x.md")), false);
		assert.equal(existsSync(join(repo, ".vscode/settings.json")), false);
	} finally {
		restore();
		rmSync(repo, { recursive: true, force: true });
	}
});

test("escalation: a success, or a failure with no denial text and no violation, runs once and asks no classifier", async () => {
	const s = await escalating();
	try {
		assert.deepEqual(await s.run("echo hi"), { exitCode: 0, out: "hi\n" });
		assert.deepEqual(await s.run("echo nope >&2; exit 2"), { exitCode: 2, out: "nope\n" });
		assert.equal(s.calls.length, 0);
		assert.equal(s.wrapped.length, 2);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("escalation: a denial rated low re-runs outside the sandbox, visibly", async () => {
	let s = await escalating();
	try {
		const { exitCode, out } = await s.run(F);
		assert.equal(exitCode, 3);
		assert.match(out, /^x: Operation not permitted\n\n\[sandbox: blocked; risk low \(a build cache\) → re-ran outside the sandbox\]\noutside\n$/);
		assert.deepEqual(s.calls[0].blocked, ["x: Operation not permitted"]);
		await s.shutdown();
		const u = fakeUI();
		s = await escalating({ ui: u.ui });
		assert.equal((await s.run(F)).exitCode, 3);
		assert.equal(u.notes.at(-1)![1], "warning");
		assert.match(u.notes.at(-1)![0], /re-ran outside the sandbox \(risk low: a build cache\): if \[ -n/);
		assert.equal(u.confirms.length, 0);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("escalation: a recorded violation with no denial text reaches the classifier; each run has its own commandId", async () => {
	const seen: (string | undefined)[] = [];
	const s = await escalating({ judge: async () => HIGH, violations: (id) => (seen.push(id), id === seen[0] ? [{ line: "deny network-outbound example.com:443 (not allowed)" }] : []) });
	try {
		assert.equal((await s.run("exit 1")).exitCode, 1);
		assert.deepEqual(s.calls[0].blocked, ["deny network-outbound example.com:443 (not allowed)"]);
		assert.equal((await s.run("exit 1")).exitCode, 1);
		assert.equal(s.calls.length, 1, "the second run inherits none of the first's violations");
		assert.equal(s.ids.length, 2);
		assert.deepEqual(seen, s.ids, "violations are looked up under each run's own commandId");
		assert.ok(s.ids.every((id) => typeof id === "string" && id.length > 0));
		assert.notEqual(s.ids[0], s.ids[1]);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("escalation: high with no UI does not re-run and tells the model to ask the user", async () => {
	const s = await escalating({ judge: async () => HIGH });
	try {
		const { exitCode, out } = await s.run(F);
		assert.equal(exitCode, 1);
		assert.doesNotMatch(out, /outside\n/);
		assert.match(out, /risk high \(writes a dotfile\): needs the user's approval to run outside the sandbox; ask the user/);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("escalation: high with a UI asks; yes re-runs, no or a rejected dialog does not", async () => {
	const u = fakeUI();
	const s = await escalating({ judge: async () => HIGH, ui: u.ui });
	try {
		u.answer = async () => true;
		const yes = await s.run(F);
		assert.equal(yes.exitCode, 3);
		assert.match(yes.out, /approved by the user → re-ran outside the sandbox\]\noutside\n/);
		assert.match(u.confirms[0]!, /\nblocked\n  x: Operation not permitted\n\nrisk high  writes a dotfile\n\nsandboxed bash writes only in\n  \/.*sandbox-project-.*\n(  .*\n)*  \(not the project's \.git\/config, .*allowed hosts only\)$/);
		for (const answer of [async () => false, () => Promise.reject(new Error("closed"))]) {
			u.answer = answer;
			const no = await s.run(F);
			assert.equal(no.exitCode, 1);
			assert.doesNotMatch(no.out, /outside\n/);
			assert.match(no.out, /the user declined running it outside the sandbox/);
		}
	} finally {
		await s.shutdown();
		restore();
	}
});

test("escalation: a classifier that throws or returns a bad shape counts as high", async () => {
	for (const [judge, reason] of [
		[async () => Promise.reject(new Error("boom")), /classifier failed: boom/],
		[async () => ({ risk: "low" }), /no valid verdict/],
		[async () => ({ risk: "low", reason: "x", extra: 1 }), /no valid verdict/],
		[async () => ({ risk: "medium", reason: "x" }), /no valid verdict/],
		[async () => "low", /no valid verdict/],
	] as const) {
		const s = await escalating({ judge });
		try {
			const { exitCode, out } = await s.run(F);
			assert.equal(exitCode, 1);
			assert.doesNotMatch(out, /outside\n/);
			assert.match(out, reason);
			assert.match(out, /ask the user/);
		} finally {
			await s.shutdown();
			restore();
		}
	}
});

test("escalation: sudo, git push and rm -r skip the classifier and always go to the user", async () => {
	const u = fakeUI();
	for (const ui of [undefined, u.ui]) {
		const s = await escalating({ ui });
		try {
			for (const [command, reason] of [[`${F}; sudo true`, /bash runs sudo/], [`${F}; rm -r x`, /rm -r/]] as const) {
				const { exitCode, out } = await s.run(command);
				assert.equal(exitCode, 1, command);
				assert.doesNotMatch(out, /outside\n/, command);
				assert.match(out, reason, command);
				assert.match(out, ui ? /declined/ : /ask the user/, command);
			}
			assert.equal(s.calls.length, 0);
		} finally {
			await s.shutdown();
			restore();
		}
	}
	assert.equal(u.confirms.length, 2);
	assert.match(u.confirms[1]!, /risk high  bash deletes recursively \(rm -r\), a fixed rule that always asks \(no classifier\)\n/);
});

test("escalation: PI_SANDBOX_ESCALATE=off leaves a denied command denied", async () => {
	const s = await escalating();
	process.env.PI_SANDBOX_ESCALATE = "off";
	try {
		assert.deepEqual(await s.run(F), { exitCode: 1, out: "x: Operation not permitted\n" });
		assert.equal(s.calls.length, 0);
		assert.equal(s.wrapped.length, 1);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("escalation: with a UI, a host the user declined while the command ran is never re-run", async () => {
	const u = fakeUI();
	const s = await escalating({ ui: u.ui });
	try {
		const ran = s.run(`sleep 0.3; ${F}`);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(await s.got.ask!({ host: "example.com", port: 443 }), false);
		const { exitCode, out } = await ran;
		assert.equal(exitCode, 1);
		assert.doesNotMatch(out, /outside\n/);
		assert.equal(s.calls.length, 0);
	} finally {
		await s.shutdown();
		restore();
	}
});

/** Resolves once `f()` holds, plus one event-loop turn. */
async function until(f: () => boolean) {
	while (!f()) await new Promise((r) => setTimeout(r, 5));
	await new Promise((r) => setImmediate(r));
}

test("host rating: low allows the host for the session, visibly, once per host; with no UI too", async () => {
	const u = fakeUI();
	let s = await escalating({ host: async () => LOW, ui: u.ui });
	try {
		assert.equal(await s.got.ask!({ host: "repo.maven.apache.org", port: 443 }), true);
		assert.deepEqual(u.notes.at(-1), ["sandbox: allowed repo.maven.apache.org for this session (risk low: a build cache)", "warning"]);
		assert.equal(await s.got.ask!({ host: "repo.maven.apache.org", port: 443 }), true);
		assert.equal(s.hostCalls.length, 1);
		assert.deepEqual(await Promise.all([s.got.ask!({ host: "dl.google.com", port: 443 }), s.got.ask!({ host: "dl.google.com", port: 443 })]), [true, true]);
		assert.equal(s.hostCalls.length, 2);
		assert.equal(u.confirms.length, 0);
		await s.shutdown();
		s = await escalating({ host: async () => LOW });
		assert.equal(await s.got.ask!({ host: "repo.maven.apache.org", port: 443 }), true);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("host rating: high, or a classifier failure, asks with the reason; with no UI it denies", async () => {
	const u = fakeUI();
	let s = await escalating({ ui: u.ui });
	try {
		u.answer = async () => true;
		assert.equal(await s.got.ask!({ host: "h1", port: 443 }), true);
		assert.match(u.confirms[0]!, /bash wants to reach h1:443\.\nrisk high: writes a dotfile\nAllow it for this session\?/);
		u.answer = async () => false;
		assert.equal(await s.got.ask!({ host: "h2", port: 443 }), false);
		u.answer = () => Promise.reject(new Error("closed"));
		assert.equal(await s.got.ask!({ host: "h3", port: 443 }), false);
		await s.shutdown();
		s = await escalating();
		assert.equal(await s.got.ask!({ host: "h1", port: 443 }), false);
		for (const [host, reason] of [[async () => Promise.reject(new Error("boom")), /classifier failed: boom/], [async () => ({ risk: "low" }), /no valid verdict/]] as const) {
			await s.shutdown();
			s = await escalating({ host });
			assert.equal(await s.got.ask!({ host: "h4", port: 443 }), false);
			await s.shutdown();
			u.answer = async () => false;
			s = await escalating({ host, ui: u.ui });
			assert.equal(await s.got.ask!({ host: "h4", port: 443 }), false);
			assert.match(u.confirms.at(-1)!, reason);
		}
		assert.equal(u.confirms.length, 5);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("host rating: PI_SANDBOX_ESCALATE=off asks with no rating, or denies with no UI", async () => {
	const u = fakeUI();
	process.env.PI_SANDBOX_ESCALATE = "off";
	let s = await escalating({ ui: u.ui, host: async () => LOW });
	try {
		u.answer = async () => true;
		assert.equal(await s.got.ask!({ host: "h1", port: 443 }), true);
		assert.equal(u.confirms[0], "bash wants to reach h1:443. Allow it for this session?");
		await s.shutdown();
		s = await escalating({ host: async () => LOW });
		assert.equal(await s.got.ask!({ host: "h1", port: 443 }), false);
		assert.equal(s.hostCalls.length, 0);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("host rating: the classifier sees up to 5 running commands, 2000 chars each", async () => {
	const s = await escalating();
	try {
		const ran = s.run("sleep 0.3; echo hi");
		await until(() => s.wrapped.length === 1);
		await s.got.ask!({ host: "h1", port: 443 });
		assert.deepEqual(s.hostCalls[0], { host: "h1", port: 443, commands: ["sleep 0.3; echo hi"], intent: "" });
		await ran;
		await s.got.ask!({ host: "h2", port: 443 });
		assert.deepEqual(s.hostCalls[1].commands, []);
		const six = Array.from({ length: 6 }, () => s.run(`sleep 0.3; : ${"x".repeat(3000)}`));
		await until(() => s.wrapped.length === 7);
		await s.got.ask!({ host: "h3", port: 443 });
		assert.equal(s.hostCalls[2].commands.length, 5);
		assert.ok(s.hostCalls[2].commands.every((c: string) => c.length === 2000));
		await Promise.all(six);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("host rating: with no UI, a host rated high while the command ran, or while the re-run classifier was pending, stops the re-run", async () => {
	let s = await escalating();
	try {
		const ran = s.run(`sleep 0.3; ${F}`);
		await until(() => s.wrapped.length === 1);
		assert.equal(await s.got.ask!({ host: "h1", port: 443 }), false);
		const { exitCode, out } = await ran;
		assert.equal(exitCode, 1);
		assert.doesNotMatch(out, /outside\n/);
		assert.equal(s.calls.length, 0);
		assert.match(out, /a network host was denied .*ask the user to allow it/);
		await s.shutdown();
		let release!: () => void;
		const pending = new Promise<void>((r) => (release = r));
		s = await escalating({ judge: async () => (await pending, LOW) });
		const again = s.run(F);
		await until(() => s.calls.length === 1);
		assert.equal(await s.got.ask!({ host: "h2", port: 443 }), false);
		release();
		const late = await again;
		assert.equal(late.exitCode, 1);
		assert.doesNotMatch(late.out, /outside|re-ran/);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("host rating: a throwing notify on a low verdict denies instead of rejecting", async () => {
	const u = fakeUI();
	const s = await escalating({ host: async () => LOW, ui: u.ui });
	u.ui.notify = () => {
		throw new Error("no notify");
	};
	try {
		assert.equal(await s.got.ask!({ host: "h1", port: 443 }), false);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("escalation: aborting while the classifier is pending does not re-run", async () => {
	const ac = new AbortController();
	const s = await escalating({ judge: async () => (ac.abort(), LOW) });
	try {
		let out = "";
		const { exitCode } = await sandboxedBash.exec(F, s.ctx.cwd, { onData: (d) => (out += d), signal: ac.signal, timeout: 30 });
		assert.equal(exitCode, 1);
		assert.equal(s.calls.length, 1);
		assert.doesNotMatch(out, /outside|re-ran/);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("verdict() takes exactly one valid verdict call from a finished response, else high", () => {
	const call = (args: unknown, more: object = {}) => ({ type: "toolCall", id: "1", name: "verdict", arguments: args, ...more });
	const msg = (stopReason: string | undefined, ...content: unknown[]) => ({ role: "assistant", content, stopReason }) as any;
	const ok = { risk: "low", reason: "cache" };
	assert.deepEqual(verdict(msg("toolUse", call(ok))), ok);
	assert.deepEqual(verdict(msg("stop", { type: "text", text: "hi" }, call({ risk: "high", reason: "r" }))), { risk: "high", reason: "r" });
	const bad = [
		msg("toolUse"),
		msg("toolUse", { type: "text", text: '{"risk":"low","reason":"x"}' }),
		msg("toolUse", call(ok, { name: "other" })),
		msg("toolUse", call({ risk: "medium", reason: "x" })),
		msg("toolUse", call({ risk: "low" })),
		msg("toolUse", call({ ...ok, extra: 1 })),
		msg("toolUse", call({ risk: "low", reason: "x".repeat(301) })),
		msg("toolUse", call({ risk: "low", reason: 1 })),
		msg("toolUse", call(ok, { argumentsError: "not JSON" })),
		msg("toolUse", call(ok), call(ok)),
		...["length", "pending", "deferred", "error", "aborted", undefined].map((r) => msg(r, call(ok))),
	];
	for (const m of bad) assert.deepEqual(verdict(m), { risk: "high", reason: "classifier gave no valid verdict" }, JSON.stringify(m));
});

test("escalation: the default classifier asks openai/gpt-6.1-terra once, and any failure is high", async () => {
	const model = { provider: "openai", id: "gpt-6.1-terra" };
	const reg = { found: true as boolean, auth: true, reply: async (): Promise<any> => ({}), requests: [] as any[] };
	const modelRegistry = {
		find: (p: string, id: string) => (reg.found && p === "openai" && id === "gpt-6.1-terra" ? model : undefined),
		hasConfiguredAuth: (m: unknown) => m === model && reg.auth,
		complete: async (m: unknown, context: any, options: any) => (reg.requests.push({ m, context, options }), reg.reply()),
	};
	const entries = [
		{ type: "message", message: { role: "user", content: "an earlier request" } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "build the app" }] } },
		{ type: "message", message: { role: "assistant", content: [] } },
	];
	const sessionManager = { getEntries: () => entries, getSessionId: () => "s", getSessionFile: () => undefined };
	const s = await escalating({ judge: null, host: null, extra: { modelRegistry, sessionManager } });
	const call = (args: unknown, stopReason = "toolUse") => async () => ({ role: "assistant", stopReason, content: [{ type: "toolCall", id: "1", name: "verdict", arguments: args }] });
	try {
		const denied = async (reason: RegExp) => {
			const { exitCode, out } = await s.run(F);
			assert.equal(exitCode, 1);
			assert.match(out, reason);
			assert.doesNotMatch(out, /outside\n/);
		};
		reg.found = false;
		await denied(/classifier failed: .*not in the model registry/);
		reg.found = true;
		reg.auth = false;
		await denied(/classifier failed: no OpenAI auth/);
		reg.auth = true;
		reg.reply = () => Promise.reject(new Error("529 overloaded"));
		await denied(/classifier failed: 529 overloaded/);
		reg.reply = call({ risk: "low", reason: "x" }, "length");
		await denied(/no valid verdict/);
		reg.reply = call({ risk: "low", reason: "gradle cache" });
		const { exitCode, out } = await s.run(F);
		assert.equal(exitCode, 3);
		assert.match(out, /risk low \(gradle cache\) → re-ran/);
		const { m, context, options } = reg.requests.at(-1);
		assert.equal(m, model);
		assert.match(context.systemPrompt, /WITHOUT ANY SANDBOX/);
		assert.equal(context.tools[0].name, "verdict");
		assert.equal(options.cacheRetention, "none");
		assert.equal(options.reasoningEffort, "low");
		assert.ok(options.signal instanceof AbortSignal);
		assert.equal(context.messages.length, 1);
		const user = context.messages[0];
		assert.equal(user.role, "user");
		assert.equal(typeof user.timestamp, "number");
		const input = JSON.parse(user.content);
		assert.equal(input.command, F);
		assert.deepEqual(input.blocked, ["x: Operation not permitted"]);
		assert.equal(input.intent, "build the app");
		assert.equal(reg.requests.length, 3, "one request per classified run");
		reg.reply = call({ risk: "low", reason: "Maven Central" });
		assert.equal(await s.got.ask!({ host: "repo.maven.apache.org", port: 443 }), true);
		const host = reg.requests.at(-1).context;
		assert.match(host.systemPrompt, /THIS ONE HOST/);
		assert.equal(host.tools[0].name, "verdict");
		assert.deepEqual(JSON.parse(host.messages[0].content), { host: "repo.maven.apache.org", port: 443, commands: [], intent: "build the app" });
		reg.found = false;
		assert.equal(await s.got.ask!({ host: "other.example", port: 443 }), false);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("scanner: denial text split across chunks or left unterminated is found; output is forwarded unchanged; long lines stay bounded", async () => {
	const a = scanner();
	a.feed(Buffer.from("cp: a: Operation not "));
	a.feed(Buffer.from("permitted\nfine\n"));
	assert.deepEqual(a.lines, ["cp: a: Operation not permitted"]);
	const b = scanner();
	b.feed(Buffer.from("Error: listen EP"));
	b.feed(Buffer.from("ERM"));
	assert.deepEqual(b.lines, []);
	b.end();
	assert.deepEqual(b.lines, ["Error: listen EPERM"]);
	const c = scanner();
	for (let i = 0; i < 500; i++) c.feed(Buffer.alloc(10_000, "x"));
	assert.ok(c.tail.length <= 1064, `tail ${c.tail.length}`);
	c.feed(Buffer.from("Read-only file system"));
	c.end();
	assert.equal(c.lines.length, 1);
	assert.ok(c.lines[0]!.length <= 300 && c.lines[0]!.includes("Read-only file system"));
	const d = scanner();
	for (let i = 0; i < 30; i++) d.feed(Buffer.from(`${i}: EROFS\n`));
	assert.equal(d.lines.length, 20);

	const s = await escalating();
	process.env.PI_SANDBOX_ESCALATE = "off";
	try {
		const chunks: Buffer[] = [];
		await sandboxedBash.exec("printf '\\377\\376 a\\nb'", s.ctx.cwd, { onData: (x) => chunks.push(x), timeout: 30 });
		assert.deepEqual(Buffer.concat(chunks), Buffer.from([0xff, 0xfe, 0x20, 0x61, 0x0a, 0x62]));
	} finally {
		await s.shutdown();
		restore();
	}
});

test("macOS: a real sandbox denial rated low re-runs unsandboxed; rated high with no UI it does not", macOS, async () => {
	const probe = join(HOME, unique(".pi-sandbox-probe"));
	delete process.env.PI_SANDBOX_ROOT;
	const s = await start(tmp("sandbox-project-"));
	try {
		seam.judge = async () => HIGH;
		const high = await bash(`echo x > ${probe}`, s.ctx.cwd);
		assert.notEqual(high.exitCode, 0);
		assert.match(high.out, /ask the user/);
		assert.equal(existsSync(probe), false);
		seam.judge = async () => LOW;
		const low = await bash(`echo x > ${probe}`, s.ctx.cwd);
		assert.equal(low.exitCode, 0);
		assert.match(low.out, /Operation not permitted[\s\S]*risk low \(a build cache\) → re-ran outside the sandbox/);
		assert.equal(existsSync(probe), true);
	} finally {
		await s.shutdown();
		restore();
		if (existsSync(probe)) rmSync(probe); // only ours: the name is unique
	}
});

test("macOS: a Node child denied a localhost bind is detected; low re-runs it, high with no UI does not", macOS, async () => {
	const listen = `${JSON.stringify(process.execPath)} -e 'require("net").createServer().on("error", (e) => { console.error(e.message); process.exit(1); }).listen(0, "127.0.0.1", function () { this.close(); })'`;
	delete process.env.PI_SANDBOX_ROOT;
	const s = await start(tmp("sandbox-project-"));
	try {
		seam.judge = async () => HIGH;
		const high = await bash(listen, s.ctx.cwd);
		assert.notEqual(high.exitCode, 0);
		assert.match(high.out, /EPERM[\s\S]*ask the user/);
		const blocked: string[][] = [];
		seam.judge = async (input: any) => (blocked.push(input.blocked), LOW);
		const low = await bash(listen, s.ctx.cwd);
		assert.equal(low.exitCode, 0, low.out);
		assert.match(blocked[0]![0]!, /EPERM/);
		assert.match(low.out, /re-ran outside the sandbox/);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("Linux: a repo gets a real .git/commondir naming itself before any command, so the runtime binds it read-only instead of a /dev/null stand-in git cannot read", async () => {
	const project = tmp("sandbox-project-");
	await new Promise((done) => execFile("git", ["init", "-q"], { cwd: project }, done));
	const cd = join(real(project), ".git", "commondir");
	const git = () => new Promise<string>((done) => execFile("git", ["status", "--porcelain"], { cwd: project }, (e) => done(e ? e.message : "ok")));
	seam.load = async () => (await fake()).runtime;
	delete process.env.PI_SANDBOX_ROOT;
	try {
		seam.platform = () => "darwin";
		let s = await start(project);
		await s.shutdown();
		assert.equal(existsSync(cd), false, "macOS denies it absent; nothing is written");
		assert.ok(policy(project).filesystem.denyWrite.includes(cd));
		seam.platform = () => "linux";
		s = await start(project);
		try {
			assert.equal(readFileSync(cd, "utf8"), ".\n", "there before any command runs: no window where a redirect can be written");
			assert.ok(policy(project).filesystem.denyWrite.includes(cd));
			assert.equal(await git(), "ok", "git reads it as no redirect");
		} finally {
			await s.shutdown();
		}
		writeFileSync(cd, "../x"); // one already there is left as it is (and denied)
		s = await start(project);
		await s.shutdown();
		assert.equal(readFileSync(cd, "utf8"), "../x");
		// Not a repo: nothing written.
		const plain = tmp("sandbox-project-");
		s = await start(plain);
		await s.shutdown();
		assert.equal(existsSync(join(plain, ".git")), false);
	} finally {
		restore();
	}
});
