/**
 * How long a bash command usually takes, so timing.ts can show it while the command runs and tell the model
 * when a run takes over twice as long. A command is keyed by its git repository, the path inside it and the
 * command with setup and trivial segments dropped; the store keeps only that hash, the executable's name and
 * the last 10 durations.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SETUP = new Set(["export", "source", ".", "set", "pushd", "popd", "unset"]);
const TRIVIAL = new Set(["echo", "grep", "rg", "tail", "head", "cat", "ls", "wc", "sed", "awk", "sort", "uniq", "tr", "cut", "tee", "true", "printf", "test", "[", "sleep", "pwd", "which", "jq", "date"]);
const REDIRECT = /^(\d*|&)(>>?|<)/;

/** Segments of words, split at top-level `&&`, `||`, `;`, `|` and newlines; `undefined` for a heredoc. */
function split(command: string): string[][] | undefined {
	const segments: string[][] = [];
	let words: string[] = [];
	let word = "";
	let quote = "";
	let depth = 0; // inside $(…), dropped
	const endWord = () => {
		if (word) words.push(word);
		word = "";
	};
	const endSegment = () => {
		endWord();
		if (words.length) segments.push(words);
		words = [];
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		const next = command[i + 1];
		// ponytail: quotes inside $(…) are not tracked, so `$(echo ")")` ends early
		if (depth) {
			if (c === "(") depth++;
			else if (c === ")") depth--;
		} else if (quote === "'") {
			word += c;
			if (c === "'") quote = "";
		} else if (c === "\\") {
			word += c + (next ?? "");
			i++;
		} else if (c === "$" && next === "(") {
			// A placeholder stays, so a substituted executable's argument is never promoted to the label.
			word += "$()";
			depth = 1;
			i++;
		} else if (quote === '"') {
			word += c;
			if (c === '"') quote = "";
		} else if (c === "'" || c === '"') {
			quote = c;
			word += c;
		} else if (c === "<" && next === "<") return undefined;
		else if (c === " " || c === "\t" || c === "(" || c === ")") endWord();
		else if (c === "\n" || c === ";" || c === "|") endSegment(); // `||` ends it twice, the second time empty
		else if (c === "&" && next === "&") {
			endSegment();
			i++;
		} else word += c;
	}
	endSegment();
	return segments;
}

const unquote = (w: string) => w.replace(/["']/g, "");
const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p);

const places = new Map<string, string>();
/** The git repository's shared dir and the path inside it, so worktrees share a key; the dir itself outside git. */
function place(cwd: string): string {
	// ponytail: cached for the process; a repo created later in that dir keeps the path key until restart
	let p = places.get(cwd);
	if (p === undefined) {
		try {
			const out = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-prefix"], { timeout: 2000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
			const [commonDir, prefix = ""] = out.split("\n");
			p = `${realpathSync(commonDir)}\0${prefix}`;
		} catch {
			p = cwd;
		}
		places.set(cwd, p);
	}
	return p;
}

/** The key a bash command's durations are kept under, or `undefined` when it is not worth timing. */
export function commandKey(command: unknown, cwd: string): { id: string; label: string } | undefined {
	if (typeof command !== "string") return undefined;
	const segments = split(command);
	if (!segments) return undefined;
	const kept: string[][] = [];
	let at = cwd;
	let effective: string | undefined;
	for (const raw of segments) {
		const words: string[] = [];
		for (let i = 0; i < raw.length; i++) {
			const m = REDIRECT.exec(raw[i]);
			if (!m) words.push(raw[i]);
			else if (raw[i] === m[0]) i++; // no target attached: the next word is it
		}
		// Env assignments, `time` and a `{ …; }` group's braces only wrap the command that runs.
		while (words.length && (/^[A-Za-z_]\w*=/.test(words[0]) || ["time", "{", "}"].includes(words[0]))) words.shift();
		if (!words.length) continue;
		const exe = basename(unquote(words[0]));
		const args = words.slice(1);
		const flags = args.map(unquote); // `"-c"` runs a script as `-c` does
		if (/^python3?$/.test(exe) && (flags.includes("-") || flags.includes("-c"))) return undefined;
		if (exe === "node" && flags.some((a) => a === "-e" || a === "-p" || a === "--eval")) return undefined;
		if (/^(ba|z)?sh$/.test(exe) && flags.includes("-c")) return undefined;
		if (words[0] === "cd") {
			at = args[0] ? resolve(at, expand(unquote(args[0]))) : homedir();
			continue;
		}
		if (SETUP.has(words[0]) || TRIVIAL.has(exe)) continue;
		effective ??= at;
		kept.push([exe, ...args]);
	}
	if (!effective) return undefined;
	const norm = kept.map((w) => w.join(" ")).join(" ; ");
	const id = createHash("sha256").update(`${place(effective)}\0${norm}`).digest("hex").slice(0, 16);
	return { id, label: kept[0][0] };
}

type Store = Record<string, { label: string; ms: number[] }>;
export const storePath = () => join(getAgentDir(), "bash-times.json");

export function read(): Store {
	try {
		const s = JSON.parse(readFileSync(storePath(), "utf8"));
		return s && typeof s === "object" && !Array.isArray(s) ? s : {};
	} catch {
		return {};
	}
}

function write(store: Store) {
	const path = storePath();
	writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(store));
	renameSync(`${path}.${process.pid}.tmp`, path);
}

