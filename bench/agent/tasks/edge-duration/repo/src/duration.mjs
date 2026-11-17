// "1h30m" → 5400 seconds.
export function parseDuration(text) {
	const m = /^(\d+)h(\d+)m$/.exec(text);
	if (!m) throw new Error(`bad duration: ${text}`);
	return Number(m[1]) * 3600 + Number(m[2]) * 60;
}
