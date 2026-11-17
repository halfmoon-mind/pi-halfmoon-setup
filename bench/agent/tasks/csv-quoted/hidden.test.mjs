import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv } from "./src/csv.mjs";

test("hidden: quoted fields", () => {
	assert.deepEqual(parseCsv('a,"b,c",d'), [["a", "b,c", "d"]]);
	assert.deepEqual(parseCsv('"say ""hi"""'), [['say "hi"']]);
	assert.deepEqual(parseCsv('"two\nlines",x\ny,z'), [["two\nlines", "x"], ["y", "z"]]);
	assert.deepEqual(parseCsv('"a\r\nb"'), [["a\r\nb"]]);
	assert.deepEqual(parseCsv('""'), [[""]]);
});

test("hidden: rows and empty fields", () => {
	assert.deepEqual(parseCsv("a,b\r\nc,d\r\n"), [["a", "b"], ["c", "d"]]);
	assert.deepEqual(parseCsv("a\n"), [["a"]]);
	assert.deepEqual(parseCsv("a\n\n"), [["a"], [""]]);
	assert.deepEqual(parseCsv(""), []);
	assert.deepEqual(parseCsv("a,,b\nc,"), [["a", "", "b"], ["c", ""]]);
	assert.deepEqual(parseCsv("a\n\nb"), [["a"], [""], ["b"]]);
});

test("hidden: bad quotes throw", () => {
	for (const text of ['"abc', '"a"b']) assert.throws(() => parseCsv(text), Error, JSON.stringify(text));
});
