import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration } from "./src/duration.mjs";

test("hidden: every unit combination", () => {
	const cases = { "2h": 7200, "45s": 45, "7m": 420, "1h5s": 3605, "1h30m": 5400, "3m15s": 195, "1h2m3s": 3723, "0s": 0, "10h0m0s": 36000 };
	for (const [text, seconds] of Object.entries(cases)) assert.equal(parseDuration(text), seconds, text);
});

test("hidden: anything else throws", () => {
	for (const text of ["", "1m1h", "1h1h", "h", "5x", "90", "1h 30m", "-1h", "1.5h", "s1"]) assert.throws(() => parseDuration(text), Error, JSON.stringify(text));
});
