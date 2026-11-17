// The sum of price × qty over a cart's items, in cents.
export function total(items) {
	return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}
