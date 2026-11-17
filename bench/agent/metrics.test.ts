// Run: node --test bench/agent/metrics.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { metrics } from "./metrics.ts";

const session = (...lines: unknown[]) => {
	const dir = mkdtempSync(join(tmpdir(), "bench-metrics-"));
	mkdirSync(join(dir, "s"));
	writeFileSync(join(dir, "s", "x.jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
	return dir;
};
const tool = (toolName: string, isError: boolean) => ({ type: "message", message: { role: "toolResult", toolName, isError } });
const reply = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } };

test("a well-formed session gives its counts and final reply", () => {
	const m = metrics(
		session(
			{ type: "session" },
			tool("edit", true),
			tool("bash", true),
			tool("read", false),
			{ type: "custom", customType: "review-gate", data: { verdict: "NONE" } },
			{ type: "custom", customType: "review-gate", data: { verdict: "ALLOW: ok" } },
			{ type: "custom", customType: "plan-checks", data: { results: [{ ok: false }, { ok: true }] } },
			reply,
		),
	);
	assert.deepEqual(m, { toolErrors: 2, editErrors: 1, verdicts: 2, verdictNone: 1, checkRounds: 1, checkFailures: 1, final: "Done." });
});

test("malformed session data is a run error, not zeros", () => {
	const cases: [unknown[], RegExp][] = [
		[[{ type: "custom", customType: "review-gate", data: {} }, reply], /line 1: a review-gate entry without a valid verdict/],
		[[{ type: "custom", customType: "review-gate", data: { verdict: "" } }, reply], /without a valid verdict/],
		[[{ type: "custom", customType: "review-gate", data: { verdict: "maybe" } }, reply], /without a valid verdict/],
		[[{ type: "custom", customType: "plan-checks", data: {} }, reply], /line 1: a plan-checks entry without results/],
		[[{ type: "custom", customType: "plan-checks", data: { results: [{}] } }, reply], /plan-checks entry without results/],
		[[{ type: "message", message: { role: "toolResult" } }, reply], /line 1: a tool result without isError/],
		[[{ type: "message", message: { role: "assistant" } }], /line 1: the last assistant message has no valid content/],
		[[{ type: "message", message: { role: "assistant", content: [{ type: "text", text: 123 }] } }], /no valid content/],
		[[{ type: "message", message: { role: "assistant", content: [null] } }], /no valid content/],
		[[tool("read", false)], /no assistant message/],
		[["{not json", reply], /line 1 is not a JSON object/],
		[["null", reply], /line 1 is not a JSON object/],
	];
	for (const [lines, error] of cases) assert.throws(() => metrics(session(...lines)), error);
	assert.throws(() => metrics(join(tmpdir(), "no-such-bench-sessions")), /found 0/);
});
