// The review gate's own eval, with no implementer agent: each task's reference solution (`full`) and each
// omission variant (the solution with one stated rule dropped) is committed on top of its fixture and handed
// to the reviewer with the gate's exact task text. See README.md.
// Run: node --import ./extensions/test-hooks.ts bench/agent/gate-eval.ts --dry
//      node --import ./extensions/test-hooks.ts bench/agent/gate-eval.ts --label <name> [--repeat N] [--filter s]
//      node --import ./extensions/test-hooks.ts bench/agent/gate-eval.ts --report [--label <name>]
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { lintPlan, parsePlan } from "../../extensions/checks.ts";
import { parseVerdict, reviewTask, snapshot } from "../../extensions/review-gate.ts";
import { discoverAgents } from "../../extensions/subagent/agents.ts";
import { getResultOutput, isFailedResult, runSingleAgent } from "../../extensions/subagent/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS = join(HERE, "tasks");
const RESULTS = join(HERE, "gate-results");
const USAGE = "usage: gate-eval.ts --dry | --label <name> [--repeat N] [--filter s] | --report [--label <name>]";

let args;
try {
	args = parseArgs({ options: { dry: { type: "boolean", default: false }, report: { type: "boolean", default: false }, label: { type: "string" }, repeat: { type: "string", default: "1" }, filter: { type: "string" } } }).values;
} catch {
	console.error(USAGE);
	process.exit(2);
}
const repeat = Number(args.repeat);
if ((args.dry && args.report) || (args.label !== undefined && !/^[\w.-]+$/.test(args.label)) || !Number.isInteger(repeat) || repeat < 1 || (!args.dry && !args.report && !args.label)) {
	console.error(USAGE);
	process.exit(2);
}

// Duplicated from run.ts, which runs on import.
const nodeTest = (cwd: string, ...files: string[]) => spawnSync(process.execPath, ["--test", ...files], { cwd, encoding: "utf8", timeout: 120_000 });
const ran = (r: ReturnType<typeof nodeTest>) => (r.error || r.signal ? ` (${r.error?.message ?? r.signal})` : "");

const tasks = readdirSync(TASKS)
	.filter((id) => existsSync(join(TASKS, id, "omit")) && (!args.filter || id.includes(args.filter)))
	.sort();
const variants = (id: string) => ["full", ...readdirSync(join(TASKS, id, "omit")).sort()];
// The gate eval's behavior-only plan when there is one, else the task's own.
const planText = (id: string) => {
	for (const f of ["gate-plan.md", "plan.md"]) if (existsSync(join(TASKS, id, f))) return readFileSync(join(TASKS, id, f), "utf8");
	return undefined;
};

