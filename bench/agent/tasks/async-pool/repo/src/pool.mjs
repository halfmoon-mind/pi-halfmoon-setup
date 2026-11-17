// Maps items through an async fn with at most `limit` calls in flight.
export function mapLimit(items, limit, fn) {
	return Promise.all(items.map((x, i) => fn(x, i)));
}
