import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "./src/slugify.mjs";

test("hidden: accents are stripped", () => {
	assert.equal(slugify("Crème Brûlée"), "creme-brulee");
	assert.equal(slugify("Ñandú Señor"), "nandu-senor");
	assert.equal(slugify("Ångström 3"), "angstrom-3");
});

test("hidden: digits and dashes unchanged", () => {
	assert.equal(slugify("Hello, World!"), "hello-world");
	assert.equal(slugify("Version 2.0 -- Release 12"), "version-2-0-release-12");
	assert.equal(slugify("--a--b--"), "a-b");
});
