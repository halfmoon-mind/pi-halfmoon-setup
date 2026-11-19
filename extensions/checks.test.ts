// Run: node --import ./extensions/test-hooks.ts --test extensions/checks.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gated, lintPlan, parsePlan, runCheck, seam } from "./checks.ts";

const PLAN = [
	"# Title",
	"## Plan",
	"- [x] 1. Add it - files: a.ts, `b.ts (new)` - check: `node --test a.test.ts`",
	"  Prose about step 1.",
	"* [ ] 2. Wire it - files: src/ , c.ts - check: `grep -q x c.ts`",
	"  - [X] 3. Nested",
	"    - files: d.ts - check: `true`",
	"## Success criteria",
	"- `npm test`",
	"Some prose, not a command.",
	"- `! git check-ignore -q x`",
	"## Risks",
	"- `not a criterion`",
].join("\n");

test("parsePlan reads each checkbox line's files and check, and the success criteria commands", () => {
	assert.deepEqual(parsePlan(PLAN), {
		steps: [
			{ n: 1, done: true, files: ["a.ts", "b.ts (new)"], check: "node --test a.test.ts" },
			{ n: 2, done: false, files: ["src/", "c.ts"], check: "grep -q x c.ts" },
			{ n: 3, done: true, files: [] },
		],
		criteria: ["npm test", "! git check-ignore -q x"],
		requirements: [],
		sources: [],
	});
});

test("lintPlan names each problem, and passes a clean plan", () => {
	const cwd = mkdtempSync(join(tmpdir(), "checks-"));
	writeFileSync(join(cwd, "a.ts"), "");
	mkdirSync(join(cwd, "src"));
	assert.deepEqual(lintPlan(cwd, "").map((p) => p.split(":")[0]), ["no steps", "no success criteria commands"]);
	assert.match(lintPlan(cwd, "")[0], /- \[ \] 1\. <what> - files: a\.ts - check:/, "names the line format a weak model missed");
	assert.deepEqual(lintPlan(cwd, PLAN), ["step 2: c.ts does not exist (mark a new file `c.ts (new)`)", "step 3 has no check", "step 3 lists no files"]);
	const clean = "- [ ] 1. a - files: a.ts, src, src/, b.ts (new), bench/agent/tasks/ (new) - check: `true`\n## Success criteria\n- `true`\n";
	assert.deepEqual(lintPlan(cwd, clean), []);
	writeFileSync(join(cwd, "b.ts"), "");
	mkdirSync(join(cwd, "bench/agent/tasks"), { recursive: true });
	assert.deepEqual(lintPlan(cwd, clean), [], "a marked-new file may exist already");
	assert.deepEqual(lintPlan(cwd, "- [ ] 1. a - files: a.ts - check: `true`\n"), ["no success criteria commands"]);
});

test("Sources and Requirements: each requirement maps to an existing step or is marked out", () => {
	const cwd = mkdtempSync(join(tmpdir(), "checks-"));
	writeFileSync(join(cwd, "a.ts"), "");
	const clean = "- [ ] 1. a - files: a.ts - check: `true`\n## Success criteria\n- `true`\n";
	const sources = "## Sources\n- docs/spec.pdf\n- https://x.notion.site/p\n";
	const r1 = '- R1. "9806 409 already finished" — src: spec p.12 - step: 1\n';
	const r3 = '- R3. "PUT fails" — src: spec p.6 - out: user agreed 403 re-presign x2 (2026-11-17)\n';
	const REQ = `${clean}${sources}## Requirements\n${r1}- R2. "webp" — src: spec p.3 - step: 1, 9\n${r3}- R4. "doneCount" — src: spec p.8\n`;
	const parsed = parsePlan(REQ);
	assert.deepEqual(parsed.sources, ["docs/spec.pdf", "https://x.notion.site/p"]);
	assert.deepEqual(parsed.requirements, [
		{ id: "R1", steps: [1] },
		{ id: "R2", steps: [1, 9] },
		{ id: "R3", steps: [], out: "user agreed 403 re-presign x2 (2026-11-17)" },
		{ id: "R4", steps: [] },
	]);
	assert.deepEqual(parsed.criteria, ["true"], "criteria end at the next section");
	assert.deepEqual(lintPlan(cwd, REQ), ["R2 maps to step 9, which does not exist", "R4 maps to no step (end it with - step: N or - out: <reason>)"]);
	assert.deepEqual(lintPlan(cwd, clean + sources).map((p) => p.split(" but ")[0]), ["## Sources lists documents"]);
	assert.deepEqual(lintPlan(cwd, `${clean}## Requirements\n${r1}`), ["## Requirements has lines but ## Sources lists no documents"]);
	assert.deepEqual(lintPlan(cwd, `${clean}${sources}## Requirements\n${r1}${r3}`), []);
	assert.deepEqual(
		lintPlan(cwd, `${clean}${sources}## Requirements\n- R5. "send icon" — src: figma 5392:18299 - out: unconfirmed, asked the user\n`),
		["R5 is unconfirmed: ask the user, then end it with - step: N or - out: <their answer>"],
		"an open question is not an agreed out, which the review gate would skip",
	);
});

test("gated: tui always, print only under PI_EVAL=1, json and rpc never", () => {
	const saved = process.env.PI_EVAL;
	try {
		delete process.env.PI_EVAL;
		assert.deepEqual(["tui", "print", "json", "rpc"].map(gated), [true, false, false, false]);
		process.env.PI_EVAL = "1";
		assert.deepEqual(["tui", "print", "json", "rpc"].map(gated), [true, true, false, false]);
	} finally {
		if (saved === undefined) delete process.env.PI_EVAL;
		else process.env.PI_EVAL = saved;
	}
});

test("runCheck reports the exit code and the output's tail; a throw is a failure", async () => {
	const exec = seam.exec;
	const calls: any[] = [];
	try {
		seam.exec = async (command, cwd, options) => {
			calls.push({ command, cwd, timeout: options.timeout });
			if (command === "boom") throw new Error("timeout:300");
			if (command === "ok") options.onData(Buffer.from("fine\n"));
			else for (let i = 0; i < 30; i++) options.onData(Buffer.from(`${String(i).padStart(99, "-")}\n`));
			return { exitCode: command === "ok" ? 0 : 1 };
		};
		assert.deepEqual(await runCheck("ok", "/r"), { command: "ok", ok: true, exitCode: 0, tail: "fine\n" });
		const bad = await runCheck("bad", "/r");
		assert.equal(bad.ok, false);
		assert.equal(bad.exitCode, 1);
		assert.equal(bad.tail.length, 2000);
		assert.ok(bad.tail.endsWith(`${"-".repeat(97)}29\n`));
		assert.deepEqual(await runCheck("boom", "/r"), { command: "boom", ok: false, exitCode: null, tail: "timeout:300" });
		assert.deepEqual(calls[0], { command: "ok", cwd: "/r", timeout: 600 });
	} finally {
		seam.exec = exec;
	}
});

test("runCheck does not run a command the sandbox would ask about", async () => {
	const exec = seam.exec;
	let ran = false;
	try {
		seam.exec = async () => ((ran = true), { exitCode: 0 });
		for (const c of ["rm -rf ./scratch", "git push origin main", "sudo ls"]) {
			const r = await runCheck(c, "/r");
			assert.equal(r.ok, false);
			assert.match(r.tail, /^not run: /);
		}
		assert.equal(ran, false);
	} finally {
		seam.exec = exec;
	}
});
