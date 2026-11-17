import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLimit } from "../src/pool.mjs";

test("maps every item", async () => {
	assert.deepEqual(await mapLimit([1, 2, 3], 2, async (x) => x * 2), [2, 4, 6]);
});
