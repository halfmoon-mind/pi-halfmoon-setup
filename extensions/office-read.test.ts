// Run: node --import ./extensions/test-hooks.ts --test extensions/office-read.test.ts
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { chartTable, shown, unzip } from "./office-read.ts";
import pdfRead from "./pdf-read.ts";

const dir = mkdtempSync(join(tmpdir(), "office-read-"));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const rels = (targets: Record<string, string>) =>
	`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Object.entries(targets)
		.map(([id, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${target.includes("media") ? "image" : "x"}" Target="${target}"/>`)
		.join("")}</Relationships>`;

/** Writes a deflated zip of the given files, as Office does. */
function writeZip(name: string, files: Record<string, string | Buffer>): string {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [path, content] of Object.entries(files)) {
		const data = Buffer.from(content);
		const packed = deflateRawSync(data);
		const n = Buffer.from(path);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc32(data), 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(n.length, 26);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(8, 10);
		entry.writeUInt32LE(crc32(data), 16);
		entry.writeUInt32LE(packed.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(n.length, 28);
		entry.writeUInt32LE(offset, 42);
		parts.push(local, n, packed);
		central.push(entry, n);
		offset += 30 + n.length + packed.length;
	}
	const cd = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(central.length / 2, 8);
	end.writeUInt16LE(central.length / 2, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	const file = join(dir, name);
	writeFileSync(file, Buffer.concat([...parts, cd, end]));
	return file;
}

/** A PDF of blank pages, each 100 pt tall and as wide as given. */
function threePagePdf(widths: number[]): string {
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${widths.map((_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${widths.length} >>`, ...widths.map((w) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} 100] >>`)];
	let pdf = "%PDF-1.4\n";
	const offsets = objects.map((body, i) => {
		const at = pdf.length;
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
		return at;
	});
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

/** Width and height from a baseline JPEG's frame header. */
function jpegSize(base64: string): [number, number] {
	const jpeg = Buffer.from(base64, "base64");
	const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
	return [jpeg.readUInt16BE(sof + 7), jpeg.readUInt16BE(sof + 5)];
}

const colName = (c: number): string => (c > 26 ? colName(Math.floor((c - 1) / 26)) : "") + String.fromCharCode(65 + ((c - 1) % 26));

let tool: any;
pdfRead({ registerTool: (t: any) => (tool = t) } as any);
const read = async (params: object) => (await tool.execute("id", params, undefined, undefined, { cwd: dir })).content as any[];
const texts = (blocks: any[]) => blocks.map((b) => (b.type === "image" ? "[image]" : b.text)).join("\n");

test("a workbook comes as a grid per sheet: values as formatted, each formula after its value, merged ranges, paged by line", async () => {
	writeZip("budget.xlsx", {
		"xl/workbook.xml": `<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Old" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": rels({ rId1: "worksheets/sheet1.xml", rId2: "worksheets/sheet2.xml" }),
		"xl/sharedStrings.xml": `<sst><si><t>Item</t></si><si><r><t>Q</t></r><r><t>1</t></r></si><si><t>A &amp; B</t></si></sst>`,
		"xl/styles.xml": `<styleSheet><numFmts count="2"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="[m]:ss"/></numFmts><cellXfs count="6"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/><xf numFmtId="4"/><xf numFmtId="46"/><xf numFmtId="165"/></cellXfs></styleSheet>`,
		"xl/worksheets/sheet1.xml": `<worksheet><sheetData>
			<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
			<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>0.031</v></c><c r="C2" s="2"><v>46197</v></c><c r="D2" s="3"><v>1234.5</v></c><c r="E2" s="4"><v>1.5</v></c><c r="F2" s="5"><v>1.5</v></c></row>
			<row r="4"><c r="A4"><f t="shared" ref="A4:B4" si="0">C2*$B$2</f><v>1432.107</v></c><c r="B4"><f t="shared" si="0"/><v>38.27</v></c><c r="C4"><f>SUM(B2:B3)</f></c></row>
		</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>`,
		"xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="XFD1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>${"x".repeat(60_000)}</t></is></c></row><row r="3"><c r="A3" t="s"><v>2</v></c></row></sheetData></worksheet>`,
	});
	const all = texts(await read({ path: "budget.xlsx" }));
	assert.match(all, /^Excel workbook, 2 sheets: Budget, Old\./);
	assert.match(all, /## Sheet "Budget", merged: A1:B1\n\| \| A \| B \| C \| D \| E \| F \|\n/);
	assert.match(all, /\| 1 \| Item \| Q1 \|  \|  \|  \|  \|/);
	assert.match(all, /\| 2 \| A & B \| 3\.1% \| 2026-06-24 \| 1,234\.50 \| 36:00:00 \| 2160:00 \|/);
	assert.match(all, /\| 4 \| 1432\.107 `=C2\*\$B\$2` \| 38\.27 `=D2\*\$B\$2` \| \(not calculated\) `=SUM\(B2:B3\)` \|/);
	assert.match(texts(await read({ path: "budget.xlsx", limit: 3 })), /\[Showing lines 1-3 of 15\. Use offset=4 to continue\.\]$/);
	// A lone cell in the last column, then a row past the 50 KB line cap: neither stops paging.
	assert.match(texts(await read({ path: "budget.xlsx", offset: 10, limit: 4 })), /^## Sheet "Old" \(hidden\)\n\| \| A \| XFD \|\n\|---\|---\|---\|\n\| 1 \|  \| Item \|\n\n\[Showing lines 10-13 of 15\. Use offset=14 to continue\.\]$/);
	assert.match(texts(await read({ path: "budget.xlsx", offset: 14 })), /^\| 2 \| x+\n\n\[Line 14 is 58\.6KB, cut to 50\.0KB: read the rest of it with a script\. Use offset=15 to continue\.\]$/);
	assert.equal(texts(await read({ path: "budget.xlsx", offset: 15 })), "| 3 | A & B |  |");

	// 16,384 cells on the diagonal: the whole grid would be about 800 MB, so only the lines shown are built.
	const diagonal = Array.from({ length: 16384 }, (_, i) => `<row r="${i + 1}"><c r="${colName(i + 1)}${i + 1}"><v>${i}</v></c></row>`).join("");
	writeZip("diagonal.xlsx", {
		"xl/workbook.xml": `<workbook><sheets><sheet name="D" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": rels({ rId1: "worksheets/sheet1.xml" }),
		"xl/worksheets/sheet1.xml": `<worksheet><sheetData>${diagonal}</sheetData></worksheet>`,
	});
	assert.match(texts(await read({ path: "diagonal.xlsx" })), /\[Showing lines 1-3 of 16389\. Use offset=4 to continue\.\]$/);
	assert.match(texts(await read({ path: "diagonal.xlsx", offset: 6 })), /^\| 1 \| 0 \|  \|[^]*\[Showing lines 6-6 of 16389\. Use offset=7 to continue\.\]$/);
});

