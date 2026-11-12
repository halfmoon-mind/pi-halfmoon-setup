// pi's `read` for Office files, as measured best (see README): what the file's XML holds exactly goes as
// text (cell formulas, chart numbers, tracked changes, comments, speaker notes), and an image only where
// text misses meaning. .docx needs pandoc; .pptx slide images need LibreOffice, else embedded pictures.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { resizeImage, truncateHead } from "@earendil-works/pi-coding-agent";

// Long side of a page image: a letter page at 100 dpi, about 1,200 image tokens.
export const IMAGE_PX = 1100;
const DEFAULT_SLIDES = 10;
const MAX_SLIDES = 20;
const INSTALL: Record<string, string> = {
	pandoc: "reading .docx needs pandoc (brew install pandoc, or apt-get install pandoc)",
	soffice: "slide images need LibreOffice (brew install --cask libreoffice, or apt-get install libreoffice-impress)",
};
const POPPLER = "reading PDFs needs poppler (brew install poppler, or apt-get install poppler-utils)";

export type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function run(cmd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
	return new Promise((done, fail) =>
		execFile(cmd, args, { encoding: "buffer", maxBuffer: 1 << 30, signal }, (error, stdout, stderr) => {
			if (!error) return done(stdout);
			if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(new Error(`${cmd} not found: ${INSTALL[cmd] ?? POPPLER}`));
			else fail(new Error(`${cmd} failed: ${stderr.toString().trim() || error.message}`));
		}),
	);
}

/** The files in a zip (Office files are zips), each inflated when read. */
export function unzip(file: string): Map<string, () => Buffer> {
	const zip = readFileSync(file);
	const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
	if (end < 0) throw new Error(`${file} is not a zip: the Office file may be password-protected or in the old binary format`);
	const files = new Map<string, () => Buffer>();
	// ponytail: no zip64, so no Office file over 4 GB.
	for (let at = zip.readUInt32LE(end + 16), n = zip.readUInt16LE(end + 10); n > 0; n--) {
		const method = zip.readUInt16LE(at + 10);
		const size = zip.readUInt32LE(at + 20);
		const nameEnd = at + 46 + zip.readUInt16LE(at + 28);
		const local = zip.readUInt32LE(at + 42);
		files.set(zip.toString("utf8", at + 46, nameEnd), () => {
			const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
			const data = zip.subarray(start, start + size);
			return method === 8 ? inflateRawSync(data) : data;
		});
		at = nameEnd + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
	}
	return files;
}

type Zip = ReturnType<typeof unzip>;
const xml = (zip: Zip, name: string) => zip.get(name)?.().toString("utf8") ?? "";
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
const decode = (s: string) =>
	s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
		e[0] === "#" ? String.fromCodePoint(Number(e[1] === "x" || e[1] === "X" ? `0${e.slice(1)}` : e.slice(1))) : (ENTITIES[e] ?? m),
	);
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** A part's relationships: id to the zip path it targets. */
function rels(zip: Zip, part: string): Map<string, string> {
	const dir = posix.dirname(part);
	const out = new Map<string, string>();
	for (const [tag] of xml(zip, `${dir}/_rels/${posix.basename(part)}.rels`).matchAll(/<Relationship\b[^>]*>/g)) {
		const id = attr(tag, "Id");
		const target = attr(tag, "Target");
		if (id && target && attr(tag, "TargetMode") !== "External") out.set(id, target.startsWith("/") ? target.slice(1) : posix.join(dir, decode(target)));
	}
	return out;
}

/** Lines from `first` (1-based), up to `limit` and pi's read caps, with how to continue. */
function page(lines: string[], offset = 1, limit?: number): string {
	const first = Math.max(1, offset);
	if (first > lines.length) throw new Error(`offset ${first} is past the last line (${lines.length} lines)`);
	const shown = truncateHead(lines.slice(first - 1, limit ? first - 1 + limit : undefined).join("\n"));
	const last = first - 1 + shown.outputLines;
	return shown.content + (last < lines.length ? `\n\n[Showing lines ${first}-${last} of ${lines.length}. Use offset=${last + 1} to continue.]` : "");
}

async function image(bytes: Buffer, name: string): Promise<Block | undefined> {
	const mimeType = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" }[name.split(".").pop()!.toLowerCase()];
	if (!mimeType) return undefined; // EMF, WMF, TIFF, SVG: no model takes them
	const resized = await resizeImage(bytes, mimeType, { maxWidth: IMAGE_PX, maxHeight: IMAGE_PX, jpegQuality: 85 }).catch(() => null);
	return resized ? { type: "image", data: resized.data, mimeType: resized.mimeType } : undefined;
}

