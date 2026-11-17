// One markdown row per model × arm from results/*.json. Run: node bench/agent/report.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), "results");
const files = existsSync(RESULTS) ? readdirSync(RESULTS).filter((f) => f.endsWith(".json")) : [];
if (!files.length) {
	console.log("no results");
	process.exit(0);
}

const groups = new Map<string, any[]>();
for (const f of files) {
	const r = JSON.parse(readFileSync(join(RESULTS, f), "utf8"));
	const key = `${r.model} | ${r.arm}`;
	groups.set(key, [...(groups.get(key) ?? []), r]);
}
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const per = (n: number, d: number) => (n / d).toFixed(2);
const sum = (rs: any[], k: string) => rs.reduce((n, r) => n + (r[k] ?? 0), 0);

console.log("| model | arm | runs | pass | false done | verdict compliance | edit errors/run | check rounds/run |");
console.log("|---|---|---|---|---|---|---|---|");
for (const [key, rs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
	const verdicts = sum(rs, "verdicts");
	const cells = [rs.length, pct(rs.filter((r) => r.pass).length, rs.length), pct(rs.filter((r) => r.falseDone).length, rs.length), pct(verdicts - sum(rs, "verdictNone"), verdicts), per(sum(rs, "editErrors"), rs.length), per(sum(rs, "checkRounds"), rs.length)];
	console.log(`| ${key} | ${cells.join(" | ")} |`);
}
