/**
 * Plan files in the handoff step format, and running their checks. Each step's checkbox line ends with
 * ``- files: a.ts, b.ts (new) - check: `cmd` ``, and `## Success criteria` lists `` - `cmd` `` lines.
 * handoff lints a plan before building it; the review gate runs ticked steps' checks and the criteria.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { sandboxedBash } from "./sandbox/index.ts";
import { risky } from "./sandbox/policy.ts";

const TAIL = 2000;
const NEW = / \(new\)$/;

/** Sessions whose settles the harness gates: interactive ones, and print mode under the eval (PI_EVAL=1). Never json (subagents). */
export const gated = (mode: string) => mode === "tui" || (mode === "print" && process.env.PI_EVAL === "1");

export type Step = { n: number; done: boolean; files: string[]; check?: string };
/** A `## Requirements` line: `- R1. "<quote>" — src: <where> - step: 2, 3` or `… - out: <reason, who agreed>`. */
export type Requirement = { id: string; steps: number[]; out?: string };
/** An `## Assumptions` line: `- A1. <assumption> — checked: <file:line>[, …]`, `… — agreed: <who, date>` or `… — unchecked: <why>`. No valid ending (or a citation that is not file:line) leaves all empty. */
export type Assumption = { id: string; checked: string[]; agreed?: string; unchecked?: string };

export function parsePlan(text: string): { steps: Step[]; criteria: string[]; requirements: Requirement[]; sources: string[]; assumptions: Assumption[] } {
	const steps: Step[] = [];
	const criteria: string[] = [];
	const requirements: Requirement[] = [];
	const sources: string[] = [];
	const assumptions: Assumption[] = [];
	let section = "";
	for (const line of text.split("\n")) {
		if (/^#/.test(line)) section = line.match(/^##\s+(.*?)\s*$/)?.[1].toLowerCase() ?? "";
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
		} else if (section === "success criteria") {
			// ponytail: a command containing a backtick cannot be written.
			const c = line.match(/^\s*- `([^`]+)`\s*$/)?.[1];
			if (c) criteria.push(c);
		} else if (section === "sources") {
			const s = line.match(/^\s*- (.+?)\s*$/)?.[1];
			if (s) sources.push(s);
		} else if (section === "requirements") {
			const id = line.match(/^\s*- (R\d+)\. /)?.[1];
			if (!id) continue;
			const ns = line.match(/ - step: (\d+(?:\s*,\s*\d+)*)\s*$/)?.[1];
			const out = line.match(/ - out: (.+?)\s*$/)?.[1];
			requirements.push({ id, steps: ns ? ns.split(",").map(Number) : [], ...(out ? { out } : {}) });
		} else if (section === "assumptions") {
			const id = line.match(/^\s*- (A\d+)\. /)?.[1];
			if (!id) continue;
			const m = line.match(/\s[—-]\s+(checked|agreed|unchecked):\s*(.+?)\s*$/);
			const cites = m?.[1] === "checked" ? m[2]!.split(",").map((s) => s.trim()) : [];
			assumptions.push({ id, checked: cites.every((c) => /^\S+:\d+(?:-\d+)?$/.test(c)) ? cites : [], ...(m?.[1] === "agreed" ? { agreed: m[2] } : {}), ...(m?.[1] === "unchecked" ? { unchecked: m[2] } : {}) });
		}
	}
	return { steps, criteria, requirements, sources, assumptions };
}

/** What keeps a plan from the step format, or [] when it is clean. */
export function lintPlan(cwd: string, text: string): string[] {
	const { steps, criteria, requirements, sources, assumptions } = parsePlan(text);
	const problems: string[] = [];
	if (!steps.length) problems.push("no steps: each step is one line like `- [ ] 1. <what> - files: a.ts - check: `<command>``");
	for (const s of steps) {
		if (!s.check) problems.push(`step ${s.n} has no check`);
		if (!s.files.length) problems.push(`step ${s.n} lists no files`);
		// A path marked new may exist already (a re-lint after building); directories count.
		for (const f of s.files) if (!NEW.test(f) && !existsSync(resolve(cwd, f))) problems.push(`step ${s.n}: ${f} does not exist (mark a new file \`${f} (new)\`)`);
	}
	if (!criteria.length) problems.push("no success criteria commands");
	// Requirements trace their sources to steps; a plan with neither section lints as before.
	if (sources.length && !requirements.length) problems.push('## Sources lists documents but ## Requirements has no `- R1. "<quote>" — src: <where> - step: N` lines');
	if (requirements.length && !sources.length) problems.push("## Requirements has lines but ## Sources lists no documents");
	const numbers = new Set(steps.map((s) => s.n));
	for (const r of requirements) {
		if (!r.steps.length && !r.out) problems.push(`${r.id} maps to no step (end it with - step: N or - out: <reason>)`);
		// `out:` means the user agreed, and the review gate skips it; an open question is not that yet.
		if (r.out && /\bunconfirmed\b/i.test(r.out)) problems.push(`${r.id} is unconfirmed: ask the user, then end it with - step: N or - out: <their answer>`);
		for (const n of r.steps) if (!numbers.has(n)) problems.push(`${r.id} maps to step ${n}, which does not exist`);
	}
	// Optional: the bench fixture plans have none. An unchecked one is what the plan builds on without knowing, so it is refused like `unconfirmed`.
	for (const a of assumptions) {
		if (a.unchecked !== undefined) problems.push(`${a.id} is unchecked (${a.unchecked}): check it against the code and end it — checked: <file:line>, or ask the user and end it — agreed: <who, date> or change the plan`);
		else if (!a.checked.length && a.agreed === undefined) problems.push(`${a.id} must end — checked: <file:line>[, …], — agreed: <who, date> or — unchecked: <why>`);
	}
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
