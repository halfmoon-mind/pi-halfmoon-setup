import assert from "node:assert/strict";
import { test } from "node:test";
import { validateUser } from "../src/validate.mjs";

test("a blank name and a bad email", () => {
	assert.deepEqual(validateUser({ name: " ", email: "x", age: 30 }), ["name is required", "email is invalid"]);
});

test("a valid user", () => {
	assert.deepEqual(validateUser({ name: "Ann", email: "ann@example.com", age: 30 }), []);
});
