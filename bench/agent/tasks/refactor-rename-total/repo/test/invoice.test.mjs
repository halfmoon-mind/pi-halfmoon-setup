import assert from "node:assert/strict";
import { test } from "node:test";
import { invoice } from "../src/index.mjs";

test("an invoice adds tax to the cart's sum", () => {
	assert.deepEqual(invoice([{ price: 250, qty: 2 }, { price: 100, qty: 1 }], 0.1), { net: 600, tax: 60, gross: 660 });
});