test("cell formats: a month alone is a date, m next to h is minutes", () => {
	assert.equal(shown("46197", "mmmm"), "2026-06-24");
	assert.equal(shown("46197", "mmm-yy"), "2026-06-24");
	assert.equal(shown("0.5", "h:mm"), "12:00:00");
});

test("each zip part and the whole read stop at their expansion caps", () => {
	const zip = unzip(writeZip("big.docx", { a: "a".repeat(2000), b: "b".repeat(2000) }), 1000);
	assert.throws(() => zip.get("a")!(), /^Error: a in .*big\.docx expands past 1000B: not read$/);
	const two = unzip(join(dir, "big.docx"), 4000, 3000);
	assert.equal(two.get("a")!().length, 2000);
	assert.throws(() => two.get("b")!(), /big\.docx expands past 2\.9KB: not read$/);
});

test("chart rows: a sparse point index makes one row, and a scatter chart's series keep their own X values", () => {
	assert.equal(
		chartTable(`<c:chart><c:plotArea><c:barChart><c:ser><c:tx><c:v>A</c:v></c:tx><c:val><c:numRef><c:numCache><c:pt idx="100000000"><c:v>5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart>`),
		"Chart (barChart):\n| Category | A |\n|---|---|\n| 100000001 | 5 |",
	);
	const pts = (vs: number[]) => vs.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("");
	const ser = (name: string, xs: number[], ys: number[]) =>
		`<c:ser><c:tx><c:v>${name}</c:v></c:tx><c:xVal><c:numRef><c:numCache>${pts(xs)}</c:numCache></c:numRef></c:xVal><c:yVal><c:numRef><c:numCache>${pts(ys)}</c:numCache></c:numRef></c:yVal></c:ser>`;
	assert.equal(
		chartTable(`<c:chart><c:plotArea><c:scatterChart>${ser("A", [1, 2], [10, 11])}${ser("B", [100], [20])}</c:scatterChart></c:plotArea></c:chart>`),
		"Chart (scatterChart):\n| Series | X | Y |\n|---|---|---|\n| A | 1 | 10 |\n| A | 2 | 11 |\n| B | 100 | 20 |",
	);
});

