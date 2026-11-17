import assert from "node:assert/strict";
import { test } from "node:test";
import { exportRecords } from "../src/export.mjs";

test("json is the default format", () => {
	assert.equal(exportRecords([{ a: 1 }]), '[{"a":1}]');
	assert.throws(() => exportRecords([], { format: "xml" }), /unknown format: xml/);
});
