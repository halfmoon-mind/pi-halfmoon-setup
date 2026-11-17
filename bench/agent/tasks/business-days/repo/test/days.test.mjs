import assert from "node:assert/strict";
import { test } from "node:test";
import { addBusinessDays } from "../src/days.mjs";

const d = (s) => new Date(`${s}T00:00:00Z`);

test("skips the weekend", () => {
	assert.equal(addBusinessDays(d("2026-11-20"), 1).toISOString(), "2026-11-23T00:00:00.000Z");
});

test("counts forward within a week", () => {
	assert.equal(addBusinessDays(d("2026-11-23"), 3).toISOString(), "2026-11-26T00:00:00.000Z");
});
