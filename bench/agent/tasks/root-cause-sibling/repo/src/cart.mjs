import { toCents } from "./money.mjs";

// Total of `{ price, qty }` items, in cents.
export function cartTotal(items) {
	let cents = 0;
	for (const i of items) cents += toCents(i.price) * i.qty;
	return cents;
}
