// Run: node --import ./extensions/test-hooks.ts --test --test-timeout=60000 extensions/sandbox/offer.test.ts
// From a trusted terminal or CI: the macOS tests start the real sandbox, which cannot nest in another.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { offer, opening, scanner } from "./denials.ts";
import { sandboxedBash } from "./index.ts";
import { real, seam } from "./policy.ts";
import { bash, escalating, F, fakeUI, G, HIGH, HOME, LOW, macOS, made, restore, start, tmp, unique, homeDir } from "./test-helpers.ts";

const FLUTTER = ["fvm", ".pub-cache", ".dart-tool", ".dartServer", ".flutter", ".flutter-devtools", ".config/flutter", "Library/Caches/flutter_engine"];
const SOCKET = "SocketException: Failed to create server socket (OS Error: Operation not permitted, errno = 1), address = 127.0.0.1, port = 0";
const LISTEN = "Error: listen EPERM: operation not permitted 127.0.0.1:3000";
const UNIXSOCK = "Error: listen EPERM: operation not permitted /tmp/x.sock";
const CERT = "HandshakeException: Handshake error in client (OS Error: CERTIFICATE_VERIFY_FAILED: application verification failure(handshake.cc:297))";
// Prints `line` (denied in the fake sandbox) until $v is `true`, like G; exit 3 outside it.
const N = (v: string, line: string) => `if [ "$${v}" = true ]; then echo ok; exit 0; fi; echo '${line}' >&2; if [ -n "$IN_SANDBOX" ]; then exit 1; fi; echo outside; exit 3`;

test("offer: a blocked path outside the writable dirs proposes its Flutter/Dart bundle or its one tool dir, never a broad, config or credential dir", () => {
	const home = tmp("sandbox-home-");
	const H = real(home);
	const project = join(H, "proj");
	mkdirSync(project);
	const agent = tmp("sandbox-agent-");
	process.env.PI_CODING_AGENT_DIR = agent;
	seam.home = () => home;
	const P = (fs: Record<string, string[]> = {}): any => ({ network: {}, filesystem: { allowWrite: [project], denyWrite: [join(H, ".npm/_logs")], denyRead: [join(H, ".ssh")], allowRead: [], ...fs } });
	const dirs = (line: string, p = P()) => offer([line], p)?.dirs;
	const bare = (path: string) => `bash: ${path}: Operation not permitted`;
	const at = (...ds: string[]) => ds.map((d) => join(H, d));
	try {
		const fvm = `bash: ${H}/fvm/versions/3.35.7/bin/internal/update_engine_version.sh: line 74: ${H}/fvm/versions/3.35.7/bin/cache/engine.stamp: Operation not permitted`;
		assert.deepEqual(offer([fvm], P()), { line: `${H}/fvm/versions/3.35.7/bin/cache/engine.stamp`, dirs: at(...FLUTTER), ...(seam.platform() === "darwin" ? { bind: true, trust: true } : {}) });
		const dart = `FileSystemException: Cannot open file, path = '${H}/.dart-tool/dart-flutter-telemetry-session.json' (OS Error: Operation not permitted, errno = 1)`;
		assert.deepEqual(dirs(dart), at(...FLUTTER));
		assert.deepEqual(dirs(dart, P({ allowWrite: [project, join(H, "fvm")] })), at(...FLUTTER.slice(1)));
		assert.deepEqual(dirs(`Error: EPERM: operation not permitted, open '${H}/.gradle/caches/x'`), at(".gradle"));
		assert.deepEqual(dirs(`touch: cannot touch '${H}/.cargo/x': Read-only file system`), at(".cargo"));
		assert.deepEqual(dirs(bare(`${H}/Library/Caches/foo/bar`)), at("Library/Caches/foo"));
		assert.deepEqual(dirs(bare(`${H}/Library/Application Support/Foo/x`)), at("Library/Application Support/Foo"));
		assert.deepEqual(dirs(bare(`${H}/.npm/_cacache/x`)), at(".npm"), "a denyWrite inside the dir stays denied");
		const sc = scanner();
		sc.feed(Buffer.from(`${"x".repeat(350)} ${bare(`${H}/.gradle/y`)}\n`));
		assert.deepEqual(offer(sc.lines, P())?.dirs, at(".gradle"), "a long prefix before the path survives the scanner");
		const none = [
			bare(H),
			...[".zshrc", ".ssh/x", ".pi/agent/x", ".config/git/config", ".local/bin/x", ".claude/x", "Library/LaunchAgents/x.plist", ".npm/_logs/x", "a[1]/x", ".gradle\x1b/x"].map((p) => bare(`${H}/${p}`)),
			bare("/etc/hosts"),
			bare(join(project, "x")),
			"x: Operation not permitted",
		];
		for (const l of none) assert.equal(offer([l], P()), undefined, l);

		// Forged children of files and of .git propose nothing.
		writeFileSync(join(H, "notes"), "x");
		for (const p of [".zshrc/fake", ".bashrc/fake", ".gitconfig/fake", ".git/objects/fake", "notes/fake"]) assert.equal(offer([bare(`${H}/${p}`)], P()), undefined, p);
		// Symlinked bundle members are dropped, wherever they point.
		const outside = tmp("sandbox-outside-");
		mkdirSync(join(H, ".pub-cache"));
		mkdirSync(join(H, ".ssh"));
		symlinkSync(outside, join(H, "fvm"));
		symlinkSync(join(H, ".ssh"), join(H, ".flutter"));
		symlinkSync(agent, join(H, ".dartServer"));
		symlinkSync(join(H, ".flutter-devtools"), join(H, ".flutter-devtools")); // a loop drops only itself
		const linked = dirs(`Error: EPERM: operation not permitted, open '${H}/.pub-cache/x'`)!;
		assert.ok(linked.includes(join(H, ".pub-cache")));
		for (const d of [join(H, "fvm"), real(outside), join(H, ".flutter"), join(H, ".ssh"), join(H, ".dartServer"), join(H, ".flutter-devtools"), real(agent)]) assert.ok(!linked.includes(d), d);
		// A canonical target with a glob char is refused.
		mkdirSync(join(H, "we[ird"));
		symlinkSync(join(H, "we[ird"), join(H, ".gradle"));
		assert.equal(offer([bare(`${H}/.gradle/x`)], P()), undefined);
		// Read-denied regions: no dir under one, no bundle member under one.
		assert.equal(offer([bare(`${H}/Library/Caches/foo/x`)], P({ denyRead: [join(H, "Library")] })), undefined);
		assert.ok(!dirs(dart, P({ denyRead: [join(H, "Library/Caches")] }))!.includes(join(H, "Library/Caches/flutter_engine")));
	} finally {
		restore();
	}
});

