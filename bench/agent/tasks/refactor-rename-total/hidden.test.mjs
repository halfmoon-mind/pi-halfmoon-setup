import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as cart from "./src/cart.mjs";
import * as index from "./src/index.mjs";

const items = [{ price: 250, qty: 2 }, { price: 100, qty: 1 }];

test("hidden: subtotal is the new name, total its deprecated alias", () => {
	assert.equal(cart.subtotal(items), 600);
	assert.equal(cart.total, cart.subtotal);
	assert.equal(index.subtotal, cart.subtotal);
	assert.equal(index.total, cart.subtotal);
	assert.match(readFileSync(new URL("./src/cart.mjs", import.meta.url), "utf8"), /@deprecated/);
});

test("hidden: other modules use subtotal", () => {
	const source = readFileSync(new URL("./src/invoice.mjs", import.meta.url), "utf8");
	assert.match(source, /\bsubtotal\b/);
	assert.doesNotMatch(source, /\btotal\b/);
	assert.deepEqual(index.invoice(items, 0.1), { net: 600, tax: 60, gross: 660 });
});
