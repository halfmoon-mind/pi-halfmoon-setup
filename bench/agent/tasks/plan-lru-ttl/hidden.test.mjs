import assert from "node:assert/strict";
import { test } from "node:test";
import { Cache } from "./src/cache.mjs";

test("hidden: a bad max or ttlMs throws a RangeError", () => {
	for (const max of [0, 1.5, undefined]) assert.throws(() => new Cache({ max }), RangeError, String(max));
	assert.throws(() => new Cache(), RangeError);
	assert.throws(() => new Cache({ max: 2, ttlMs: 0 }), RangeError);
});

test("hidden: a full cache evicts the least recently used entry", () => {
	const byGet = new Cache({ max: 2 }).set("a", 1).set("b", 2);
	byGet.get("a");
	byGet.set("c", 3);
	assert.deepEqual([byGet.has("a"), byGet.has("b"), byGet.has("c")], [true, false, true], "get saves a");

	const bySet = new Cache({ max: 2 }).set("a", 1).set("b", 2).set("a", 10).set("c", 3);
	assert.deepEqual([bySet.get("a"), bySet.has("b"), bySet.has("c")], [10, false, true], "a re-set saves a");

	const byHas = new Cache({ max: 2 }).set("a", 1).set("b", 2);
	byHas.has("a");
	byHas.set("c", 3);
	assert.deepEqual([byHas.has("a"), byHas.has("b"), byHas.has("c")], [false, true, true], "has does not save a");
});

test("hidden: entries expire, get does not extend, set resets", () => {
	let t = 0;
	const now = () => t;
	const cache = new Cache({ max: 10, ttlMs: 100, now }).set("a", 1);
	t = 99;
	assert.equal(cache.has("a"), true);
	t = 100;
	assert.equal(cache.has("a"), false);
	assert.equal(cache.get("a"), undefined);

	t = 0;
	const read = new Cache({ max: 10, ttlMs: 100, now }).set("a", 1);
	t = 50;
	assert.equal(read.get("a"), 1);
	t = 100;
	assert.equal(read.get("a"), undefined, "a get at 50 does not extend");

	t = 0;
	const reset = new Cache({ max: 10, ttlMs: 100, now }).set("a", 1);
	t = 50;
	reset.set("a", 2);
	t = 120;
	assert.equal(reset.get("a"), 2);
	t = 150;
	assert.equal(reset.has("a"), false);
});

test("hidden: size and eviction skip expired entries", () => {
	let t = 0;
	const now = () => t;
	const cache = new Cache({ max: 10, ttlMs: 100, now }).set("a", 1);
	t = 50;
	cache.set("b", 2);
	t = 100;
	assert.equal(cache.size, 1);
	t = 150;
	assert.equal(cache.size, 0);

	t = 0;
	const full = new Cache({ max: 2, ttlMs: 100, now }).set("a", 1);
	t = 60;
	full.set("b", 2);
	t = 70;
	full.get("a");
	t = 100;
	full.set("c", 3);
	assert.deepEqual([full.get("b"), full.get("c")], [2, 3], "the expired a goes, not the live b");
	assert.equal(full.size, 2);
});

test("hidden: without ttlMs entries never expire", () => {
	let t = 0;
	const cache = new Cache({ max: 10, now: () => t }).set("a", 1);
	t = 1e12;
	assert.equal(cache.get("a"), 1);
});