// ---------------------------------------------------------------- docx

/** pandoc's Markdown with tracked insertions, deletions and comments, the embedded pictures where they sit, and page headers and footers. */
async function readDocx(path: string, offset?: number, limit?: number, signal?: AbortSignal): Promise<Block[]> {
	const zip = unzip(path);
	const media = mkdtempSync(join(tmpdir(), "pi-docx-"));
	try {
		// -s keeps the title, which Word's Title style puts in metadata.
		const md = await run("pandoc", ["-s", "-f", "docx", "-t", "gfm", "--wrap=none", "--track-changes=all", `--extract-media=${media}`, path], signal);
		const headers = new Set(
			[...zip.keys()]
				.filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n))
				.map((n) => decode(xml(zip, n).replace(/<\/w:p>/g, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim())
				.filter(Boolean),
		);
		const lines = [...(headers.size ? [`Page headers and footers: ${[...headers].join(" | ")}`, ""] : []), ...md.toString().trimEnd().split("\n")];
		const text = page(lines, offset, limit);
		const blocks: Block[] = [{ type: "text", text: "Word document as Markdown: tracked changes and comments appear as <span> insertion, deletion and comment tags; pictures follow where they sit." }];
		let at = 0;
		for (const m of text.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"[^>]*>|!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
			const src = m[1] ?? m[2];
			if (!src.startsWith(media)) continue;
			blocks.push({ type: "text", text: text.slice(at, m.index) });
			blocks.push((await image(readFileSync(src), src)) ?? { type: "text", text: `[picture ${basename(src)}: a format that cannot be shown]` });
			at = m.index + m[0].length;
		}
		blocks.push({ type: "text", text: text.slice(at) });
		return blocks.filter((b) => b.type === "image" || b.text.trim());
	} finally {
		rmSync(media, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- xlsx

const BUILTIN_FORMATS: Record<string, string> = {
	0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 14: "yyyy-mm-dd",
	15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm", 19: "h:mm:ss", 20: "h:mm", 21: "h:mm:ss", 22: "yyyy-mm-dd h:mm",
	37: "#,##0", 38: "#,##0", 39: "#,##0.00", 40: "#,##0.00", 45: "mm:ss", 46: "h:mm:ss", 47: "mm:ss", 49: "@",
};
const colName = (c: number): string => (c > 26 ? colName(Math.floor((c - 1) / 26)) : "") + String.fromCharCode(65 + ((c - 1) % 26));
const colNum = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/** A number as its cell format shows it: dates, percents, decimals, thousands. */
// ponytail: currency symbols, colors and text sections of a format are dropped; the number stays exact.
export function shown(value: string, format: string, date1904 = false): string {
	const n = Number(value);
	const code = format.split(";")[0].replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, "");
	if (format === "General" || format === "@" || !Number.isFinite(n)) return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : value;
	const when = new Date(Math.round((n - (date1904 ? 24107 : 25569)) * 86400000));
	if (/[dyhs]/i.test(code) && !Number.isNaN(when.getTime())) {
		const iso = when.toISOString();
		const date = /[dy]/i.test(code) ? iso.slice(0, 10) : "";
		const time = /[hs]/i.test(code) ? iso.slice(11, 19) : "";
		return [date, time].filter(Boolean).join(" ");
	}
	const decimals = /\.([0#?]+)/.exec(code)?.[1].length ?? 0;
	if (/E\+/i.test(code)) return n.toExponential(decimals);
	const options = { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: /[#0],[#0]/.test(code) };
	return code.includes("%") ? `${(n * 100).toLocaleString("en-US", options)}%` : n.toLocaleString("en-US", options);
}

/** A shared formula written at another cell: relative references move by the offset, $-fixed ones don't. */
// ponytail: a cell reference inside a quoted string moves too; rare enough in shared formulas.
const shiftFormula = (f: string, rows: number, cols: number) =>
	f.replace(/(?<![\w.])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(!])/g, (_, fc, c, fr, r) =>
		`${fc}${fc ? c : colName(colNum(c) + cols)}${fr}${fr ? r : Number(r) + rows}`,
	);

/** Each sheet as a grid with column letters and row numbers: values as shown, each formula after its value, merged ranges. */
function readXlsx(path: string, offset?: number, limit?: number): Block[] {
	const zip = unzip(path);
	const book = xml(zip, "xl/workbook.xml");
	const bookRels = rels(zip, "xl/workbook.xml");
	const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(book);
	const strings = [...xml(zip, "xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
		decode(si.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").replace(/<[^>]+>/g, "")),
	);
	const styles = xml(zip, "xl/styles.xml");
	const formats = { ...BUILTIN_FORMATS };
	for (const [tag] of styles.matchAll(/<numFmt\b[^>]*>/g)) formats[attr(tag, "numFmtId")!] = decode(attr(tag, "formatCode") ?? "General");
	const cellFormats = [...(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "").matchAll(/<xf\b[^>]*>/g)].map(
		([tag]) => formats[attr(tag, "numFmtId") ?? "0"] ?? "General",
	);

	const sheets = [...book.matchAll(/<sheet\b[^>]*>/g)].map(([tag]) => ({ name: decode(attr(tag, "name") ?? ""), part: bookRels.get(attr(tag, "r:id") ?? ""), hidden: !!attr(tag, "state")?.endsWith("idden") }));
	const lines = [`Excel workbook, ${sheets.length} sheets: ${sheets.map((s) => s.name).join(", ")}. Each comes as a grid with column letters and row numbers; a formula follows its value in backticks. For sums or filters over many rows, compute with a script rather than reading every row.`];
	for (const sheet of sheets) {
		const sx = sheet.part ? xml(zip, sheet.part) : "";
		const rows = new Map<number, Map<number, string>>();
		const masters = new Map<string, { f: string; row: number; col: number }>();
		let row = 0;
		let maxCol = 0;
		for (const [, rowTag, body] of sx.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
			row = Number(attr(rowTag, "r") ?? row + 1);
			let col = 0;
			for (const [, cellTag, inner = ""] of (body ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
				const ref = attr(cellTag, "r");
				col = ref ? colNum(ref.replace(/\d+$/, "")) : col + 1;
				const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
				const type = attr(cellTag, "t");
				let text =
					type === "s" ? (strings[Number(v)] ?? "")
					: type === "inlineStr" ? decode(inner.replace(/<[^>]+>/g, ""))
					: type === "b" ? (v === "1" ? "TRUE" : "FALSE")
					: v === undefined ? ""
					: type === "str" || type === "e" || type === "d" ? decode(v)
					: shown(v, cellFormats[Number(attr(cellTag, "s") ?? 0)] ?? "General", date1904);
				const fm = /<f\b([^>]*?)(?:\/>|>([^<]*)<\/f>)/.exec(inner);
				if (fm) {
					let f = decode(fm[2] ?? "");
					const si = attr(fm[1], "si");
					if (si !== undefined && f) masters.set(si, { f, row, col });
					else if (si !== undefined && masters.has(si)) {
						const m = masters.get(si)!;
						f = shiftFormula(m.f, row - m.row, col - m.col);
					}
					if (f) text = `${v === undefined ? "(not calculated)" : text} \`=${f}\``;
				}
				if (!text) continue;
				if (!rows.has(row)) rows.set(row, new Map());
				rows.get(row)!.set(col, text.replace(/\|/g, "\\|").replace(/\r?\n/g, " "));
				maxCol = Math.max(maxCol, col);
			}
		}
		const merged = [...sx.matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1]);
		lines.push("", `## Sheet "${sheet.name}"${sheet.hidden ? " (hidden)" : ""}${merged.length ? `, merged: ${merged.join(", ")}` : ""}${rows.size ? "" : " (empty)"}`);
		if (!rows.size) continue;
		const cols = Array.from({ length: maxCol }, (_, i) => i + 1);
		lines.push(`| | ${cols.map(colName).join(" | ")} |`, `|---${"|---".repeat(maxCol)}|`);
		for (const [r, cells] of [...rows].sort((a, b) => a[0] - b[0])) lines.push(`| ${r} | ${cols.map((c) => cells.get(c) ?? "").join(" | ")} |`);
	}
	return [{ type: "text", text: page(lines, offset, limit) }];
}

// ---------------------------------------------------------------- pptx

/** Each DrawingML paragraph's text, one per line. */
const paragraphs = (x: string) =>
	[...x.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
		.map(([, p]) => decode(p.replace(/<a:br\b[^>]*>/g, "<a:t>\n</a:t>").match(/<a:t>[^<]*<\/a:t>/g)?.map((t) => t.slice(5, -6)).join("") ?? ""))
		.filter((t) => t.trim());

function chartTable(x: string): string {
	const points = (part = "") => {
		const out: string[] = [];
		for (const [, i, v] of part.matchAll(/<c:pt idx="(\d+)"[^>]*>\s*<c:v>([^<]*)<\/c:v>/g)) out[Number(i)] = decode(v);
		return out;
	};
	const series = [...x.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)].map(([, s]) => ({
		name: /<c:v>([^<]*)<\/c:v>/.exec(/<c:tx>[\s\S]*?<\/c:tx>/.exec(s)?.[0] ?? "")?.[1] ?? "",
		cats: points(/<c:(?:cat|xVal)>[\s\S]*?<\/c:(?:cat|xVal)>/.exec(s)?.[0]),
		vals: points(/<c:(?:val|yVal)>[\s\S]*?<\/c:(?:val|yVal)>/.exec(s)?.[0]),
	}));
	const title = paragraphs(/<c:title>[\s\S]*?<\/c:title>/.exec(x)?.[0] ?? "").join(" ");
	const n = Math.max(0, ...series.flatMap((s) => [s.cats.length, s.vals.length]));
	const cats = series.find((s) => s.cats.length)?.cats ?? [];
	return [
		`Chart${title ? ` "${title}"` : ""} (${/<c:(\w+Chart)>/.exec(x)?.[1] ?? "chart"}):`,
		`| Category | ${series.map((s) => decode(s.name)).join(" | ")} |`,
		`|---${"|---".repeat(series.length)}|`,
		...Array.from({ length: n }, (_, i) => `| ${cats[i] ?? i + 1} | ${series.map((s) => s.vals[i] ?? "").join(" | ")} |`),
	].join("\n");
}

/** A slide needs its image when it has a picture, a connector, a diagram, or a drawn shape that is not a text box. */
// ponytail: decorative filled shapes count too, so a styled deck gets more images than it needs.
export function slideNeedsImage(slide: string): boolean {
	if (/<p:(pic|cxnSp)\b|drawingml\/2006\/diagram/.test(slide)) return true;
	return [...slide.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].some(([sp]) => {
		if (/<p:ph\b|txBox="1"/.test(sp)) return false;
		return /<a:prstGeom prst="(?!rect")|<a:custGeom|<a:solidFill>/.test(sp.split("<p:txBody>")[0]);
	});
}

/** Each slide's titles, text, tables, chart data and speaker notes, plus an image of the slides that need one. */
async function readPptx(path: string, offset = 1, limit = DEFAULT_SLIDES, signal?: AbortSignal): Promise<Block[]> {
	const zip = unzip(path);
	const presRels = rels(zip, "ppt/presentation.xml");
	const slides = [...xml(zip, "ppt/presentation.xml").matchAll(/<p:sldId\b[^>]*>/g)].flatMap(([tag]) => presRels.get(attr(tag, "r:id") ?? "") ?? []);
	const first = Math.max(1, offset);
	if (first > slides.length) throw new Error(`offset ${first} is past the last slide of ${path} (${slides.length} slides)`);
	const last = Math.min(slides.length, first + Math.min(Math.max(1, limit), MAX_SLIDES) - 1);

	const texts: string[] = [];
	const imaged: number[] = [];
	const pictures = new Map<number, string[]>(); // embedded pictures, for when LibreOffice can't render
	for (let s = first; s <= last; s++) {
		const part = slides[s - 1];
		const x = xml(zip, part);
		const r = rels(zip, part);
		const lines = [`--- slide ${s}${/<p:sld\b[^>]*\sshow="0"/.test(x) ? " (hidden)" : ""} ---`];
		for (const [el, kind] of x.matchAll(/<p:(sp|graphicFrame|pic|cxnSp)\b[\s\S]*?<\/p:\1>/g)) {
			if (kind === "sp") {
				const t = paragraphs(el).join("\n");
				if (t) lines.push(/<p:ph\b[^>]*type="(ctrTitle|title)"/.test(el) ? `# ${t}` : t);
			} else if (kind === "pic") {
				const alt = attr(/<p:cNvPr\b[^>]*>/.exec(el)?.[0] ?? "", "descr");
				lines.push(`[picture${alt ? `: ${decode(alt)}` : ""}]`);
				const media = r.get(attr(/<a:blip\b[^>]*>/.exec(el)?.[0] ?? "", "r:embed") ?? "");
				if (media) pictures.set(s, [...(pictures.get(s) ?? []), media]);
			} else if (kind === "graphicFrame" && el.includes("<a:tbl>")) {
				lines.push(
					[...el.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)]
						.map(([tr], i) => {
							const cells = [...tr.matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map(([tc]) => paragraphs(tc).join(" ").replace(/\|/g, "\\|"));
							return `| ${cells.join(" | ")} |${i ? "" : `\n|${" --- |".repeat(cells.length)}`}`;
						})
						.join("\n"),
				);
			} else if (kind === "graphicFrame" && /<c:chart\b/.test(el)) {
				const chart = r.get(attr(/<c:chart\b[^>]*>/.exec(el)![0], "r:id") ?? "");
				if (chart) lines.push(chartTable(xml(zip, chart)));
			}
		}
		const notes = [...r.values()].find((t) => t.includes("notesSlides/"));
		const noteText = [...xml(zip, notes ?? "").matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)]
			.filter(([sp]) => /<p:ph\b[^>]*type="body"/.test(sp))
			.flatMap(([sp]) => paragraphs(sp))
			.join("\n");
		if (noteText) lines.push(`Speaker notes: ${noteText}`);
		texts[s] = lines.join("\n\n");
		if (slideNeedsImage(x)) imaged.push(s);
	}

	const images = new Map<number, Block[]>();
	let fallback = "";
	if (imaged.length) {
		const dir = mkdtempSync(join(tmpdir(), "pi-pptx-"));
		try {
			// Its own profile, so an open LibreOffice window or another read can't block the conversion.
			// ponytail: renders the whole deck on every read; cache the PDF if big decks get slow.
			await run("soffice", [`-env:UserInstallation=${pathToFileURL(join(dir, "profile")).href}`, "--headless", "--convert-to", "pdf", "--outdir", dir, path], signal);
			const pdf = join(dir, basename(path).replace(/\.\w+$/, ".pdf"));
			// LibreOffice leaves hidden slides out of the PDF.
			const visible = slides.map((p) => !/<p:sld\b[^>]*\sshow="0"/.test(xml(zip, p)));
			for (const s of imaged) {
				if (!visible[s - 1]) continue;
				const pdfPage = String(visible.slice(0, s).filter(Boolean).length);
				const jpeg = await run("pdftoppm", ["-f", pdfPage, "-l", pdfPage, "-scale-to", String(IMAGE_PX), "-jpeg", "-singlefile", pdf], signal);
				images.set(s, [{ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" }]);
			}
		} catch (error) {
			if (signal?.aborted) throw error;
			fallback = ` LibreOffice could not render the slides (${(error as Error).message.split("\n")[0]}), so they come with their embedded pictures only: diagrams, arrows and shape colors are missing.`;
			for (const s of imaged) {
				const blocks: Block[] = [];
				for (const media of pictures.get(s) ?? []) {
					const block = zip.has(media) ? await image(zip.get(media)!(), media) : undefined;
					if (block) blocks.push(block);
				}
				images.set(s, blocks);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	const withImage = imaged.filter((s) => images.get(s)?.length);
	let note = `PowerPoint, ${slides.length} slides. Slides ${first}-${last} follow as text (titles, text, tables, chart data, speaker notes)`;
	note += withImage.length ? `, with an image of slide ${withImage.join(", ")} (pictures, diagrams or drawn shapes).` : ".";
	const blocks: Block[] = [{ type: "text", text: note + fallback }];
	for (let s = first; s <= last; s++) blocks.push({ type: "text", text: texts[s] }, ...(images.get(s) ?? []));
	if (last < slides.length) blocks.push({ type: "text", text: `[${slides.length - last} more slides. Use offset=${last + 1} to continue.]` });
	return blocks;
}

export const OFFICE = /\.(docx|docm|xlsx|xlsm|pptx|pptm)$/i;

/** offset and limit count lines for .docx and .xlsx, as pi's read does, and slides for .pptx. */
export async function readOffice(path: string, offset?: number, limit?: number, signal?: AbortSignal): Promise<Block[]> {
	if (/\.doc[xm]$/i.test(path)) return readDocx(path, offset, limit, signal);
	if (/\.xls[xm]$/i.test(path)) return readXlsx(path, offset, limit);
	return readPptx(path, offset, limit, signal);
}