test("a Word document comes as Markdown with tracked changes, its pictures where they sit, and page headers", async () => {
	const ns = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
	const run = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
	const picture = `<w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="chart"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="chart.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
	writeZip("contract.docx", {
		"[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		"_rels/.rels": rels({ rId1: "word/document.xml" }).replace("relationships/x", "relationships/officeDocument"),
		"word/_rels/document.xml.rels": rels({ rIdImg: "media/chart.png" }),
		"word/document.xml": `<w:document ${ns}><w:body>
			<w:p>${run("Invoices are payable within ")}<w:del w:id="1" w:author="J. Park"><w:r><w:delText>30</w:delText></w:r></w:del><w:ins w:id="2" w:author="J. Park">${run("45")}</w:ins>${run(" days.")}</w:p>
			<w:p>${picture}</w:p><w:p>${run("After the chart.")}</w:p></w:body></w:document>`,
		"word/media/chart.png": PNG,
		"word/header1.xml": `<w:hdr ${ns}><w:p>${run("CONFIDENTIAL - Draft v3")}</w:p></w:hdr>`,
	});
	const blocks = await read({ path: "contract.docx" });
	assert.deepEqual(blocks.map((b) => b.type), ["text", "text", "image", "text"]);
	assert.match(blocks[1].text, /^Page headers and footers: CONFIDENTIAL - Draft v3\n/);
	assert.match(blocks[1].text, /within <span class="deletion"[^>]*>30<\/span><span class="insertion"[^>]*>45<\/span> days\./);
	assert.equal(blocks[2].mimeType, "image/png");
	assert.match(blocks[3].text, /After the chart\./);
});

test("slides come as text with chart data, tables and notes, paged by slide; a slide that needs an image gets its LibreOffice render, hidden ones too, or else its embedded pictures", async () => {
	const sp = (text: string, ph = "") => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
	const slide = (body: string, attrs = "") => `<p:sld${attrs}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
	const cell = (t: string) => `<a:tc><a:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></a:txBody></a:tc>`;
	const pts = (vs: string[]) => vs.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("");
	writeZip("deck.pptx", {
		"ppt/presentation.xml": `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst></p:presentation>`,
		"ppt/_rels/presentation.xml.rels": rels({ rId1: "slides/slide1.xml", rId2: "slides/slide2.xml", rId3: "slides/slide3.xml" }),
		"ppt/slides/slide1.xml": slide(sp("Q3 Review", `<p:ph type="ctrTitle"/>`) + sp("Prepared by Strategy").replace("<a:t>", `<a:t xml:space="preserve">`)),
		"ppt/slides/_rels/slide1.xml.rels": rels({ rId1: "../notesSlides/notesSlide1.xml" }),
		"ppt/notesSlides/notesSlide1.xml": slide(sp("1", `<p:ph type="sldNum"/>`) + sp("Busan opened with 23 staff.", `<p:ph type="body" idx="1"/>`)),
		"ppt/slides/slide2.xml": slide(
			`<p:graphicFrame><a:graphic><a:graphicData><c:chart r:id="rId1"/></a:graphicData></a:graphic></p:graphicFrame>` +
				`<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr h="1">${cell("Product") + cell("Units")}</a:tr><a:tr h="1">${cell("Pro") + cell("5,830")}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
		),
		"ppt/slides/_rels/slide2.xml.rels": rels({ rId1: "../charts/chart1.xml" }),
		"ppt/charts/chart1.xml": `<c:chartSpace><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart>
			<c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache>${pts(["Seoul", "Tokyo"])}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache>${pts(["12.4", "9.8"])}</c:numCache></c:numRef></c:val></c:ser>
			<c:ser><c:tx><c:v>Q3</c:v></c:tx><c:val><c:numRef><c:numCache>${pts(["13.9", "9.2"])}</c:numCache></c:numRef></c:val></c:ser>
		</c:barChart></c:plotArea></c:chart></c:chartSpace>`,
		"ppt/slides/slide3.xml": slide(`<p:pic><p:nvPicPr><p:cNvPr id="4" name="p" descr="NPS dashboard"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic>`, ` show="0"`),
		"ppt/slides/_rels/slide3.xml.rels": rels({ rId1: "../media/image1.png" }),
		"ppt/media/image1.png": PNG,
	});

	const path = process.env.PATH;
	process.env.PATH = ""; // no soffice
	try {
		const first = await read({ path: "deck.pptx", limit: 1 });
		assert.match(texts(first), /^PowerPoint, 3 slides\. Slides 1-1 follow as text \(.*\)\.\n--- slide 1 ---\n\n# Q3 Review\n\nPrepared by Strategy\n\nSpeaker notes: Busan opened with 23 staff\.\n\[2 more slides\. Use offset=2 to continue\.\]$/);

		const rest = await read({ path: "deck.pptx", offset: 2 });
		assert.deepEqual(rest.map((b) => b.type), ["text", "text", "text", "image"]);
		assert.match(rest[0].text, /with an image of slide 3 \(.*\)\. LibreOffice could not render the slides \(soffice not found/);
		assert.equal(rest[1].text, [
			"--- slide 2 ---",
			"",
			'Chart "Revenue" (barChart):\n| Category | Q2 | Q3 |\n|---|---|---|\n| Seoul | 12.4 | 13.9 |\n| Tokyo | 9.8 | 9.2 |',
			"",
			"| Product | Units |\n| --- | --- |\n| Pro | 5,830 |",
		].join("\n"));
		assert.equal(rest[2].text, "--- slide 3 (hidden) ---\n\n[picture: NPS dashboard]");
		await assert.rejects(read({ path: "deck.pptx", offset: 4 }), /past the last slide/);

		// With LibreOffice: a stand-in soffice copies a PDF whose pages differ in width, so the image shows which page was rendered.
		const bin = mkdtempSync(join(tmpdir(), "office-bin-"));
		writeFileSync(join(dir, "deck-render.pdf"), threePagePdf([100, 200, 300]));
		writeFileSync(join(bin, "soffice"), `#!/bin/sh\necho "$@" > "${bin}/args"\nwhile [ $# -gt 1 ]; do [ "$1" = --outdir ] && out=$2; shift; done\ncp "${dir}/deck-render.pdf" "$out/deck.pdf"\n`);
		chmodSync(join(bin, "soffice"), 0o755);
		process.env.PATH = `${bin}${delimiter}${path}`;
		const rendered = await read({ path: "deck.pptx", offset: 2 });
		assert.deepEqual(rendered.map((b) => b.type), ["text", "text", "text", "image"]);
		assert.match(rendered[0].text, /with an image of slide 3 \(.*\)\.$/);
		assert.match(readFileSync(join(bin, "args"), "utf8"), /ExportHiddenSlides/);
		assert.equal(rendered[3].mimeType, "image/jpeg");
		assert.deepEqual(jpegSize(rendered[3].data), [1100, 367]); // page 3, 300 by 100: the hidden slide keeps its page
	} finally {
		process.env.PATH = path;
	}
});
