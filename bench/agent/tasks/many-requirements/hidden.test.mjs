import assert from "node:assert/strict";
import { test } from "node:test";
import { validateUser } from "./src/validate.mjs";

const ok = { name: "Ann", email: "a@b.c", age: 30 };

test("hidden: not an object gives only the object error", () => {
	for (const user of [null, [], "x"]) assert.deepEqual(validateUser(user), ["user must be an object"], JSON.stringify(user));
});

test("hidden: an empty object", () => {
	assert.deepEqual(validateUser({}), ["name is required", "email is invalid", "age must be an integer"]);
});

test("hidden: age", () => {
	for (const age of [12, 121]) assert.deepEqual(validateUser({ ...ok, age }), ["age must be between 13 and 120"], String(age));
	for (const age of [13, 120]) assert.deepEqual(validateUser({ ...ok, age }), [], String(age));
	for (const age of [30.5, "30"]) assert.deepEqual(validateUser({ ...ok, age }), ["age must be an integer"], JSON.stringify(age));
});

test("hidden: email", () => {
	for (const email of ["a@b", "a b@c.d", "a@.b.c", "a@b.c."]) assert.deepEqual(validateUser({ ...ok, email }), ["email is invalid"], email);
	assert.deepEqual(validateUser({ ...ok, email: "a@b.c" }), []);
});

test("hidden: tags", () => {
	for (const tags of ["a", [1]]) assert.deepEqual(validateUser({ ...ok, tags }), ["tags must be an array of strings"], JSON.stringify(tags));
	assert.deepEqual(validateUser({ ...ok, tags: ["A", "A"] }), ["tags must be lowercase", "tags must be unique"]);
	assert.deepEqual(validateUser({ ...ok, tags: ["a", "a"] }), ["tags must be unique"]);
	assert.deepEqual(validateUser({ ...ok, tags: ["a", "b"] }), []);
});

test("hidden: a non-string name does not throw", () => {
	assert.deepEqual(validateUser({ ...ok, name: 42 }), ["name is required"]);
});

test("hidden: every rule in order, unknown fields last", () => {
	const user = { role: "admin", name: "", email: "bad", age: 5, tags: ["X", "X"], id: 1 };
	assert.deepEqual(validateUser(user), [
		"name is required",
		"email is invalid",
		"age must be between 13 and 120",
		"tags must be lowercase",
		"tags must be unique",
		"unknown field: role",
		"unknown field: id",
	]);
});