/** Adds one duration, keeping the last 10. */
export function record(id: string, label: string, ms: number) {
	// ponytail: read-modify-write race between pi processes can drop a sample; a lock file if it matters
	const store = read();
	store[id] = { label, ms: [...(store[id]?.ms ?? []), ms].slice(-10) };
	write(store);
}

/** The median duration once there are 3 samples, when it is at least 20 s; shorter commands need no estimate. */
export function estimate(id: string): number | undefined {
	const ms = read()[id]?.ms;
	if (!ms || ms.length < 3) return undefined;
	const s = [...ms].sort((a, b) => a - b);
	const h = s.length >> 1;
	const median = s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
	return median >= 20000 ? median : undefined;
}

/** A result whose duration says nothing about the command: aborted, timed out or stopped by the sandbox. */
export const excluded = (text: string) => /Command aborted|Command timed out after|\[sandbox:/.test(text);

/** Fills a missing store from the bash calls in past sessions, once: the first pi to claim the file does it. */
export function startBackfill(): Promise<void> | undefined {
	try {
		writeFileSync(storePath(), "{}", { flag: "wx" });
	} catch {
		return undefined;
	}
	return backfill(join(getAgentDir(), "sessions"));
}

export async function backfill(dir: string) {
	// ponytail: an interrupted backfill leaves the claimed store partial; delete bash-times.json to redo it
	try {
		const found: Record<string, { label: string; runs: [at: number, ms: number][] }> = {};
		for (const sub of await readdir(dir, { withFileTypes: true })) {
			if (!sub.isDirectory()) continue;
			for (const name of await readdir(join(dir, sub.name))) {
				if (!name.endsWith(".jsonl")) continue;
				const lines = (await readFile(join(dir, sub.name, name), "utf8")).split("\n");
				const entries = lines.map((l) => {
					try {
						return JSON.parse(l);
					} catch {
						return undefined;
					}
				});
				const cwd = entries[0]?.type === "session" ? entries[0].cwd : undefined;
				if (typeof cwd !== "string") continue;
				const calls = new Map<string, { command: unknown; timestamp: number }>();
				for (const m of entries.map((e) => e?.type === "message" && e.message)) {
					if (m?.role === "assistant" && Array.isArray(m.content)) {
						for (const c of m.content) if (c?.type === "toolCall" && c.name === "bash") calls.set(c.id, { command: c.arguments?.command, timestamp: m.timestamp });
						continue;
					}
					const call = m?.role === "toolResult" && calls.get(m.toolCallId);
					if (!call) continue;
					const text = Array.isArray(m.content) ? m.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n") : "";
					if (excluded(text)) continue;
					// Without durationMs only a command that ran has a meaningful gap; a blocked call's does not.
					const ms = typeof m.durationMs === "number" ? m.durationMs : m.isError === false || /Command exited with code \d+/.test(text) ? m.timestamp - call.timestamp : undefined;
					if (typeof ms !== "number" || !(ms >= 0)) continue;
					const key = commandKey(call.command, cwd);
					if (!key) continue;
					(found[key.id] ??= { label: key.label, runs: [] }).runs.push([m.timestamp, ms]);
				}
			}
		}
		const store = read(); // live samples recorded meanwhile come after the old ones
		// Sessions are read dir by dir, and worktrees sharing a key are separate dirs: order the runs by time.
		for (const [id, v] of Object.entries(found)) {
			const ms = v.runs.sort((a, b) => a[0] - b[0]).map((r) => r[1]);
			store[id] = { label: store[id]?.label ?? v.label, ms: [...ms, ...(store[id]?.ms ?? [])].slice(-10) };
		}
		write(store);
	} catch {}
}
