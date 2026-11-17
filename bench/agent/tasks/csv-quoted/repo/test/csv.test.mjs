import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv } from "../src/csv.mjs";

test("a header and a quoted field", () => {
	assert.deepEqual(parseCsv('name,age\n"Ann",30'), [["name", "age"], ["Ann", "30"]]);
});
