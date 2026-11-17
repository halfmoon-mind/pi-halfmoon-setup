import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, loadConfig } from "./src/config.mjs";
import { deepMerge } from "./src/merge.mjs";

test("hidden: nested objects merge, arrays and null replace", () => {
	const base = { a: { b: 1, c: { d: 2 } }, list: [1, 2], keep: "k", obj: { x: 1 } };
	const over = { a: { c: { e: 3 } }, list: [9], obj: null };
	const merged = deepMerge(base, over);
	assert.deepEqual(merged, { a: { b: 1, c: { d: 2, e: 3 } }, list: [9], keep: "k", obj: null });
	assert.notEqual(merged.list, over.list, "an array is copied");
	assert.deepEqual(base, { a: { b: 1, c: { d: 2 } }, list: [1, 2], keep: "k", obj: { x: 1 } }, "base unchanged");
	assert.deepEqual(over, { a: { c: { e: 3 } }, list: [9], obj: null }, "override unchanged");
	assert.deepEqual(deepMerge({ a: [1] }, { a: { b: 1 } }), { a: { b: 1 } });
	assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: [2] }), { a: [2] });
});

test("hidden: loadConfig deep-merges over the defaults", () => {
	const config = loadConfig(DEFAULTS, { server: { port: 1 }, tags: ["api"] });
	assert.deepEqual(config, { server: { host: "localhost", port: 1 }, tags: ["api"], debug: false });
	assert.deepEqual(DEFAULTS, { server: { host: "localhost", port: 8080 }, tags: ["web"], debug: false });
	assert.deepEqual(loadConfig(DEFAULTS), DEFAULTS);
});
