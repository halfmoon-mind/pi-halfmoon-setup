// Run: node --import ./extensions/test-hooks.ts --test --test-timeout=60000 extensions/sandbox/offer.test.ts
// From a trusted terminal or CI: the macOS tests start the real sandbox, which cannot nest in another.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { offer, opening, scanner } from "./denials.ts";
import { real, seam } from "./policy.ts";
import { bash, escalating, fakeUI, HIGH, HOME, LOW, macOS, made, restore, start, tmp, unique } from "./test-helpers.ts";

// Denied in the (fake) sandbox under D until D is writable (in $ALLOW); exit 3 outside it.
const G = (D: string) => `case ":$ALLOW:" in *":${D}:"*) echo ok; exit 0;; esac; echo "bash: line 1: ${D}/cache/x: Operation not permitted" >&2; if [ -n "$IN_SANDBOX" ]; then exit 1; fi; echo outside; exit 3`;
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
	const D = join(HOME, unique(".pi-sandbox-test"));
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
	const D = join(HOME, unique(".pi-sandbox-test"));
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
		const D = join(HOME, unique(".pi-sandbox-test"));
		const r = await s.run(G(D));
		assert.equal(r.exitCode, 0);
		assert.match(r.out, /and saved them to sandbox\.json → re-ran in the sandbox\]\nok\n$/);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { network: { allowedDomains: ["example.org"] }, filesystem: { allowWrite: [`~/${basename(D)}`] } });
		writeFileSync(file, '{"filesystem": []}');
		const again = await s.run(G(join(HOME, unique(".pi-sandbox-test"))));
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
			const { exitCode, out } = await s.run(G(join(HOME, unique(".pi-sandbox-test"))));
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
	const base = join(HOME, unique(".pi-sandbox-test"));
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
		const { exitCode, out } = await s.run(G(join(HOME, unique(".pi-sandbox-test"))));
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
		assert.equal((await s.run(G(join(HOME, unique(".pi-sandbox-test"))))).exitCode, 1);
		assert.equal(u.selects.length, 0);
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
	const D = join(HOME, unique(".pi-sandbox-test"));
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

test("allow dirs: a success with No or a dismissed dialog returns the first run, with no classifier", async () => {
	const u = fakeUI();
	const s = await escalating({ ui: u.ui });
	try {
		for (const pick of [() => "No", () => undefined]) {
			u.pick = pick;
			const { exitCode, out } = await s.run(`(${G(join(HOME, unique(".pi-sandbox-test")))}) 2>&1 | cat`);
			assert.equal(exitCode, 0);
			assert.doesNotMatch(out, /re-ran/);
		}
		assert.equal(u.selects.length, 2);
		assert.equal(s.updates.length, 0);
		assert.equal(s.calls.length, 0);
	} finally {
		await s.shutdown();
		restore();
	}
});

test("allow: a success with no UI gets a marker naming the parent session and the sandbox.json to paste; no classifier, one run", async () => {
	const s = await escalating({ judge: async () => LOW });
	try {
		const { exitCode, out } = await s.run(`(${G(join(HOME, unique(".pi-sandbox-test")))}) 2>&1 | cat`);
		assert.equal(exitCode, 0);
		assert.match(out, /exited 0, but writes to ~\/\.pi-sandbox-test-\w+ needs the user's approval; not re-run\. A pi with a UI \(the parent session\) can run this same command to get the prompt; or ask the user to save this as .*sandbox\.json and restart pi: \{"filesystem":\{"allowWrite":\["~\/\.pi-sandbox-test-/);
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
	const D = join(HOME, unique(".pi-sandbox-test"));
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
		const E = join(HOME, unique(".pi-sandbox-test"));
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
