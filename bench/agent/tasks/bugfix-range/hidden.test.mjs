import assert from "node:assert/strict";
import { test } from "node:test";
import { pages } from "./src/pages.mjs";
import { range } from "./src/range.mjs";

test("hidden: range includes start and excludes end", () => {
	assert.deepEqual(range(0, 3), [0, 1, 2]);
	assert.deepEqual(range(2, 5), [2, 3, 4]);
	assert.deepEqual(range(-1, 1), [-1, 0]);
	assert.deepEqual(range(7, 8), [7]);
	assert.deepEqual(range(3, 3), []);
	assert.deepEqual(range(5, 2), []);
	assert.deepEqual(pages(3), [1, 2, 3]);
});
