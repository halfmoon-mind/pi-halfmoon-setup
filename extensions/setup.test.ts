// Run: node --import ./extensions/test-hooks.ts --test extensions/setup.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../setup.sh", import.meta.url));
const pkg = "git:github.com/halfmoon-mind/pi-halfmoon-setup";
const stubs: Record<string, string> = {
	pi: `case "$1 $2" in "list "*) echo "User packages:"; echo "  \${PI_LIST-${pkg}}"; exit "\${PI_LIST_STATUS:-0}";; "auth check") exit \${PI_AUTH:-0};; esac`,
	claude: `[ "$1 $2" = "auth status" ] && exit \${CLAUDE_AUTH:-0}; exit 0`,
	brew: "",
	pdftotext: "",
	pandoc: "",
	soffice: "",
	rg: "",
};

function setup({ omit = [] as string[], env = {} as Record<string, string>, settings = undefined as string | undefined } = {}) {
	const bin = mkdtempSync(join(tmpdir(), "setup-bin-"));
	const home = mkdtempSync(join(tmpdir(), "setup-home-"));
	const log = join(home, "calls.log");
	const file = join(home, ".pi/agent/settings.json");
	for (const [name, body] of Object.entries(stubs)) {
		if (omit.includes(name)) continue;
		writeFileSync(join(bin, name), `#!/bin/sh\necho "\${0##*/} $*" >> "$SETUP_LOG"\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	}
	symlinkSync(process.execPath, join(bin, "node"));
	if (settings !== undefined) {
		mkdirSync(join(home, ".pi/agent"), { recursive: true });
		writeFileSync(file, settings);
	}
	return {
		run: () => spawnSync("/bin/bash", [script], { env: { PATH: bin, HOME: home, SETUP_TTY: "/dev/null", SETUP_LOG: log, ...env }, encoding: "utf8", timeout: 10_000 }),
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
		settingsText: () => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
	};
}

const macOnly = { skip: process.platform !== "darwin" && "setup.sh installs with brew on macOS only" };

test("a ready machine gets only the absent settings keys, and a second run changes nothing", macOnly, () => {
	const s = setup({ settings: JSON.stringify({ hideThinkingBlock: false, theme: "dark" }, null, 2) });
	const first = s.run();
	assert.equal(first.status, 0, first.stdout + first.stderr);
	assert.ok(!s.calls().some((c) => /install|login/.test(c)), s.calls().join("\n"));
	const text = s.settingsText();
	assert.equal(text, JSON.stringify({ hideThinkingBlock: false, theme: "dark", quietStartup: "header", steeringMode: "all", followUpMode: "all" }, null, 2) + "\n");
	const second = s.run();
	assert.equal(second.status, 0, second.stdout + second.stderr);
	assert.ok(second.stdout.includes("✓ settings.json"));
	assert.equal(s.settingsText(), text);
	assert.ok(!s.calls().some((c) => /install|login/.test(c)), s.calls().join("\n"));
});

test("missing tools, package and logins are installed or signed in, and settings are created", macOnly, () => {
	const s = setup({ omit: ["pandoc"], env: { PI_AUTH: "1", CLAUDE_AUTH: "1", PI_LIST: "" } });
	const r = s.run();
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const calls = s.calls();
	for (const c of ["brew install pandoc", `pi install ${pkg}`, "claude auth login", "pi auth login openai"]) assert.ok(calls.includes(c), `${c} not in\n${calls.join("\n")}`);
	assert.ok(!calls.includes("brew install poppler"));
	assert.deepEqual(JSON.parse(s.settingsText()!), { quietStartup: "header", hideThinkingBlock: true, steeringMode: "all", followUpMode: "all" });
});

test("a missing pi stops with how to install it, before any brew call", macOnly, () => {
	const s = setup({ omit: ["pi"] });
	const r = s.run();
	assert.notEqual(r.status, 0);
	assert.match(r.stdout, /pi\.dev/);
	assert.ok(!s.calls().some((c) => c.startsWith("brew")));
});

test("a failed pi list stops setup with its status and writes nothing", macOnly, () => {
	const s = setup({ env: { PI_LIST_STATUS: "7" } });
	const r = s.run();
	assert.equal(r.status, 7, r.stdout + r.stderr);
	assert.ok(!r.stdout.includes("✓ pi package"));
	assert.ok(!s.calls().some((c) => c.startsWith("pi install")));
	assert.equal(s.settingsText(), undefined);
});

test("Linux gets every step printed and nothing run", { skip: process.platform !== "linux" && "Linux-only instructions" }, () => {
	const s = setup({ omit: ["pi", "claude"] });
	const r = s.run();
	assert.equal(r.status, 1);
	for (const t of ["apt-get install poppler-utils pandoc ripgrep bubblewrap socat libreoffice", "pi.dev", "pi auth login openai", "hideThinkingBlock"]) assert.ok(r.stdout.includes(t), t);
	assert.deepEqual(s.calls(), []);
	assert.equal(s.settingsText(), undefined);
});
