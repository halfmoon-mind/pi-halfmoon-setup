import assert from "node:assert/strict";
import { test } from "node:test";
import { retry } from "../src/retry.mjs";

test("a throwing fn is retried until it succeeds", async () => {
	let calls = 0;
	const value = await retry(() => {
		if (++calls < 3) throw new Error(`fail ${calls}`);
		return "ok";
	});
	assert.equal(value, "ok");
	assert.equal(calls, 3);
});
