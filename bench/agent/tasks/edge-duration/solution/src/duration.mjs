// "1h30m" → 5400 seconds; units h, m, s, each at most once, in that order.
export function parseDuration(text) {
	const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
	if (!m || !text) throw new Error(`bad duration: ${text}`);
	const [h, min, s] = m.slice(1).map((g) => Number(g ?? 0));
	return h * 3600 + min * 60 + s;
}
