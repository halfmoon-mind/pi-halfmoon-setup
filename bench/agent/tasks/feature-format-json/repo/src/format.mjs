// Rows of { name, value } as "name: value" lines.
export function format(rows, options = {}) {
	return rows.map((r) => `${r.name}: ${r.value}`).join("\n");
}
