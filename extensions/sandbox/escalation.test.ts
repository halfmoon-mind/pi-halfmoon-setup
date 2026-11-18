// Run: node --import ./extensions/test-hooks.ts --test --test-timeout=60000 extensions/sandbox/escalation.test.ts
// From a trusted terminal or CI: the macOS tests start the real sandbox, which cannot nest in another.
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scanner } from "./denials.ts";
import { sandboxedBash, verdict } from "./index.ts";
import { seam } from "./policy.ts";
import { bash, escalating, F, fakeUI, HIGH, HOME, LOW, macOS, restore, start, tmp, unique } from "./test-helpers.ts";

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
	assert.ok(c.lines[0]!.length <= 600 && c.lines[0]!.includes("Read-only file system"));
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
