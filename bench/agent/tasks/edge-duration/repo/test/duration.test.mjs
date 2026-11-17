import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration } from "../src/duration.mjs";

test("hours and minutes", () => {
	assert.equal(parseDuration("1h30m"), 5400);
});
