// A key-value cache of at most `max` entries, least recently used evicted first; with `ttlMs` entries expire.
export class Cache {
	#map = new Map(); // key → { value, expires }, least recently used first
	#max;
	#ttlMs;
	#now;

	constructor({ max, ttlMs, now = Date.now } = {}) {
		if (!Number.isInteger(max) || max < 1) throw new RangeError(`max must be an integer >= 1, got ${max}`);
		if (ttlMs !== undefined && !(typeof ttlMs === "number" && ttlMs > 0)) throw new RangeError(`ttlMs must be a positive number, got ${ttlMs}`);
		this.#max = max;
		this.#ttlMs = ttlMs;
		this.#now = now;
	}

	// The entry if present and unexpired; an expired one is deleted.
	#live(key) {
		const entry = this.#map.get(key);
		if (entry && this.#now() >= entry.expires) {
			this.#map.delete(key);
			return undefined;
		}
		return entry;
	}

	#prune() {
		const t = this.#now();
		for (const [key, entry] of this.#map) if (t >= entry.expires) this.#map.delete(key);
	}

	get(key) {
		const entry = this.#live(key);
		if (!entry) return undefined;
		this.#map.delete(key);
		this.#map.set(key, entry);
		return entry.value;
	}

	has(key) {
		return this.#live(key) !== undefined;
	}

	set(key, value) {
		this.#map.delete(key);
		if (this.#map.size >= this.#max) {
			this.#prune();
			if (this.#map.size >= this.#max) this.#map.delete(this.#map.keys().next().value);
		}
		this.#map.set(key, { value, expires: this.#ttlMs === undefined ? Infinity : this.#now() + this.#ttlMs });
		return this;
	}

	get size() {
		return this.#map.size;
	}
}
