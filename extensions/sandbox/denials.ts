// Reading sandbox denials: which output lines are denials, and what access to offer for them.
import { lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { fold, MANDATORY, type Policy, real, seam, within } from "./policy.ts";

// Sandbox-denial text: OS errors, errno spellings (Node's `listen EPERM`) and the runtime proxy's (http-proxy.js).
const DENIED = /Operation not permitted|Read-only file system|\bEPERM\b|\bEROFS\b|Connection blocked by network allowlist|blocked-by-allowlist|CERTIFICATE_VERIFY_FAILED[^\n]*application verification failure/;

// Dirs one toolchain writes together, relative to home, offered at once.
// ponytail: Flutter only; add a row when another toolchain needs several dirs.
const BUNDLES = [["fvm", ".pub-cache", ".dart-tool", ".dartServer", ".flutter", ".flutter-devtools", ".config/flutter", "Library/Caches/flutter_engine"]];
const UNSAFE = /[\x00-\x1f\x7f*?[]/; // control chars, and globs merge() refuses in sandbox.json
// Blocked paths in denial lines: quoted (Node, Dart, Python, GNU), and the shell's `/p: Operation not permitted`.
const QUOTED = /'(\/[^'\n]+)'/g;
const BARE = /(?:^|\s)(\/[^:'"\n]*?): (?:Operation not permitted|Read-only file system)/g;

const LOOPBACK = /127\.0\.0\.1|\[?::1\]?|\blocalhost\b|0\.0\.0\.0/i;
const BIND = /server socket|\blisten\b|\bbind\b/i;
const TRUST = /CERTIFICATE_VERIFY_FAILED[^\n]*application verification failure/;
// Dart's own socket and certificate lines, which offer the whole Flutter set.
const DART = /Failed to create server socket|application verification failure\(handshake\.cc/;

/** After dirs: localhost binding, then trustd for TLS checks; macOS only (Linux's runtime ignores allowLocalBinding, its netns has
 * its own loopback; trustd is Apple's); each only while still closed. Lines are untrusted. */
export function opening(lines: string[], p: Policy) {
	if (seam.platform() !== "darwin") return;
	const bind = !p.network.allowLocalBinding && lines.find((l) => DENIED.test(l) && !TRUST.test(l) && !/blocked-by-allowlist|network allowlist/.test(l) && BIND.test(l) && LOOPBACK.test(l));
	if (bind) return { key: "allowLocalBinding" as const, line: bind };
	const trust = !p.enableWeakerNetworkIsolation && lines.find((l) => TRUST.test(l));
	if (trust) return { key: "enableWeakerNetworkIsolation" as const, line: trust };
}

/** What to offer: dirs to make writable, localhost binding, trustd; at least one. `line` is the blocked path or line. */
export type Offer = { dirs: string[]; bind?: true; trust?: true; line: string };
export const keys = (o: Offer) => [...o.dirs.map((d) => `dir:${d}`), ...(o.bind ? ["bind"] : []), ...(o.trust ? ["trust"] : [])];

/** The first blocked path in `lines` with dirs to offer (its Flutter/Dart bundle, or the one tool dir covering it), else
 * opening()'s access. A Flutter/Dart trigger offers every still-closed part of the Flutter set: bundle, localhost, (macOS) trustd.
 * The lines are untrusted (a command can print a fake denial), so broad, config-holding and credential dirs are refused. */
export function offer(lines: string[], p: Policy): Offer | undefined {
	const home = real(seam.home());
	const agent = real(getAgentDir());
	const { allowWrite, denyWrite, denyRead } = p.filesystem;
	const under = (d: string) => within(home, d) && fold(d) !== fold(home);
	const allowed = (d: string) => allowWrite.some((a) => within(a, d));
	const ok = (d: string) => {
		if (!under(d) || UNSAFE.test(d) || MANDATORY.test(d)) return false;
		const st = lstatSync(d, { throwIfNoEntry: false });
		return (!st || st.isDirectory()) && ![...denyRead, agent].some((x) => within(d, x) || within(x, d));
	};
	// A symlinked member is dropped: merge() would resolve it on restart, maybe somewhere else; a looping one too.
	const flutter = (line: string): Offer | undefined => {
		const dirs = BUNDLES[0]!.flatMap((d) => {
			const s = join(home, d);
			try {
				return fold(real(s)) === fold(s) ? [real(s)] : [];
			} catch {
				return [];
			}
		}).filter((d) => ok(d) && !allowed(d));
		// Both network parts are macOS only: Linux's runtime ignores allowLocalBinding (its netns has its own loopback), and trustd is Apple's.
		const mac = seam.platform() === "darwin";
		const o: Offer = { dirs, line, ...(mac && !p.network.allowLocalBinding ? { bind: true } : {}), ...(mac && !p.enableWeakerNetworkIsolation ? { trust: true } : {}) };
		return dirs.length || o.bind || o.trust ? o : undefined;
	};
	for (const l of lines) {
		for (const path of [...l.matchAll(QUOTED), ...l.matchAll(BARE)].map((m) => m[1]!)) {
			try {
				const r = real(path);
				if (UNSAFE.test(path) || UNSAFE.test(r) || allowed(r) || denyWrite.some((d) => within(d, r)) || MANDATORY.test(r) || !under(r)) continue;
				if (BUNDLES[0]!.some((d) => within(join(home, d), r))) {
					const o = flutter(path);
					if (o) return o;
					continue;
				}
				const parts = relative(home, r).split(sep);
				const [a = "", b = ""] = parts.map((x) => x.toLowerCase());
				const n = a === "library" && (b === "caches" || b === "application support") ? 3 : 1;
				if ((n === 1 && ["library", ".config", ".local", ".claude", ".pi", ".ssh", ".git"].includes(a)) || parts.length <= n) continue;
				const dirs = [real(join(home, ...parts.slice(0, n)))].filter((d) => ok(d) && !allowed(d)); // `~/.zshrc/fake` names a file
				if (dirs.length) return { dirs, line: path };
			} catch {} // a symlink loop: no offer for that path
		}
	}
	const dart = lines.find((l) => DENIED.test(l) && DART.test(l));
	if (dart) return flutter(dart);
	const o = opening(lines, p);
	if (o) return { dirs: [], line: o.line, ...(o.key === "allowLocalBinding" ? { bind: true } : { trust: true }) };
}

/** Finds sandbox-denial lines in streamed output; holds at most one bounded partial line. */
export function scanner() {
	const dec = new StringDecoder("utf8");
	const hit = (l: string) => {
		const i = l.search(DENIED);
		if (i >= 0 && s.lines.length < 20) s.lines.push(l.slice(Math.max(0, i - 400), i + 200));
		return i >= 0;
	};
	const s = {
		lines: [] as string[],
		tail: "",
		feed(d: Buffer, end = false) {
			const parts = (s.tail + (end ? dec.end() : dec.write(d))).split("\n");
			s.tail = end ? "" : parts.pop()!;
			parts.forEach(hit);
			// A long line is matched before it is cut; the last 64 chars keep a phrase split across chunks.
			if (s.tail.length > 1000) s.tail = hit(s.tail) ? "" : s.tail.slice(-64);
		},
		end: () => s.feed(Buffer.alloc(0), true),
	};
	return s;
}
