// 'name,age\n"Ann",30' → [["name", "age"], ["Ann", "30"]].
export function parseCsv(text) {
	return text.split("\n").map((l) => l.split(",").map((f) => f.replace(/^"|"$/g, "")));
}
