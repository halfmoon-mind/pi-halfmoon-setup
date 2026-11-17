import { toCents } from "./money.mjs";

// Sum of dollar amounts, in cents.
export function sumCents(amounts) {
	let cents = 0;
	for (const a of amounts) cents += toCents(a);
	return cents;
}
