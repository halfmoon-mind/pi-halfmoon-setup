import { toCents } from "./money.mjs";

// What goes back to the customer: the amount paid less the fee, in cents.
export function refundCents(order) {
	return toCents(order.paid) - toCents(order.fee);
}
