// CSV text → rows of string fields; quoted fields may hold "", commas and line breaks.
export function parseCsv(text) {
	if (text === "") return [];
	const rows = [];
	let row = [];
	let i = 0;
	const lineBreak = (at) => (text[at] === "\n" ? 1 : 0);
	for (;;) {
		let field = "";
		if (text[i] === '"') {
			for (i++; ; ) {
				if (i >= text.length) throw new Error("unterminated quote");
				if (text[i] !== '"') field += text[i++];
				else if (text[i + 1] === '"') (field += '"'), (i += 2);
				else break;
			}
			i++;
		} else {
			while (i < text.length && text[i] !== "," && !lineBreak(i)) field += text[i++];
		}
		row.push(field);
		if (i === text.length) return [...rows, row];
		if (text[i] === ",") {
			i++;
			continue;
		}
		const br = lineBreak(i);
		if (!br) throw new Error(`unexpected ${JSON.stringify(text[i])} after a closing quote at ${i}`);
		i += br;
		rows.push(row);
		row = [];
		if (i === text.length) return rows;
	}
}