test("allow dirs: with a UI, a write blocked outside the writable dirs offers its dir; session allows it live and re-runs sandboxed", async () => {
	const u = fakeUI();
	u.pick = (o) => o[0];
	const s = await escalating({ ui: u.ui });
	const D = homeDir();
	try {
		const { exitCode, out } = await s.run(G(D));
		assert.equal(exitCode, 0);
		assert.ok(out.endsWith(`[sandbox: blocked; allowed writes to ~/${basename(D)} for this session → re-ran in the sandbox]\nok\n`), out);
		assert.equal(s.calls.length, 0);
		assert.equal(s.updates.length, 1);
		assert.ok(s.updates[0].filesystem.allowWrite.includes(D));
		assert.ok(u.selects[0]!.includes(G(D).slice(0, 200)));
		assert.ok(u.selects[0]!.includes(`${D}/cache/x`));
		assert.match(u.selects[0]!, /outside the sandbox/);
		assert.equal(existsSync(join(s.agentDir, "sandbox.json")), false);
		assert.equal(await s.gate("write", { path: join(D, "f") }), undefined, "pi's write tool follows");
		assert.deepEqual(await s.run(G(D)), { exitCode: 0, out: "ok\n" });
		assert.equal(u.selects.length, 1);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("allow dirs: on Linux, where the runtime mounts only existing write roots, a missing allowed dir is made first", async () => {
	const u = fakeUI();
	u.pick = (o) => o[0];
	seam.platform = () => "linux";
	const s = await escalating({ ui: u.ui });
	const D = homeDir();
	made.push(D);
	try {
		assert.equal(existsSync(D), false);
		assert.equal((await s.run(G(D))).exitCode, 0);
		assert.ok(existsSync(D));
	} finally {
		await s.shutdown();
		restore();
	}
});

test("allow dirs: always appends to sandbox.json; a malformed file stays as it is and the dir is allowed for the session only", async () => {
	const u = fakeUI();
	u.pick = (o) => o[1];
	const s = await escalating({ ui: u.ui });
	const file = join(s.agentDir, "sandbox.json");
	try {
		writeFileSync(file, '{"network":{"allowedDomains":["example.org"]}}');
		const D = homeDir();
		const r = await s.run(G(D));
		assert.equal(r.exitCode, 0);
		assert.match(r.out, /and saved them to sandbox\.json → re-ran in the sandbox\]\nok\n$/);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { network: { allowedDomains: ["example.org"] }, filesystem: { allowWrite: [`~/${basename(D)}`] } });
		writeFileSync(file, '{"filesystem": []}');
		const again = await s.run(G(homeDir()));
		assert.equal(readFileSync(file, "utf8"), '{"filesystem": []}');
		assert.equal(u.notes.at(-1)![1], "error");
		assert.match(u.notes.at(-1)![0], /for this session only/);
		assert.match(again.out, /ok\n$/);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("allow dirs: No or a dismissed dialog goes on to escalation unchanged", async () => {
	const u = fakeUI();
	const s = await escalating({ ui: u.ui });
	try {
		for (const pick of [() => "No", () => undefined]) {
			u.pick = pick;
			const { exitCode, out } = await s.run(G(homeDir()));
			assert.equal(exitCode, 3);
			assert.match(out, /re-ran outside the sandbox/);
		}
		assert.equal(u.selects.length, 2);
		assert.equal(s.updates.length, 0);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("allow dirs: each re-run may hit another dir, which is offered next", async () => {
	const u = fakeUI();
	u.pick = (o) => o[0];
	const s = await escalating({ ui: u.ui });
	const n = join(tmp("sandbox-count-"), "n");
	const base = homeDir();
	made.push(...[0, 1, 2].map((i) => `${base}-${i}`)); // allow() makes them on Linux
	try {
		const cmd = `n=$(cat ${n} 2>/dev/null || echo 0); echo $((n + 1)) > ${n}; if [ "$n" = 3 ]; then echo ok; exit 0; fi; echo "bash: line 1: ${base}-$n/a: Operation not permitted" >&2; exit 1`;
		const { exitCode, out } = await s.run(cmd);
		assert.equal(exitCode, 0, out);
		assert.equal(u.selects.length, 3);
		assert.equal(s.calls.length, 0);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("allow dirs: with no UI, a high-rated command's message carries the sandbox.json to paste", async () => {
	const s = await escalating({ judge: async () => HIGH });
	try {
		const { exitCode, out } = await s.run(G(homeDir()));
		assert.equal(exitCode, 1);
		assert.match(out, /save this as .*sandbox\.json and restart pi: \{"filesystem":\{"allowWrite":\["~\/\.pi-sandbox-test-/);
		assert.equal(s.updates.length, 0);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("allow dirs: PI_SANDBOX_ESCALATE=off offers nothing", async () => {
	const u = fakeUI();
	u.pick = (o) => o[0];
	const s = await escalating({ ui: u.ui });
	process.env.PI_SANDBOX_ESCALATE = "off";
	try {
		assert.equal((await s.run(G(homeDir()))).exitCode, 1);
		assert.equal(u.selects.length, 0);
		assert.equal(s.offerCalls.length, 0);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("allow: after a success (`… | cat` hides the failure) an approval widens the policy and does not re-run; localhost too", async () => {
	const u = fakeUI();
	u.pick = (o) => o[0];
	seam.platform = () => "darwin"; // localhost is offered on macOS only
	const s = await escalating({ ui: u.ui });
	const n = join(tmp("sandbox-count-"), "n");
	const D = homeDir();
	try {
		for (const cmd of [G(D), N("BIND", LISTEN)]) {
			const { exitCode, out } = await s.run(`echo x >> ${n}; (${cmd}) 2>&1 | cat`);
			assert.equal(exitCode, 0);
			assert.ok(out.endsWith("; not re-run, since it exited 0: run it again if it needs that]\n"), out);
		}
		assert.equal(readFileSync(n, "utf8"), "x\nx\n", "one run each");
		assert.equal(s.updates.length, 2);
		assert.ok(s.updates[0].filesystem.allowWrite.includes(D));
		assert.equal(s.updates[1].network.allowLocalBinding, true);
		assert.equal(s.calls.length, 0);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("allow dirs: a success with No or a dismissed dialog returns the first run, with no command re-run rating", async () => {
	const u = fakeUI();
	const s = await escalating({ ui: u.ui });
	try {
		for (const pick of [() => "No", () => undefined]) {
			u.pick = pick;
			const { exitCode, out } = await s.run(`(${G(homeDir())}) 2>&1 | cat`);
			assert.equal(exitCode, 0);
			assert.doesNotMatch(out, /re-ran/);
		}
		assert.equal(u.selects.length, 2);
		assert.equal(s.updates.length, 0);
		assert.equal(s.offerCalls.length, 2, "one access-offer rating each");
		assert.equal(s.calls.length, 0);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("allow: a success with no UI gets a marker naming the parent session and the sandbox.json to paste; no command re-run rating, one run", async () => {
	const s = await escalating({ judge: async () => LOW });
	try {
		const { exitCode, out } = await s.run(`(${G(homeDir())}) 2>&1 | cat`);
		assert.equal(exitCode, 0);
		assert.match(out, /exited 0, but writes to ~\/\.pi-sandbox-test-\w+ needs the user's approval; not re-run\. A pi with a UI \(the parent session\) can run this same command to get the prompt; or ask the user to save this as .*sandbox\.json and restart pi: \{"filesystem":\{"allowWrite":\["~\/\.pi-sandbox-test-.*; or ask the user to allow it in .*sandbox\.json, or to run \/sandbox off in their pi/);
		assert.equal(s.offerCalls.length, 1, "one access-offer rating");
		assert.equal(s.calls.length, 0);
		assert.equal(s.wrapped.length, 1);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("macOS: allowing a dir widens the real sandbox's next wrap", macOS, async () => {
	const outside = join(HOME, unique(".pi-sandbox-probe"));
	mkdirSync(outside);
	const u = fakeUI();
	u.pick = (o) => o[0];
	delete process.env.PI_SANDBOX_ROOT;
	const s = await start(tmp("sandbox-project-"), { ui: u.ui });
	try {
		seam.judge = async () => HIGH;
		const r = await bash(`echo x > ${outside}/f`, s.ctx.cwd);
		assert.equal(r.exitCode, 0, r.out);
		assert.equal(readFileSync(join(outside, "f"), "utf8"), "x\n");
	} finally {
		await s.shutdown();
		restore();
		rmSync(outside, { recursive: true, force: true }); // only ours: the name is unique
	}
});

test("opening: a loopback bind denial opens localhost, a macOS TLS verification failure trustd; each only while closed", () => {
	const P = (network = {}, extra = {}): any => ({ network, filesystem: {}, ...extra });
	const proxy = "curl: (56) CONNECT tunnel failed, response 403; X-Proxy-Error: blocked-by-allowlist; listen localhost:8080";
	try {
		seam.platform = () => "darwin";
		for (const l of [SOCKET, LISTEN]) assert.deepEqual(opening([l], P()), { key: "allowLocalBinding", line: l });
		for (const l of [UNIXSOCK, proxy, "x: Operation not permitted"]) assert.equal(opening([l], P()), undefined, l);
		assert.deepEqual(opening([CERT], P()), { key: "enableWeakerNetworkIsolation", line: CERT });
		assert.equal(opening([SOCKET, LISTEN], P({ allowLocalBinding: true })), undefined);
		assert.equal(opening([CERT], P({}, { enableWeakerNetworkIsolation: true })), undefined);
		seam.platform = () => "linux";
		for (const l of [CERT, SOCKET, LISTEN]) assert.equal(opening([l], P()), undefined, l);
	} finally {
		restore();
	}
});

test("allow localhost: a non-Dart bind denial offers binding alone; session allows it live and re-runs sandboxed, always saves it, No goes on to the classifier", async () => {
	const u = fakeUI();
	u.pick = (o) => o[0];
	seam.platform = () => "darwin";
	let s = await escalating({ ui: u.ui, judge: async () => HIGH });
	try {
		const { exitCode, out } = await s.run(N("BIND", LISTEN));
		assert.equal(exitCode, 0);
		assert.ok(out.endsWith("[sandbox: blocked; allowed localhost binding for this session → re-ran in the sandbox]\nok\n"), out);
		assert.equal(s.updates.length, 1);
		assert.equal(s.updates[0].network.allowLocalBinding, true);
		assert.equal(s.updates[0].enableWeakerNetworkIsolation, undefined);
		const t = u.selects[0]!;
		assert.match(t, /listen on any local network interface and connect to localhost\?/);
		assert.match(t, /any interface and port, not just localhost/);
		assert.match(t, /every localhost service, including proxies or forwarders that can bypass the network allowlist/);
		assert.doesNotMatch(t, /writes to|trustd/);
		assert.ok(t.includes(`blocked: ${LISTEN}`));
		assert.equal(s.calls.length, 0);
		await s.shutdown();
		u.pick = (o) => o[1];
		s = await escalating({ ui: u.ui });
		assert.equal((await s.run(N("BIND", LISTEN))).exitCode, 0);
		assert.deepEqual(JSON.parse(readFileSync(join(s.agentDir, "sandbox.json"), "utf8")), { network: { allowLocalBinding: true } });
		await s.shutdown();
		u.pick = () => "No";
		s = await escalating({ ui: u.ui });
		const no = await s.run(N("BIND", LISTEN));
		assert.equal(no.exitCode, 3);
		assert.match(no.out, /risk low \(a build cache\) → re-ran outside the sandbox/);
		assert.deepEqual(s.calls[0].blocked, [LISTEN]);
		assert.equal(s.updates.length, 0);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("allow trustd: on macOS a TLS verification failure offers trustd alone, session or always; Linux offers nothing", async () => {
	const TLS = "error: CERTIFICATE_VERIFY_FAILED: application verification failure";
	const u = fakeUI();
	u.pick = (o) => o[0];
	seam.platform = () => "darwin";
	let s = await escalating({ ui: u.ui });
	try {
		const r = await s.run(N("TRUSTD", TLS));
		assert.equal(r.exitCode, 0);
		assert.ok(r.out.endsWith("allowed trustd TLS checks for this session → re-ran in the sandbox]\nok\n"), r.out);
		assert.match(u.selects[0]!, /trustd/);
		assert.match(u.selects[0]!, /exfiltration/);
		assert.doesNotMatch(u.selects[0]!, /writes to|listen/);
		assert.equal(s.updates[0].enableWeakerNetworkIsolation, true);
		assert.equal(s.updates[0].network.allowLocalBinding, false);
		await s.shutdown();
		u.pick = (o) => o[1];
		s = await escalating({ ui: u.ui });
		assert.equal((await s.run(N("TRUSTD", TLS))).exitCode, 0);
		const file = readFileSync(join(s.agentDir, "sandbox.json"), "utf8");
		assert.deepEqual(JSON.parse(file), { enableWeakerNetworkIsolation: true });
		await s.shutdown();
		s = await escalating({ ui: u.ui, files: { "sandbox.json": file } });
		assert.deepEqual(await s.run(N("TRUSTD", TLS)), { exitCode: 0, out: "ok\n" });
		assert.equal(u.selects.length, 2, "a new session from that file offers nothing");
		await s.shutdown();
		seam.platform = () => "linux";
		s = await escalating({ ui: u.ui });
		assert.equal((await s.run(N("TRUSTD", TLS))).exitCode, 3);
		assert.equal(u.selects.length, 2);
		assert.deepEqual(s.calls[0].blocked, [TLS]);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("Flutter set: a Dart trigger offers the closed bundle dirs, localhost and (macOS) trustd in one select; a non-Dart one only its own part", async () => {
	const home = tmp("sandbox-home-");
	const H = real(home);
	const at = (...ds: string[]) => ds.map((d) => join(H, d));
	seam.home = () => home;
	seam.temps = () => []; // the fake home stands in for one outside every writable dir
	seam.platform = () => "darwin";
	const u = fakeUI();
	u.pick = (o) => o[0];
	let s = await escalating({ ui: u.ui });
	const dart = `FileSystemException: Cannot open file, path = '${H}/.dart-tool/x.json' (OS Error: Operation not permitted, errno = 1)`;
	const cmd = `case ":$ALLOW:" in *":${H}/.dart-tool:"*) ;; *) echo "${dart}" >&2; exit 1;; esac; [ "$BIND" = true ] || { echo '${SOCKET}' >&2; exit 1; }; [ "$TRUSTD" = true ] || { echo '${CERT}' >&2; exit 1; }; echo ok`;
	const P = (network = {}, extra = {}): any => ({ network, filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] }, ...extra });
	try {
		const r = await s.run(cmd);
		assert.equal(r.exitCode, 0, r.out);
		assert.equal(u.selects.length, 1, "no second select when the re-run would hit the socket and cert lines");
		assert.match(u.selects[0]!, /allow writes to ~\/fvm, ~\/\.pub-cache, .*~\/Library\/Caches\/flutter_engine\?/);
		assert.match(u.selects[0]!, /listen on any local network interface/);
		assert.match(u.selects[0]!, /trustd/);
		assert.match(r.out, /allowed writes to ~\/fvm, .* and localhost binding and trustd TLS checks for this session → re-ran in the sandbox\]\nok\n$/);
		assert.equal(s.updates.length, 1);
		const c = s.updates[0];
		assert.ok(at(...FLUTTER).every((d) => c.filesystem.allowWrite.includes(d)));
		assert.equal(c.network.allowLocalBinding, true);
		assert.equal(c.enableWeakerNetworkIsolation, true);
		assert.equal(s.calls.length, 0);
		// Always: the same one select saves every part (a restart from it would resolve `~` to the real home, not this fake one).
		await s.shutdown();
		u.pick = (o) => o[1];
		s = await escalating({ ui: u.ui });
		assert.equal((await s.run(cmd)).exitCode, 0);
		assert.equal(u.selects.length, 2);
		const saved = JSON.parse(readFileSync(join(s.agentDir, "sandbox.json"), "utf8"));
		assert.deepEqual(saved, { filesystem: { allowWrite: FLUTTER.map((d) => `~/${d}`) }, network: { allowLocalBinding: true }, enableWeakerNetworkIsolation: true });
		// offer() alone: Node's bind is localhost only; already-open parts are left out; on Linux the Flutter set is its dirs only.
		assert.deepEqual(offer([LISTEN], P()), { dirs: [], line: LISTEN, bind: true });
		assert.deepEqual(offer([SOCKET], P()), { dirs: at(...FLUTTER), line: SOCKET, bind: true, trust: true });
		assert.deepEqual(offer([CERT], P({ allowLocalBinding: true }, { filesystem: { ...P().filesystem, allowWrite: at("fvm") } })), { dirs: at(...FLUTTER.slice(1)), line: CERT, trust: true });
		assert.equal(offer([SOCKET, CERT], P({ allowLocalBinding: true }, { enableWeakerNetworkIsolation: true, filesystem: { ...P().filesystem, allowWrite: [H] } })), undefined);
		seam.platform = () => "linux";
		assert.deepEqual(offer([CERT], P()), { dirs: at(...FLUTTER), line: CERT });
		assert.deepEqual(offer([SOCKET], P()), { dirs: at(...FLUTTER), line: SOCKET });
		assert.equal(offer([LISTEN], P()), undefined);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("allow: a No sticks for the session's same parts; a dismissed dialog asks again; a new session asks again", async () => {
	const u = fakeUI();
	u.pick = () => "No";
	let s = await escalating({ ui: u.ui });
	const D = homeDir();
	try {
		assert.equal((await s.run(G(D))).exitCode, 3);
		assert.equal(u.selects.length, 1);
		const again = await s.run(G(D));
		assert.equal(again.exitCode, 3, "nonzero goes to the classifier");
		assert.equal(s.calls.length, 2);
		const ok = await s.run(`(${G(D)}) 2>&1 | cat`);
		assert.equal(ok.exitCode, 0);
		assert.doesNotMatch(ok.out, /\[sandbox:/, "exit 0 returns");
		assert.equal(s.calls.length, 2);
		assert.equal(u.selects.length, 1);
		u.pick = () => undefined;
		const E = homeDir();
		await s.run(G(E));
		await s.run(G(E));
		assert.equal(u.selects.length, 3, "Esc is not sticky");
		// A No to the combined Flutter offer covers its localhost and trustd parts when a later, unrelated trigger names them alone.
		seam.platform = () => "darwin";
		u.pick = () => "No";
		await s.run(N("BIND", SOCKET));
		assert.equal(u.selects.length, 4);
		assert.match(u.selects[3]!, /localhost/);
		assert.match(u.selects[3]!, /trustd/);
		await s.run(N("BIND", LISTEN));
		await s.run(N("TRUSTD", "error: CERTIFICATE_VERIFY_FAILED: application verification failure"));
		assert.equal(u.selects.length, 4, "bind and trust stay declined");
		await s.shutdown();
		s = await escalating({ ui: u.ui });
		await s.run(G(D));
		assert.equal(u.selects.length, 5);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("macOS: allowing localhost lets the real sandbox's next wrap listen on 127.0.0.1", macOS, async () => {
	const listen = `${JSON.stringify(process.execPath)} -e 'require("net").createServer().on("error", (e) => { console.error(e.message); process.exit(1); }).listen(0, "127.0.0.1", function () { console.log("listening"); this.close(); })'`;
	const u = fakeUI();
	u.pick = (o) => o[0];
	delete process.env.PI_SANDBOX_ROOT;
	const s = await start(tmp("sandbox-project-"), { ui: u.ui });
	try {
		seam.judge = async () => HIGH;
		const r = await bash(listen, s.ctx.cwd);
		assert.equal(r.exitCode, 0, r.out);
		assert.match(r.out, /allowed localhost binding for this session → re-ran in the sandbox\]\nlistening\n$/);
		assert.equal(u.selects.length, 1);
	} finally {
		await s.shutdown();
		restore();
	}
});

/** Resolves once `f()` holds, plus one event-loop turn; throws after `ms`, so a broken wait fails instead of hanging. */
async function until(f: () => boolean, ms = 5000) {
	const end = Date.now() + ms;
	while (!f()) {
		if (Date.now() > end) throw new Error(`until: still false after ${ms} ms: ${f}`);
		await new Promise((r) => setTimeout(r, 5));
	}
	await new Promise((r) => setImmediate(r));
}
const deferred = <T = unknown>() => {
	let release!: (v: T) => void;
	const p = new Promise<T>((r) => (release = r));
	return { p, release };
};

test("offer rating: low allows the access for this session with no select, with a UI or none; after exit 0 it does not re-run; no approval is recorded", async () => {
	const u = fakeUI();
	let s = await escalating({ ui: u.ui, offer: async () => LOW });
	let D = homeDir();
	try {
		const r = await s.run(G(D));
		assert.equal(r.exitCode, 0);
		assert.ok(r.out.endsWith(`[sandbox: blocked; allowed writes to ~/${basename(D)} for this session (risk low: a build cache) → re-ran in the sandbox]\nok\n`), r.out);
		assert.equal(u.selects.length, 0);
		assert.deepEqual(u.notes.at(-1), [`sandbox: allowed writes to ~/${basename(D)} for this session (risk low: a build cache)`, "warning"]);
		assert.ok(s.updates[0].filesystem.allowWrite.includes(D));
		assert.equal(existsSync(join(s.agentDir, "sandbox.json")), false);
		assert.equal(s.calls.length, 0);
		const o = s.offerCalls[0];
		assert.equal(o.command, G(D));
		assert.equal(o.access, `writes to ~/${basename(D)}`);
		assert.ok(o.blocked[0].includes(`${D}/cache/x`));
		for (const k of ["cwd", "root", "user", "plan", "calls", "approved", "delegated"]) assert.ok(k in o, k);
		await s.shutdown();
		s = await escalating({ offer: async () => LOW });
		D = homeDir();
		const none = await s.run(G(D));
		assert.equal(none.exitCode, 0);
		assert.ok(none.out.endsWith(`[sandbox: blocked; allowed writes to ~/${basename(D)} for this session (risk low: a build cache) → re-ran in the sandbox]\nok\n`), none.out);
		await s.shutdown();
		s = await escalating({ offer: async () => LOW });
		D = homeDir();
		const zero = await s.run(`(${G(D)}) 2>&1 | cat`);
		assert.equal(zero.exitCode, 0);
		assert.match(zero.out, /not re-run, since it exited 0/);
		assert.equal(s.wrapped.length, 1);
		assert.ok(s.updates[0].filesystem.allowWrite.includes(D));
		await s.run(F);
		assert.deepEqual(s.calls.at(-1).approved, [], "a low offer is not a user approval");
	} finally {
		await s.shutdown();
		restore();
	}
});

test("offer rating: high, or a classifier failure, shows the select with the reason; declined parts are not rated again, while the command still escalates", async () => {
	const u = fakeUI();
	let verdict: () => Promise<unknown> = async () => HIGH;
	const s = await escalating({ ui: u.ui, offer: () => verdict() });
	try {
		assert.equal((await s.run(G(homeDir()))).exitCode, 3);
		assert.match(u.selects[0]!, /\nrisk high: writes a dotfile\n\$ /);
		verdict = () => Promise.reject(new Error("boom"));
		await s.run(G(homeDir()));
		assert.match(u.selects.at(-1)!, /classifier failed: boom/);
		verdict = async () => HIGH;
		u.pick = () => "No";
		const D = homeDir();
		await s.run(G(D));
		const [offers, judged] = [s.offerCalls.length, s.calls.length];
		assert.equal((await s.run(G(D))).exitCode, 3);
		assert.equal(s.offerCalls.length, offers, "declined parts are not rated again");
		assert.equal(s.calls.length, judged + 1, "the nonzero command still goes to ordinary escalation");
		assert.equal(s.updates.length, 0);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("offer rating: a low Flutter set grants every part in one update, with no select", async () => {
	const home = tmp("sandbox-home-");
	const H = real(home);
	seam.home = () => home;
	seam.temps = () => []; // the fake home stands in for one outside every writable dir
	seam.platform = () => "darwin";
	const u = fakeUI();
	const s = await escalating({ ui: u.ui, offer: async () => LOW });
	const dart = `FileSystemException: Cannot open file, path = '${H}/.dart-tool/x.json' (OS Error: Operation not permitted, errno = 1)`;
	const cmd = `case ":$ALLOW:" in *":${H}/.dart-tool:"*) ;; *) echo "${dart}" >&2; exit 1;; esac; [ "$BIND" = true ] || { echo '${SOCKET}' >&2; exit 1; }; [ "$TRUSTD" = true ] || { echo '${CERT}' >&2; exit 1; }; echo ok`;
	try {
		const r = await s.run(cmd);
		assert.equal(r.exitCode, 0, r.out);
		assert.equal(u.selects.length, 0);
		assert.equal(s.updates.length, 1);
		const c = s.updates[0];
		assert.ok(FLUTTER.map((d) => join(H, d)).every((d) => c.filesystem.allowWrite.includes(d)));
		assert.equal(c.network.allowLocalBinding, true);
		assert.equal(c.enableWeakerNetworkIsolation, true);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("offer rating: a host denied, an abort, or a No from another command's dialog while the rating is pending grants nothing and re-runs nothing", async () => {
	for (const ui of [fakeUI(), undefined]) {
		let next = deferred();
		const s = await escalating({ ui: ui?.ui, offer: () => next.p });
		try {
			const ran = s.run(G(homeDir()));
			await until(() => s.offerCalls.length === 1);
			assert.equal(await s.got.ask!({ host: "h1", port: 443 }), false);
			next.release(LOW);
			const r = await ran;
			assert.equal(r.exitCode, 1);
			assert.doesNotMatch(r.out, /re-ran|outside\n|ok\n/);
			assert.equal(s.updates.length, 0);
			assert.equal(s.wrapped.length, 1);
			assert.equal(s.calls.length, 0);
		} finally {
			await s.shutdown();
			restore();
		}
	}
	let next = deferred();
	let s = await escalating({ offer: () => next.p });
	try {
		const ac = new AbortController();
		let out = "";
		const ran = sandboxedBash.exec(G(homeDir()), s.ctx.cwd, { onData: (d) => (out += d), signal: ac.signal, timeout: 30 });
		await until(() => s.offerCalls.length === 1);
		ac.abort();
		next.release(LOW);
		assert.equal((await ran).exitCode, 1);
		assert.doesNotMatch(out, /re-ran|outside\n|ok\n/);
		assert.equal(s.updates.length, 0);
		assert.equal(s.wrapped.length, 1);
		await s.run(F);
		assert.deepEqual(s.calls.at(-1).approved, []);
		await s.shutdown();
		const u = fakeUI();
		u.pick = () => "No";
		const first = deferred();
		const verdicts = [first.p, Promise.resolve(HIGH)];
		s = await escalating({ ui: u.ui, offer: () => verdicts.shift()! });
		const D = homeDir();
		const one = s.run(G(D));
		await until(() => s.offerCalls.length === 1);
		const two = await s.run(G(D));
		assert.equal(u.selects.length, 1);
		assert.equal(two.exitCode, 3, "the declined one goes on to escalation");
		first.release(LOW);
		const r = await one;
		assert.equal(r.exitCode, 1);
		assert.doesNotMatch(r.out, /re-ran|outside\n|ok\n/);
		assert.equal(s.updates.length, 0);
		assert.equal(s.wrapped.length, 2);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("offer rating: each sandboxed re-run that hits another dir is rated and granted in turn, with no escalation or approval", async () => {
	const u = fakeUI();
	const s = await escalating({ ui: u.ui, offer: async () => LOW });
	const n = join(tmp("sandbox-count-"), "n");
	const base = homeDir();
	made.push(...[0, 1, 2].map((i) => `${base}-${i}`)); // allow() makes them on Linux
	try {
		const cmd = `n=$(cat ${n} 2>/dev/null || echo 0); echo $((n + 1)) > ${n}; if [ "$n" = 3 ]; then echo ok; exit 0; fi; echo "bash: line 1: ${base}-$n/a: Operation not permitted" >&2; exit 1`;
		const { exitCode, out } = await s.run(cmd);
		assert.equal(exitCode, 0, out);
		assert.match(out, /ok\n$/);
		assert.equal(s.offerCalls.length, 3);
		assert.deepEqual(s.offerCalls.map((o) => o.access), [0, 1, 2].map((i) => `writes to ~/${basename(base)}-${i}`));
		assert.equal(s.updates.length, 3);
		assert.equal(s.wrapped.length, 4, "every run sandboxed");
		assert.equal(u.selects.length, 0);
		assert.equal(s.calls.length, 0);
		await s.run(F);
		assert.deepEqual(s.calls.at(-1).approved, []);
	} finally {
		await s.shutdown();
		restore();
	}
});

// Lets every pending promise chain run (the fake runtime's work is already done by then).
const drain = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const OFF_MARKER = "[sandbox: blocked; the sandbox was turned off while this was pending; not re-run: run it again]";

/** A fresh session on a fake home (nothing under the real home is written): offer ratings come from `verdicts` in order, then HIGH;
 * each select returns its own deferred answer. `exec` runs a command with an optional abort signal, tracked for `settle`. */
async function review(verdicts: Promise<unknown>[], { withUI = true } = {}) {
	const home = tmp("sandbox-home-");
	seam.home = () => home;
	seam.temps = () => [];
	const u = fakeUI();
	const sels: { p: Promise<string | undefined>; release: (v: string | undefined) => void }[] = [];
	const choices: string[][] = [];
	(u.ui as any).select = (t: string, o: string[]) => (u.selects.push(t), choices.push(o), sels.push(deferred<string | undefined>()), sels.at(-1)!.p);
	// A verdict still pending when its command is aborted (by settle) rejects, so no rating is left hanging.
	const offer = (_input: unknown, signal?: AbortSignal) =>
		new Promise<unknown>((res, rej) => {
			signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
			(verdicts.shift() ?? Promise.resolve(HIGH)).then(res, rej);
		});
	const s = await escalating({ ui: withUI ? u.ui : undefined, offer });
	const pending: Promise<unknown>[] = [];
	const stops: AbortController[] = [];
	const exec = (command: string, signal?: AbortSignal) => {
		let out = "";
		let done = false;
		const stop = new AbortController();
		stops.push(stop);
		const p = sandboxedBash.exec(command, s.ctx.cwd, { onData: (d) => (out += d), signal: signal ? AbortSignal.any([signal, stop.signal]) : stop.signal, timeout: 30 }).then(({ exitCode }) => ((done = true), { exitCode, out }));
		pending.push(p);
		return Object.assign(p, { done: () => done });
	};
	// Ends whatever a failed assertion left open: dialogs dismissed, commands (and their pending ratings) aborted, bounded.
	const settle = async () => {
		sels.forEach((d) => d.release(undefined));
		stops.forEach((c) => c.abort());
		await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 5000))]);
		await s.shutdown();
		restore();
	};
	const sandboxCmd = (arg: string) => s.commands.sandbox.handler(arg, { hasUI: true, ui: { confirm: async () => true, notify: () => {} } });
	return { s, u, sels, choices, exec, settle, sandboxCmd, D: join(real(home), unique(".tool")) };
}

test("offer review: a low offer waits for an open dialog on the same access; its No holds for both, its Once lets both re-run", async () => {
	for (const answer of ["No", "Once"]) {
		const low = deferred();
		const r = await review([Promise.resolve(HIGH), low.p]);
		try {
			const a = r.exec(G(r.D));
			await until(() => r.u.selects.length === 1);
			const b = r.exec(G(r.D));
			await until(() => r.s.offerCalls.length === 2);
			low.release(LOW);
			await drain();
			assert.equal(b.done(), false, "the low command waits for the open dialog");
			assert.equal(r.s.updates.length, 0);
			assert.equal(r.s.wrapped.length, 2);
			r.sels[0]!.release(answer === "No" ? "No" : r.choices[0]![0]);
			const [ra, rb] = [await a, await b];
			if (answer === "No") {
				assert.equal(rb.exitCode, 1, rb.out);
				assert.doesNotMatch(rb.out, /re-ran|ok\n|outside\n/);
				assert.equal(ra.exitCode, 3, "the dialog's own command goes on to ordinary escalation");
				assert.equal(r.s.calls.length, 1, "the low command has no escalation rating of its own");
				assert.equal(r.s.updates.length, 0);
				assert.equal(r.s.wrapped.length, 2);
			} else {
				for (const x of [ra, rb]) assert.ok(x.exitCode === 0 && x.out.endsWith("ok\n"), x.out);
				assert.match(rb.out, /\(risk low: a build cache\) → re-ran in the sandbox\]\nok\n$/);
				assert.equal(r.s.wrapped.length, 4, "both re-runs sandboxed");
				assert.equal(r.s.calls.length, 0);
			}
		} finally {
			await r.settle();
		}
	}
});

test("offer review: a low offer waits for every overlapping dialog, not just the newest", async () => {
	const low = deferred();
	const r = await review([Promise.resolve(HIGH), Promise.resolve(HIGH), low.p]);
	try {
		const a1 = r.exec(G(r.D));
		await until(() => r.u.selects.length === 1);
		const a2 = r.exec(G(r.D));
		await until(() => r.u.selects.length === 2);
		const b = r.exec(G(r.D));
		await until(() => r.s.offerCalls.length === 3);
		low.release(LOW);
		await drain();
		r.sels[1]!.release(undefined); // dismiss the newer
		assert.equal((await a2).exitCode, 3);
		await drain();
		assert.equal(b.done(), false, "the older dialog is still open");
		assert.equal(r.s.updates.length, 0);
		r.sels[0]!.release("No");
		const rb = await b;
		assert.equal(rb.exitCode, 1);
		assert.doesNotMatch(rb.out, /re-ran|ok\n|outside\n/);
		assert.equal((await a1).exitCode, 3);
		assert.equal(r.s.updates.length, 0);
	} finally {
		await r.settle();
	}
});

test("offer review: the wait's deadline or the waiting command's abort grants nothing and leaves the dialog open; a late answer to an aborted dialog does nothing", async () => {
	// The deadline: the waiter gives up, the owner's dialog stays open and still decides.
	let low = deferred();
	let r = await review([Promise.resolve(HIGH), low.p]);
	try {
		const wait = new AbortController();
		seam.offerWait = () => wait.signal;
		const a = r.exec(G(r.D));
		await until(() => r.u.selects.length === 1);
		const b = r.exec(G(r.D));
		await until(() => r.s.offerCalls.length === 2);
		low.release(LOW);
		await drain();
		wait.abort();
		const rb = await b;
		assert.equal(rb.exitCode, 1);
		assert.match(rb.out, /is still open; not re-run: answer it, then run this again\]\n$/);
		assert.equal(r.s.updates.length, 0);
		assert.equal(r.s.wrapped.length, 2);
		await drain();
		assert.equal(a.done(), false, "the owner is not timed out");
		r.sels[0]!.release(r.choices[0]![0]);
		const ra = await a;
		assert.ok(ra.exitCode === 0 && ra.out.endsWith("ok\n"), "no sticky No from the waiter");
	} finally {
		await r.settle();
	}
	// The waiting command aborted.
	low = deferred();
	r = await review([Promise.resolve(HIGH), low.p]);
	try {
		const a = r.exec(G(r.D));
		await until(() => r.u.selects.length === 1);
		const ac = new AbortController();
		const b = r.exec(G(r.D), ac.signal);
		await until(() => r.s.offerCalls.length === 2);
		low.release(LOW);
		await drain();
		ac.abort();
		const rb = await b;
		assert.equal(rb.exitCode, 1);
		assert.doesNotMatch(rb.out, /re-ran|ok\n|outside\n/);
		assert.equal(r.s.updates.length, 0);
		await drain();
		assert.equal(a.done(), false);
	} finally {
		await r.settle();
	}
	// The dialog's own command aborted: a late Yes does nothing, and a new low offer is not held up.
	r = await review([Promise.resolve(HIGH), Promise.resolve(LOW)]);
	try {
		const ac = new AbortController();
		const a = r.exec(G(r.D), ac.signal);
		await until(() => r.u.selects.length === 1);
		ac.abort();
		assert.equal((await a).exitCode, 1);
		r.sels[0]!.release(r.choices[0]![0]);
		await drain();
		assert.equal(r.s.updates.length, 0);
		assert.equal(r.s.wrapped.length, 1);
		const c = await r.exec(G(r.D));
		assert.ok(c.exitCode === 0 && c.out.endsWith("ok\n"), c.out);
		assert.equal(r.s.updates.length, 1);
	} finally {
		await r.settle();
	}
});

test("offer review: a confirmed /sandbox off stops a pending offer: no grant, re-run, save or approval, also after /sandbox on", async () => {
	for (const withUI of [false, true])
		for (const reon of [false, true]) {
			const low = deferred();
			const r = await review(withUI ? [] : [low.p], { withUI });
			const label = `${withUI ? "UI, Always" : "no UI, low"}${reon ? ", on again" : ""}`;
			try {
				const a = r.exec(G(r.D));
				await until(() => (withUI ? r.u.selects.length === 1 : r.s.offerCalls.length === 1));
				await r.sandboxCmd("off");
				if (reon) await r.sandboxCmd("on");
				if (withUI) r.sels[0]!.release(r.choices[0]![1]);
				else low.release(LOW);
				const ra = await a;
				assert.equal(ra.exitCode, 1, label);
				assert.ok(ra.out.endsWith(`${OFF_MARKER}\n`), `${label}: ${ra.out}`);
				assert.doesNotMatch(ra.out, /re-ran|allowed/, label);
				assert.equal(r.s.wrapped.length, 1, label);
				assert.equal(r.s.calls.length, 0, `${label}: no ordinary escalation`);
				assert.equal(r.s.updates.length, 0, label);
				assert.equal(existsSync(join(r.s.agentDir, "sandbox.json")), false, label);
				if (!reon) await r.sandboxCmd("on");
				await r.s.run(F);
				assert.deepEqual(r.s.calls.at(-1).approved, [], `${label}: no recorded approval`);
			} finally {
				await r.settle();
			}
		}
});

test("offer review: a /sandbox on while already on keeps the pending offer stoppable by the next /sandbox off", async () => {
	const low = deferred();
	const r = await review([low.p], { withUI: false });
	try {
		const a = r.exec(G(r.D));
		await until(() => r.s.offerCalls.length === 1);
		await r.sandboxCmd("on");
		await r.sandboxCmd("off");
		low.release(LOW);
		const ra = await a;
		assert.equal(ra.exitCode, 1, ra.out);
		assert.ok(ra.out.endsWith(`${OFF_MARKER}\n`), ra.out);
		assert.doesNotMatch(ra.out, /re-ran|allowed|outside\n/);
		assert.equal(r.s.wrapped.length, 1);
		assert.equal(r.s.updates.length, 0);
		await r.sandboxCmd("on");
	} finally {
		await r.settle();
	}
});

test("offer review: a dialog that opens while a low offer's overlap check returns is still waited for, and its No holds", async () => {
	const [low, high] = [deferred(), deferred()];
	const r = await review([low.p, high.p]);
	try {
		const a = r.exec(G(r.D));
		await until(() => r.s.offerCalls.length === 1); // so A, not B, gets the first (LOW) verdict
		const b = r.exec(G(r.D));
		await until(() => r.s.offerCalls.length === 2);
		// Both ratings finish in the same turn, LOW first: the low one's last check sees no dialog, then B's opens.
		low.release(LOW);
		high.release(HIGH);
		await until(() => r.u.selects.length === 1);
		await drain();
		assert.equal(a.done(), false, "the low command waits for the dialog that opened");
		assert.equal(r.s.updates.length, 0);
		r.sels[0]!.release("No");
		const [ra, rb] = [await a, await b];
		assert.equal(ra.exitCode, 1, ra.out);
		assert.doesNotMatch(ra.out, /re-ran|ok\n|outside\n/);
		assert.equal(rb.exitCode, 3, "the dialog's own command goes on to ordinary escalation");
		assert.equal(r.s.updates.length, 0);
	} finally {
		await r.settle();
	}
});
