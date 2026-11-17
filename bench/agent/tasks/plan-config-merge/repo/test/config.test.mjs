import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, loadConfig } from "../src/config.mjs";

test("a top-level override wins", () => {
	assert.equal(loadConfig(DEFAULTS, { debug: true }).debug, true);
	assert.deepEqual(loadConfig(DEFAULTS), DEFAULTS);
});
