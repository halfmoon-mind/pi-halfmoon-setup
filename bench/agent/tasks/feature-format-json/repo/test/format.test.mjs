import assert from "node:assert/strict";
import { test } from "node:test";
import { format } from "../src/format.mjs";

test("rows print as name: value lines", () => {
	const rows = [{ name: "a", value: 1 }, { name: "b", value: "x" }];
	assert.equal(format(rows), "a: 1\nb: x");
	assert.equal(format(rows, { as: "text" }), "a: 1\nb: x");
});
