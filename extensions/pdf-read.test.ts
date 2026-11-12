// Run: node --import ./extensions/test-hooks.ts --test extensions/pdf-read.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pdfRead from "./pdf-read.ts";

/** Writes a PDF whose pages have the given content streams, with Helvetica as /F1. */
function writePdf(dir: string, streams: string[]): string {
	const font = 3 + streams.length * 2;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${streams.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${streams.length} >>`,
		...streams.flatMap((s, i) => [
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
			`<< /Length ${s.length} >>\nstream\n${s}\nendstream`,
		]),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let pdf = "%PDF-1.4\n";
	const offsets = objects.map((body, i) => {
		const at = pdf.length;
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
		return at;
	});
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	const file = join(dir, "report.pdf");
	writeFileSync(file, pdf, "latin1");
	return file;
}

test("a PDF comes as each page's text, plus an image of only the pages that draw or have no text; other files go to pi's read", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pdf-read-"));
	const prose = `BT /F1 11 Tf 14 TL 72 720 Td ${"(Revenue grew twelve percent in the quarter, led by services.) ' ".repeat(6)}ET`;
	const chart = Array.from({ length: 12 }, (_, i) => `${100 + i * 30} 200 m ${100 + i * 30} ${260 + i * 15} l S`).join("\n");
	const file = writePdf(dir, [prose, `${prose}\n${chart}`, "0.5 g 72 72 468 648 re f"]);
	writeFileSync(join(dir, "notes.txt"), "plain text\n");

	let tool: any;
	pdfRead({ registerTool: (t: any) => (tool = t) } as any);
	const read = async (params: object) => (await tool.execute("id", params, undefined, undefined, { cwd: dir })).content;
	const shape = (content: any[]) =>
		content.map((b) => (b.type === "image" ? "image" : (/^--- page (\d+)/.exec(b.text)?.[0].slice(4) ?? "note")));

	const all = await read({ path: "report.pdf" });
	assert.deepEqual(shape(all), ["note", "page 1", "page 2", "image", "page 3", "image"]);
	assert.match(all[0].text, /3 pages\. Pages 1-3 follow as text, with an image of page 2, 3 /);
	assert.match(all[1].text, /Revenue grew twelve percent/);
	assert.match(all[4].text, /no text layer/);
	assert.equal(all[3].mimeType, "image/jpeg");
	assert.ok(all[3].data.startsWith("/9j/"), "a JPEG");

	const second = await read({ path: file, offset: 2, limit: 1 });
	assert.deepEqual(shape(second), ["note", "page 2", "image", "note"]);
	assert.match(second.at(-1).text, /1 more pages\. Use offset=3/);
	await assert.rejects(read({ path: "report.pdf", offset: 4 }), /past the last page/);

	assert.equal((await read({ path: "notes.txt" }))[0].text, "plain text\n");
});
