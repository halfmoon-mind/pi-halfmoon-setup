import { subtotal } from "./cart.mjs";

// An invoice line: the cart's sum plus tax, both in cents.
export function invoice(items, taxRate) {
	const net = subtotal(items);
	return { net, tax: Math.round(net * taxRate), gross: net + Math.round(net * taxRate) };
}
