/**
 * Plan files in the handoff step format, and running their checks. Each step's checkbox line ends with
 * ``- files: a.ts, b.ts (new) - check: `cmd` ``, and `## Success criteria` lists `` - `cmd` `` lines.
 * handoff lints a plan before building it; the review gate runs ticked steps' checks and the criteria.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { risky, sandboxedBash } from "./sandbox.ts";

const TAIL = 2000;
const NEW = / \(new\)$/;

/** Sessions whose settles the harness gates: interactive ones, and print mode under the eval (PI_EVAL=1). Never json (subagents). */
export const gated = (mode: string) => mode === "tui" || (mode === "print" && process.env.PI_EVAL === "1");

export type Step = { n: number; done: boolean; files: string[]; check?: string };

export function parsePlan(text: string): { steps: Step[]; criteria: string[] } {
	const steps: Step[] = [];
	const criteria: string[] = [];
	let inCriteria = false;
	for (const line of text.split("\n")) {
		if (/^#/.test(line)) inCriteria = /^##\s+Success criteria\s*$/i.test(line);
		const m = line.match(/^\s*[-*] \[( |x|X)\] (\d+)\. /);
		if (m) {
			// Metadata lives on the checkbox line only; prose on later lines never supplies it.
			const files = line.match(/ - files: (.*?)(?: - check:|$)/)?.[1];
			const check = line.match(/ - check: `([^`]+)`/)?.[1];
			steps.push({
				n: Number(m[2]),
				done: m[1] !== " ",
				files: (files ?? "").split(",").map((f) => f.trim().replace(/`/g, "")).filter(Boolean),
				...(check ? { check } : {}),
			});
		} else if (inCriteria) {
			// ponytail: a command containing a backtick cannot be written.
			const c = line.match(/^\s*- `([^`]+)`\s*$/)?.[1];
			if (c) criteria.push(c);
		}
	}
	return { steps, criteria };
}

/** What keeps a plan from the step format, or [] when it is clean. */
export function lintPlan(cwd: string, text: string): string[] {
	const { steps, criteria } = parsePlan(text);
	const problems: string[] = [];
	if (!steps.length) problems.push("no steps: each step is one line like `- [ ] 1. <what> - files: a.ts - check: `<command>``");
	for (const s of steps) {
		if (!s.check) problems.push(`step ${s.n} has no check`);
		if (!s.files.length) problems.push(`step ${s.n} lists no files`);
		// A path marked new may exist already (a re-lint after building); directories count.
		for (const f of s.files) if (!NEW.test(f) && !existsSync(resolve(cwd, f))) problems.push(`step ${s.n}: ${f} does not exist (mark a new file \`${f} (new)\`)`);
	}
	if (!criteria.length) problems.push("no success criteria commands");
	return problems;
}

/** Test seam: how a check runs (pi's sandboxed bash). */
export const seam = { exec: sandboxedBash.exec };

export type CheckResult = { command: string; ok: boolean; exitCode: number | null; tail: string };

/** Runs one check command; a throw (sandbox down, `timeout:600`) is a failure with its message as the tail. */
export async function runCheck(command: string, cwd: string, signal?: AbortSignal): Promise<CheckResult> {
	let out = "";
	const r = risky("bash", { command }, cwd); // the tool_call hook's confirmation does not see harness runs; with no one to ask, a risky check is not run
	if (r) return { command, ok: false, exitCode: null, tail: `not run: ${r}, which needs the user's confirmation` };
	try {
		const { exitCode } = await seam.exec(command, cwd, { onData: (d) => (out = (out + d.toString()).slice(-TAIL)), signal, timeout: 600 });
		return { command, ok: exitCode === 0, exitCode, tail: out };
	} catch (e) {
		return { command, ok: false, exitCode: null, tail: (e instanceof Error ? e.message : String(e)).slice(-TAIL) };
	}
}
