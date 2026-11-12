// pi's `read` for PDFs: every page's text layer, plus an image of only the pages where text misses
// something (a chart, a diagram, a picture, a scan). Text keeps table numbers exact, and the image
// carries what text can't. Other files go to pi's own read. Needs poppler: `brew install poppler`.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compact } from "./compact-tools.ts";

const DEFAULT_PAGES = 10;
const MAX_PAGES = 20;
// Long side of a page image: a letter page at 100 dpi, about 1,200 image tokens.
const IMAGE_PX = 1100;

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
	return new Promise((done, fail) =>
		execFile(cmd, args, { encoding: "buffer", maxBuffer: 1 << 30, signal }, (error, stdout, stderr) => {
			if (!error) return done(stdout);
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				fail(new Error(`${cmd} not found: reading PDFs needs poppler (brew install poppler, or apt-get install poppler-utils)`));
			} else fail(new Error(`${cmd} failed: ${stderr.toString().trim() || error.message}`));
		}),
	);
}

/** A page needs its image when it draws (charts, diagrams, ruled tables), embeds a picture, or has almost no text (a scan). */
function needsImage(svgPage: string, text: string): boolean {
	const body = svgPage.replace(/<defs>[\s\S]*?<\/defs>/g, ""); // glyph outlines live in <defs>
	return (body.match(/<path/g)?.length ?? 0) >= 10 || body.includes("#source-") || text.replace(/\s/g, "").length < 100;
}

// ponytail: no cap on a page's text, so a page of tiny print can be long; cap it if that shows up.
export async function readPdf(path: string, offset = 1, limit = DEFAULT_PAGES, signal?: AbortSignal) {
	const total = Number(/^Pages:\s+(\d+)/m.exec((await run("pdfinfo", [path], signal)).toString())?.[1] ?? 0);
	const first = Math.max(1, offset);
	if (first > total) throw new Error(`offset ${first} is past the last page of ${path} (${total} pages)`);
	const last = Math.min(total, first + Math.min(Math.max(1, limit), MAX_PAGES) - 1);
	const range = ["-f", String(first), "-l", String(last)];
	const [text, svg] = await Promise.all([
		run("pdftotext", [...range, "-layout", path, "-"], signal),
		run("pdftocairo", ["-svg", ...range, path, "-"], signal),
	]);
	const texts = text.toString().split("\f");
	// Several pages come as <pageSet><page>…; a single page is a plain SVG.
	const parts = svg.toString().split(/<page[ >]/);
	const svgPages = parts.length > 1 ? parts.slice(1) : parts;

	const pages: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
	const imaged: number[] = [];
	for (let p = first; p <= last; p++) {
		const t = texts[p - first]?.trimEnd() ?? "";
		pages.push({ type: "text", text: `--- page ${p} ---\n${t || "(no text layer)"}` });
		if (!needsImage(svgPages[p - first] ?? "", t)) continue;
		const jpeg = await run("pdftoppm", ["-f", String(p), "-l", String(p), "-scale-to", String(IMAGE_PX), "-jpeg", "-singlefile", path], signal);
		pages.push({ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" });
		imaged.push(p);
	}

	let note = `PDF, ${total} pages. Pages ${first}-${last} follow as text`;
	note += imaged.length ? `, with an image of page ${imaged.join(", ")} (figures, drawings or no text layer).` : ".";
	if (imaged.length < last - first + 1) {
		note += " To see a page that came without an image, render it (pdftoppm -f N -l N -r 100 -png FILE OUT) and read the PNG.";
	}
	const more = last < total ? [{ type: "text" as const, text: `[${total - last} more pages. Use offset=${last + 1} to continue.]` }] : [];
	return [{ type: "text" as const, text: note }, ...pages, ...more];
}

export default function (pi: ExtensionAPI) {
	const read = createReadToolDefinition(process.cwd());
	pi.registerTool(compact({
		...read,
		description: `${read.description} For a PDF, offset and limit count pages (${DEFAULT_PAGES} by default, at most ${MAX_PAGES} per call), and you get each page's text plus an image of the pages with figures or no text.`,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!/\.pdf$/i.test(params.path)) return read.execute(id, params, signal, onUpdate, ctx);
			const path = resolve(ctx.cwd, params.path.replace(/^@/, "").replace(/^~(?=$|\/)/, homedir()));
			const content = await readPdf(path, params.offset, params.limit, signal);
			const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
			return { content, details: undefined, structuredContent: text };
		},
	}));
}
