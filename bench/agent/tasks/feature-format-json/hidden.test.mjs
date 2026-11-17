import assert from "node:assert/strict";
import { test } from "node:test";
import { format } from "./src/format.mjs";

const rows = [{ name: "a", value: 1 }, { name: "b", value: "x" }, { name: "a", value: true }];

test("hidden: json maps names to values, 2-space indented", () => {
	assert.equal(format(rows, { as: "json" }), JSON.stringify({ a: true, b: "x" }, null, 2));
	assert.equal(format([], { as: "json" }), "{}");
});

test("hidden: text stays the default", () => {
	assert.equal(format(rows.slice(0, 2)), "a: 1\nb: x");
	assert.equal(format(rows.slice(0, 2), { as: "text" }), "a: 1\nb: x");
});

test("hidden: an unknown format throws", () => {
	assert.throws(() => format(rows, { as: "xml" }), { message: "unknown format: xml" });
});
