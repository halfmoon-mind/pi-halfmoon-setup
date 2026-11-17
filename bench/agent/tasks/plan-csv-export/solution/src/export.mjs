import { toCsv } from "./csv.mjs";

// Records as text in the given format.
export function exportRecords(records, { format = "json", columns } = {}) {
	if (format === "json") return JSON.stringify(records);
	if (format === "csv") return toCsv(records, columns ?? Object.keys(records[0] ?? {}));
	throw new Error(`unknown format: ${format}`);
}
