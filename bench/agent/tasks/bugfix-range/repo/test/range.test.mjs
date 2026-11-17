import assert from "node:assert/strict";
import { test } from "node:test";
import { range } from "../src/range.mjs";

test("an empty range is empty", () => {
	assert.deepEqual(range(4, 4), []);
	assert.deepEqual(range(5, 2), []);
});
