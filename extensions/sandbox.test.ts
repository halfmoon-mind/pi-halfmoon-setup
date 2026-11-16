// Run: node --import ./extensions/test-hooks.ts --test --test-timeout=60000 extensions/sandbox.test.ts
// From a trusted terminal or CI: the macOS tests start the real sandbox, which cannot nest in another.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createWriteToolDefinition, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import compactTools from "./compact-tools.ts";
import sandbox, { blocked, merge, policy, real, risky, sandboxedBash, seam } from "./sandbox.ts";

const PKG = real(dirname(dirname(fileURLToPath(import.meta.url))));
const HOME = homedir();
const load = seam.load;
const temps = seam.temps;
const macOS = { skip: process.platform !== "darwin" && "the real sandbox runs on macOS here" };
const unique = (name: string) => `${name}-${randomBytes(6).toString("hex")}`;
// Every fixture dir, removed once all tests (and their runtime shutdowns) are done.
const made: string[] = [];
const tmp = (prefix: string) => (made.push(mkdtempSync(join(tmpdir(), prefix))), made.at(-1)!);
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

// A fake runtime for policy tests: the real config schema, a SandboxManager that starts nothing.
async function fake(initialize = async () => {}) {
	const actual = await load();
	const wrapped: string[] = [];
	const SandboxManager = { reset: async () => {}, initialize, cleanupAfterCommand: () => {}, wrapWithSandbox: async (c: string) => (wrapped.push(c), c) };
	return { runtime: { ...actual, SandboxManager } as any, wrapped };
}

/** The sandbox (and compact-tools, for its bash) loaded into a fake pi, with a session started in `cwd`. */
async function start(cwd: string, { ui, files = {} }: { ui?: any; files?: Record<string, string> } = {}) {
	process.env.PI_CODING_AGENT_DIR = tmp("sandbox-agent-");
	for (const [name, text] of Object.entries(files)) writeFileSync(join(process.env.PI_CODING_AGENT_DIR, name), text);
	const handlers: Record<string, any[]> = {};
	const tools: Record<string, any> = {};
	const pi = { on: (event: string, h: any) => (handlers[event] ??= []).push(h), registerTool: (t: any) => (tools[t.name] = t) };
	sandbox(pi as any);
	compactTools(pi as any);
	const ctx = { cwd, hasUI: !!ui, ui, mode: ui ? "tui" : "print", sessionManager: { getEntries: () => [], getSessionId: () => "s", getSessionFile: () => undefined } };
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
	for (const k of ["PI_SANDBOX", "PI_SANDBOX_ROOT", "PI_CODING_AGENT_DIR"]) env[k] === undefined ? delete process.env[k] : (process.env[k] = env[k]);
	seam.load = load;
	seam.temps = temps;
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

test("a pi with no UI keeps the root it inherited, so a subagent cwd outside it is not writable; temp dirs stay writable", async () => {
	const a = tmp("sandbox-root-a-");
	const b = tmp("sandbox-root-b-");
	seam.load = async () => (await fake()).runtime;
	seam.temps = () => []; // a and b stand in for dirs outside every temp dir
	process.env.PI_SANDBOX_ROOT = a;
	try {
		let s = await start(b);
		assert.equal(process.env.PI_SANDBOX_ROOT, a);
		assert.equal(blocked("write", { path: "x" }, a), undefined);
		assert.match(blocked("write", { path: "x" }, b)!, /outside/);
		assert.match(blocked("write", { path: join(b, "x") }, a)!, /outside/);
		await s.shutdown();
		seam.temps = temps;
		s = await start(b);
		assert.equal(blocked("write", { path: join(tmpdir(), "x") }, b), undefined);
		await s.shutdown();
		// A pi with a UI is the first pi: its cwd is the root, handed to its children.
		s = await start(b, { ui: { confirm: async () => true, notify: () => {} } });
		assert.equal(process.env.PI_SANDBOX_ROOT, b);
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
	const { extensions, errors } = await discoverAndLoadExtensions([join(PKG, "extensions/sandbox.ts"), join(PKG, "extensions/compact-tools.ts")], project, agentDir);
	assert.deepEqual(errors, []);
	const [sb, ct] = extensions;
	const ctx = { cwd: project, hasUI: false, sessionManager: { getEntries: () => [], getSessionId: () => "s", getSessionFile: () => undefined } };
	const bashTool = ct!.tools.get("bash")!;
	const execute = (command: string) => (bashTool.definition ?? bashTool).execute("c", { command }, undefined, undefined, ctx as any) as Promise<any>;
	try {
		for (const h of sb!.handlers.get("session_start")!) await h({}, ctx as any);
		assert.match((await execute("echo ok > inside.txt && cat inside.txt")).content[0].text, /ok/);
		const denied = await execute(`echo x > ${outside}`);
		assert.equal(denied.isError, true);
		assert.equal(existsSync(outside), false);
	} finally {
		for (const h of sb!.handlers.get("session_shutdown") ?? []) await h({}, ctx as any);
		delete (globalThis as any)[Symbol.for("pi-halfmoon-setup/sandbox-exec")];
		sandbox({ on: () => {} } as any); // this file's instance runs bash again
		restore();
		if (existsSync(outside)) rmSync(outside);
	}
});
