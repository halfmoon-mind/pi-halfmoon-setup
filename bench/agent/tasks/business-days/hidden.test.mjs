import assert from "node:assert/strict";
import { test } from "node:test";
import { addBusinessDays } from "./src/days.mjs";

const d = (s) => new Date(`${s}T00:00:00Z`);
const day = (date, n, holidays) => addBusinessDays(d(date), n, holidays).toISOString().slice(0, 10);

test("hidden: holidays are skipped", () => {
	assert.equal(day("2026-11-20", 1, ["2026-11-23"]), "2026-11-24");
	assert.equal(day("2026-11-26", 5, ["2026-11-27"]), "2026-12-04");
});

test("hidden: a negative n counts backward", () => {
	assert.equal(day("2026-11-23", -1), "2026-11-20");
	assert.equal(day("2026-11-24", -2, ["2026-11-20"]), "2026-11-19");
});

test("hidden: n = 0", () => {
	assert.equal(day("2026-11-18", 0), "2026-11-18");
	assert.equal(day("2026-11-21", 0), "2026-11-23");
	assert.equal(day("2026-11-21", 0, ["2026-11-23"]), "2026-11-24");
});

test("hidden: keeps the time of day, returns a new Date", () => {
	const input = new Date("2026-11-20T15:30:00Z");
	const out = addBusinessDays(input, 1);
	assert.equal(out.toISOString(), "2026-11-23T15:30:00.000Z");
	assert.equal(input.toISOString(), "2026-11-20T15:30:00.000Z");
	assert.notEqual(out, input);
});

test("hidden: a non-integer n throws a RangeError", () => {
	for (const n of [1.5, NaN]) assert.throws(() => addBusinessDays(d("2026-11-20"), n), RangeError, String(n));
});
