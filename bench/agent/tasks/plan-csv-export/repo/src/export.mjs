// Records as text in the given format.
export function exportRecords(records, { format = "json" } = {}) {
	if (format === "json") return JSON.stringify(records);
	throw new Error(`unknown format: ${format}`);
}
