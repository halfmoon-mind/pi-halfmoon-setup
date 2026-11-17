import assert from "node:assert/strict";
import { test } from "node:test";
import { Cache } from "../src/cache.mjs";

test("set, get, has and size", () => {
	const cache = new Cache({ max: 10 });
	assert.equal(cache.set("a", 1), cache);
	cache.set("b", 2);
	assert.equal(cache.get("a"), 1);
	assert.equal(cache.has("b"), true);
	assert.equal(cache.has("c"), false);
	assert.equal(cache.get("c"), undefined);
	assert.equal(cache.size, 2);
});
