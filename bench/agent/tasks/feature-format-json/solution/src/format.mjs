// Rows of { name, value } as "name: value" lines, or as a JSON object of name → value.
export function format(rows, options = {}) {
	const { as } = options;
	if (as === "json") return JSON.stringify(Object.fromEntries(rows.map((r) => [r.name, r.value])), null, 2);
	if (as === "text" || as === undefined) return rows.map((r) => `${r.name}: ${r.value}`).join("\n");
	throw new Error(`unknown format: ${as}`);
}
