// The session's metrics for one bench run. Missing or malformed data throws, so it is a run error and
// never zeros or a 100% verdict compliance.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Entry = { type?: unknown; customType?: unknown; data?: any; message?: any };

export function metrics(sessions: string) {
	const files = existsSync(sessions) ? readdirSync(sessions, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".jsonl")) : [];
	if (files.length !== 1) throw new Error(`expected one session file in ${sessions}, found ${files.length}`);
	const entries: [Entry, number][] = readFileSync(join(sessions, files[0]!), "utf8")
		.split("\n")
		.flatMap((l, i) => (l.trim() ? [[l, i + 1] as const] : []))
		.map(([l, n]) => {
			try {
				const e = JSON.parse(l);
				if (typeof e !== "object" || e === null) throw 0;
				return [e, n];
			} catch {
				throw new Error(`session line ${n} is not a JSON object`);
			}
		});
	const bad = (n: number, why: string) => {
		throw new Error(`session line ${n}: ${why}`);
	};
	const message = (role: string) => entries.filter(([e]) => e.type === "message" && e.message?.role === role);
	const custom = (t: string) => entries.filter(([e]) => e.type === "custom" && e.customType === t);

	const results = message("toolResult");
	for (const [e, n] of results) if (typeof e.message.isError !== "boolean" || typeof e.message.toolName !== "string") bad(n, "a tool result without isError or toolName");
	const verdicts = custom("review-gate");
	// What review-gate.ts writes: NONE, or the decision and its reason.
	for (const [e, n] of verdicts) if (typeof e.data?.verdict !== "string" || !/^(NONE$|ALLOW: |BLOCK: )/.test(e.data.verdict)) bad(n, "a review-gate entry without a valid verdict");
	const checks = custom("plan-checks");
	for (const [e, n] of checks) if (!Array.isArray(e.data?.results) || !e.data.results.every((r: any) => typeof r?.ok === "boolean")) bad(n, "a plan-checks entry without results");
	const last = message("assistant").at(-1);
	if (!last) throw new Error("the session has no assistant message");
	const content = last[0].message.content;
	if (typeof content !== "string" && !(Array.isArray(content) && content.every((c: any) => typeof c === "object" && c !== null && (c.type !== "text" || typeof c.text === "string"))))
		bad(last[1], "the last assistant message has no valid content");

	return {
		toolErrors: results.filter(([e]) => e.message.isError).length,
		editErrors: results.filter(([e]) => e.message.isError && e.message.toolName === "edit").length,
		verdicts: verdicts.length,
		verdictNone: verdicts.filter(([e]) => e.data.verdict === "NONE").length,
		checkRounds: checks.length,
		checkFailures: checks.reduce((sum, [e]) => sum + e.data.results.filter((r: any) => !r.ok).length, 0),
		final: typeof content === "string" ? content : content.flatMap((c: any) => (c.type === "text" ? [c.text] : [])).join("\n"),
	};
}
