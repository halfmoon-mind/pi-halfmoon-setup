// The sum of price × qty over a cart's items, in cents.
export function subtotal(items) {
	return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

/** @deprecated Use subtotal. */
export const total = subtotal;
