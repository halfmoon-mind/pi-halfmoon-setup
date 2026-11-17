import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeCell, toCsv } from "./src/csv.mjs";
import { exportRecords } from "./src/export.mjs";

test("hidden: escapeCell quotes only when needed", () => {
	assert.equal(escapeCell("plain"), "plain");
	assert.equal(escapeCell(42), "42");
	assert.equal(escapeCell(null), "");
	assert.equal(escapeCell(undefined), "");
	assert.equal(escapeCell("a,b"), '"a,b"');
	assert.equal(escapeCell('say "hi"'), '"say ""hi"""');
	assert.equal(escapeCell("two\nlines"), '"two\nlines"');
	assert.equal(escapeCell("cr\rhere"), '"cr\rhere"');
});

test("hidden: toCsv writes a header and one line per record", () => {
	assert.equal(toCsv([{ a: 1, b: "x,y" }, { a: 2 }], ["a", "b"]), 'a,b\n1,"x,y"\n2,');
	assert.equal(toCsv([], ["a", "b"]), "a,b");
});

test("hidden: exportRecords supports csv and keeps json", () => {
	const records = [{ name: "Ann", note: 'said "ok"' }, { name: "Bo", note: "" }];
	assert.equal(exportRecords(records, { format: "csv" }), 'name,note\nAnn,"said ""ok"""\nBo,');
	assert.equal(exportRecords(records, { format: "csv", columns: ["note"] }), 'note\n"said ""ok"""\n');
	assert.equal(exportRecords([], { format: "csv" }), "");
	assert.equal(exportRecords([{ a: 1 }]), '[{"a":1}]');
	assert.throws(() => exportRecords([], { format: "xml" }), /unknown format: xml/);
});
