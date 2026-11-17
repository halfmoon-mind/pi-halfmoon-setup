// A key-value cache.
export class Cache {
	#map = new Map();

	constructor({ max } = {}) {
		this.max = max;
	}

	get(key) {
		return this.#map.get(key);
	}

	has(key) {
		return this.#map.has(key);
	}

	set(key, value) {
		this.#map.set(key, value);
		return this;
	}

	get size() {
		return this.#map.size;
	}
}
