import assert from "node:assert/strict";
import { test } from "node:test";
import { cartTotal } from "../src/cart.mjs";
import { toCents } from "../src/money.mjs";

test("dollars to cents", () => {
	assert.equal(toCents(1.5), 150);
});

test("cart total", () => {
	assert.equal(cartTotal([{ price: 2.5, qty: 2 }]), 500);
});
