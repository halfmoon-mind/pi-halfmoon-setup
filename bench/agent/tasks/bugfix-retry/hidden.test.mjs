import assert from "node:assert/strict";
import { test } from "node:test";
import { retry } from "./src/retry.mjs";

test("hidden: a rejecting async fn is retried", async () => {
	let calls = 0;
	const value = await retry(async () => {
		if (++calls < 3) throw new Error(`fail ${calls}`);
		return "ok";
	});
	assert.equal(value, "ok");
	assert.equal(calls, 3);
});

test("hidden: the last error rejects after the last attempt", async () => {
	let calls = 0;
	await assert.rejects(
		retry(async () => {
			throw new Error(`fail ${++calls}`);
		}, 4),
		/fail 4/,
	);
	assert.equal(calls, 4);
});

test("hidden: a sync throw is still retried", async () => {
	let calls = 0;
	await assert.rejects(
		retry(() => {
			throw new Error(`fail ${++calls}`);
		}),
		/fail 3/,
	);
	assert.equal(calls, 3);
});
