const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A new object: override on top of base, plain objects merged recursively, arrays copied whole.
export function deepMerge(base, override) {
	const out = { ...base };
	for (const [k, v] of Object.entries(override)) {
		if (isPlain(v) && isPlain(base[k])) out[k] = deepMerge(base[k], v);
		else out[k] = Array.isArray(v) ? [...v] : v;
	}
	return out;
}
