// Maps items through an async fn with at most `limit` calls in flight.
export async function mapLimit(items, limit, fn) {
	if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be an integer >= 1, got ${limit}`);
	const results = new Array(items.length);
	let next = 0;
	let failed = false;
	// Each worker takes the next unstarted item until none remain or a call has failed.
	const worker = async () => {
		while (!failed && next < items.length) {
			const i = next++;
			try {
				results[i] = await fn(items[i], i);
			} catch (e) {
				failed = true;
				throw e;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
