import assert from "node:assert/strict";
import { test } from "node:test";
import { cartTotal } from "./src/cart.mjs";
import { toCents } from "./src/money.mjs";
import { refundCents } from "./src/refund.mjs";
import { sumCents } from "./src/report.mjs";

test("hidden: toCents is exact", () => {
	const cases = { 0.29: 29, 1.15: 115, 4.35: 435, 19.99: 1999, 0.57: 57, 3: 300, 0: 0 };
	for (const [amount, cents] of Object.entries(cases)) assert.equal(toCents(Number(amount)), cents, amount);
});

test("hidden: every caller gives exact cents", () => {
	assert.equal(cartTotal([{ price: 0.29, qty: 3 }]), 87);
	assert.equal(refundCents({ paid: 19.99, fee: 0.57 }), 1942);
	assert.equal(refundCents({ paid: 4.35, fee: 0.5 }), 385);
	assert.equal(sumCents([0.29, 1.15]), 144);
});
