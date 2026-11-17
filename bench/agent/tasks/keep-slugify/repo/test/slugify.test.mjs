import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slugify.mjs";

test("words join with single dashes", () => {
	assert.equal(slugify("Hello, World!"), "hello-world");
});

test("digits stay and runs of dashes collapse", () => {
	assert.equal(slugify("Version 2.0 -- Release 12"), "version-2-0-release-12");
	assert.equal(slugify("--a--b--"), "a-b");
});