// The fixture committed as `base`, then the solution and the variant on top, uncommitted; the plan untracked with every step ticked.
function build(id: string, variant: string) {
	const cwd = mkdtempSync(join(tmpdir(), `gate-eval-${id}-${variant}-`));
	cpSync(join(TASKS, id, "repo"), cwd, { recursive: true });
	const git = (...a: string[]) => {
		const r = spawnSync("git", a, { cwd, encoding: "utf8" });
		if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed in ${cwd}: ${r.error?.message ?? r.stderr}`);
		return r.stdout.trim();
	};
	git("init", "-q");
	git("add", ".");
	git("-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "fixture");
	const base = git("rev-parse", "HEAD");
	cpSync(join(TASKS, id, "solution"), cwd, { recursive: true });
	if (variant !== "full") cpSync(join(TASKS, id, "omit", variant), cwd, { recursive: true });
	const raw = planText(id);
	let plan: string | undefined;
	let text: string | undefined;
	if (raw !== undefined) {
		text = raw.replace(/^(\s*[-*] )\[ \]/gm, "$1[x]");
		plan = `docs/plans/${id}.md`;
		mkdirSync(join(cwd, "docs/plans"), { recursive: true });
		writeFileSync(join(cwd, plan), text);
	}
	return { cwd, base, plan, text, requirements: text !== undefined && parsePlan(text).requirements.length > 0 };
}

if (args.dry) {
	let failed = false;
	for (const id of tasks) {
		for (const variant of variants(id)) {
			const { cwd, text } = build(id, variant);
			const problems: string[] = [];
			const visible = nodeTest(cwd);
			if (visible.status !== 0) problems.push(`the visible tests fail${ran(visible)}`);
			if (text !== undefined) problems.push(...lintPlan(cwd, text).map((p) => `plan: ${p}`));
			copyFileSync(join(TASKS, id, "hidden.test.mjs"), join(cwd, "hidden.test.mjs"));
			const hidden = nodeTest(cwd, "hidden.test.mjs");
			if (hidden.error || hidden.signal) problems.push(`the hidden test did not run${ran(hidden)}`);
			else if (variant === "full" && hidden.status !== 0) problems.push("the solution fails the hidden test");
			else if (variant !== "full" && hidden.status === 0) problems.push("the omission passes the hidden test");
			console.log(problems.length ? `FAIL ${id}/${variant}: ${problems.join("; ")}` : `OK ${id}/${variant}`);
			failed ||= problems.length > 0;
		}
	}
	process.exit(failed ? 1 : 0);
}

type Result = { label: string; task: string; variant: string; run: number; decision: "ALLOW" | "BLOCK" | "NONE"; reason?: string; model?: string; cost: number; durationMs: number; output: string; bash: string[]; repoChanged: boolean };

if (args.report) {
	const labels = existsSync(RESULTS) ? readdirSync(RESULTS).filter((l) => !args.label || l === args.label).sort() : [];
	const results: Result[] = labels.flatMap((l) =>
		readdirSync(join(RESULTS, l))
			.filter((f) => f.endsWith(".json"))
			.map((f) => JSON.parse(readFileSync(join(RESULTS, l, f), "utf8"))),
	);
	if (!results.length) {
		console.log("no results");
		process.exit(0);
	}
	const rate = (rs: Result[]) => {
		const n = rs.filter((r) => r.decision === "BLOCK").length;
		return rs.length ? `${n}/${rs.length} (${Math.round((100 * n) / rs.length)}%)` : "-";
	};
	console.log("| label | omission runs | recall | full runs | false block | no verdict | cost |\n|---|---|---|---|---|---|---|");
	for (const l of labels) {
		const rs = results.filter((r) => r.label === l);
		if (!rs.length) continue;
		const omit = rs.filter((r) => r.variant !== "full");
		const full = rs.filter((r) => r.variant === "full");
		const none = rs.filter((r) => r.decision === "NONE").length;
		const cost = rs.reduce((s, r) => s + (r.cost ?? 0), 0);
		console.log(`| ${l} | ${omit.length} | ${rate(omit)} | ${full.length} | ${rate(full)} | ${none}/${rs.length} | $${cost.toFixed(2)} |`);
	}
	console.log("\n| label | task | variant | BLOCK / runs |\n|---|---|---|---|");
	const keys = [...new Set(results.map((r) => `${r.label}\0${r.task}\0${r.variant}`))].sort();
	for (const k of keys) {
		const [l, t, v] = k.split("\0");
		const rs = results.filter((r) => r.label === l && r.task === t && r.variant === v);
		console.log(`| ${l} | ${t} | ${v} | ${rs.filter((r) => r.decision === "BLOCK").length} / ${rs.length} |`);
	}
	process.exit(0);
}

const label = args.label!;
mkdirSync(join(RESULTS, label), { recursive: true });
// runSingleAgent starts argv[1] as pi when that file exists; this script is not pi, so it falls back to `pi` on PATH.
process.argv[1] = "";
let errors = 0;
for (const id of tasks) {
	const message = readFileSync(join(TASKS, id, "task.md"), "utf8");
	for (const variant of variants(id)) {
		for (let n = 1; n <= repeat; n++) {
			const out = join(RESULTS, label, `${id}__${variant}__r${n}.json`);
			if (existsSync(out)) continue;
			const { cwd, base, plan, requirements } = build(id, variant);
			const before = snapshot(cwd);
			const reviewPrompt = reviewTask({ base, messages: [{ role: "user", content: message, timestamp: 0 }], since: 0, summary: "Done. All tests pass.", plan, requirements });
			console.log(`${id}/${variant} r${n} (${label}) in ${cwd}`);
			const started = Date.now();
			try {
				const result = await runSingleAgent(cwd, {}, discoverAgents(cwd, "user").agents, "reviewer", reviewPrompt, undefined, undefined, AbortSignal.timeout(10 * 60_000), undefined, (results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }));
				if (isFailedResult(result)) throw new Error(`reviewer failed (exit ${result.exitCode}, ${result.stopReason ?? "no stop reason"}): ${getResultOutput(result).trim().slice(0, 500)}`);
				const output = getResultOutput(result).trim();
				const v = parseVerdict(output);
				const r: Result = { label, task: id, variant, run: n, decision: v?.decision ?? "NONE", reason: v?.reason, model: result.model, cost: result.usage.cost, durationMs: Date.now() - started, output, bash: result.messages.flatMap((m) => (m.role === "assistant" ? m.content.flatMap((c) => (c.type === "toolCall" && c.name === "bash" ? [String(c.arguments.command)] : [])) : [])), repoChanged: snapshot(cwd) !== before };
				writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
				console.log(`  ${r.decision}${r.reason ? `: ${r.reason}` : ""}`);
			} catch (e) {
				errors++;
				console.error(`  ERROR ${(e as Error).message}\n  (kept ${cwd})`);
			}
		}
	}
}
process.exit(errors ? 1 : 0);
