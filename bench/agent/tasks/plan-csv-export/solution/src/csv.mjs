// One CSV cell: null/undefined empty, quoted when it holds a comma, quote, CR or LF.
export function escapeCell(value) {
	const s = value == null ? "" : String(value);
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A header line of the columns, then one line per record, joined with \n.
export function toCsv(records, columns) {
	const line = (cells) => cells.map(escapeCell).join(",");
	return [line(columns), ...records.map((r) => line(columns.map((c) => r[c])))].join("\n");
}
