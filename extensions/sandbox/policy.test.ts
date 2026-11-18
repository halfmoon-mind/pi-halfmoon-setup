// Run: node --import ./extensions/test-hooks.ts --test --test-timeout=60000 extensions/sandbox/policy.test.ts
// From a trusted terminal or CI: the macOS tests start the real sandbox, which cannot nest in another.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWriteToolDefinition, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import sandbox, { blocked, sandboxedBash } from "./index.ts";
import { merge, policy, real, risky, seam } from "./policy.ts";
import { bash, fake, fakeUI, HIGH, HOME, macOS, PKG, restore, start, temps, tmp, unique } from "./test-helpers.ts";

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
	assert.throws(() => merge(policy(root), { allowAppleEvents: true }, root), /unsupported section/);
	assert.equal(merge(policy(root), { enableWeakerNetworkIsolation: true }, root).enableWeakerNetworkIsolation, true);
	assert.throws(() => merge(policy(root), { enableWeakerNetworkIsolation: "yes" }, root), /true or false/);
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
		// /sandbox on starts the runtime it never started; no UI needed.
		await s.commands.sandbox.handler("on", { ...s.ctx, ui: fakeUI().ui });
		assert.equal(loaded, true);
		assert.equal(process.env.PI_SANDBOX, undefined);
		assert.match((await s.gate("read", { path: "~/.ssh/id_rsa" }))!.reason, /credential/);
	} finally {
		await s.shutdown();
		restore();
		sandbox({ on: () => {}, registerCommand: () => {} } as any); // back on for the next tests
	}
});

test("/sandbox off needs a UI and a confirm; /sandbox on turns the same runtime back on", async () => {
	const project = tmp("sandbox-project-");
	let loads = 0;
	let inits = 0;
	const f = await fake(async () => void inits++);
	seam.load = async () => (loads++, f.runtime);
	delete process.env.PI_SANDBOX_ROOT;
	const u = fakeUI();
	const s = await start(project, { ui: u.ui });
	const cmd = (args: string, ctx: any = s.ctx) => s.commands.sandbox.handler(args, ctx);
	const key = { path: "~/.ssh/id_rsa" };
	try {
		await cmd("off", { ...s.ctx, hasUI: false });
		await cmd("off"); // declined
		assert.equal(u.confirms.length, 1, "no confirm without a UI");
		assert.equal(process.env.PI_SANDBOX, undefined);
		assert.match((await s.gate("read", key))!.reason, /credential/);
		assert.equal((await bash("echo [$IN_SANDBOX]", project)).out, "[1]\n");

		u.answer = async () => true;
		await cmd("off");
		assert.equal(process.env.PI_SANDBOX, "off");
		assert.equal(await s.gate("read", key), undefined);
		assert.equal((await bash("echo [$IN_SANDBOX]", project)).out, "[]\n");
		await cmd("");
		assert.match(u.notes.at(-1)![0], /^sandbox off/);

		await cmd("on");
		assert.equal(process.env.PI_SANDBOX, undefined);
		assert.match((await s.gate("read", key))!.reason, /credential/);
		assert.equal((await bash("echo [$IN_SANDBOX]", project)).out, "[1]\n");
		assert.deepEqual([loads, inits], [1, 1], "the runtime is reused, not loaded or initialized again");
		assert.equal(u.notes.at(-1)![0], "sandbox on");
	} finally {
		await s.shutdown();
		restore();
	}
});

test("/sandbox on retries a failed startup", async () => {
	const project = tmp("sandbox-project-");
	let fail = true;
	const f = await fake(async () => {
		if (fail) throw new Error("ripgrep (rg) not found");
	});
	seam.load = async () => f.runtime;
	delete process.env.PI_SANDBOX_ROOT;
	const u = fakeUI();
	const s = await start(project, { ui: u.ui });
	try {
		assert.match((await s.gate("read", { path: "a.txt" }))!.reason, /ripgrep/);
		await s.commands.sandbox.handler("", s.ctx);
		assert.match(u.notes.at(-1)![0], /could not start.*ripgrep/);
		fail = false;
		await s.commands.sandbox.handler("on", s.ctx);
		assert.equal(await s.gate("read", { path: "a.txt" }), undefined);
		assert.equal(u.notes.at(-1)![0], "sandbox on");
	} finally {
		await s.shutdown();
		restore();
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
	const other = await import("./index.ts?other-instance");
	const project = tmp("sandbox-project-");
	const { runtime, wrapped } = await fake();
	seam.load = async () => runtime;
	delete process.env.PI_SANDBOX_ROOT;
	process.env.PI_CODING_AGENT_DIR = tmp("sandbox-agent-");
	const handlers: Record<string, any[]> = {};
	other.default({ on: (event: string, h: any) => (handlers[event] ??= []).push(h), registerCommand: () => {} } as any);
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
		const { extensions, errors } = await discoverAndLoadExtensions([join(PKG, "extensions/sandbox/index.ts"), join(PKG, "extensions/compact-tools.ts")], project, agentDir);
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
		sandbox({ on: () => {}, registerCommand: () => {} } as any); // this file's instance runs bash again
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
		const { default: sandbox, sandboxedBash } = await import(${JSON.stringify(join(PKG, "extensions/sandbox/index.ts"))});
		const handlers = {};
		sandbox({ on: (e, h) => (handlers[e] ??= []).push(h), registerCommand: () => {} });
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
		// A linked worktree: its .git is a pointer file, which the runtime leaves writable on macOS.
		const wt = join(repo, "wt");
		mkdirSync(wt);
		writeFileSync(join(wt, ".git"), "gitdir: /orig\n");
		const fromWorktree = await child(wt, ["echo x > top.txt", "echo 'gitdir: /tmp/evil' > .git"]);
		assert.equal(fromWorktree["echo x > top.txt"], 0);
		assert.notEqual(fromWorktree["echo 'gitdir: /tmp/evil' > .git"], 0);
		assert.equal(readFileSync(join(wt, ".git"), "utf8"), "gitdir: /orig\n");
	} finally {
		restore();
		rmSync(repo, { recursive: true, force: true });
	}
});

test("macOS: a linked worktree's .git pointer file is write-denied; Linux's runtime denies it itself", () => {
	const wt = tmp("sandbox-worktree-");
	writeFileSync(join(wt, ".git"), "gitdir: /orig\n");
	const dotGit = join(real(wt), ".git");
	try {
		seam.platform = () => "darwin";
		assert.ok(policy(wt).filesystem.denyWrite.includes(dotGit));
		seam.platform = () => "linux";
		assert.ok(!policy(wt).filesystem.denyWrite.includes(dotGit));
		seam.platform = () => "darwin";
		const plain = tmp("sandbox-project-");
		assert.ok(!policy(plain).filesystem.denyWrite.includes(join(real(plain), ".git")), "no .git: nothing denied, so git init still works");
	} finally {
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
