// Calls fn until it succeeds, at most `attempts` times; rejects with the last error.
export async function retry(fn, attempts = 3) {
	for (let i = 0; i < attempts; i++) {
		try {
			return fn();
		} catch (err) {
			if (i === attempts - 1) throw err;
		}
	}
}
