// `date` plus `n` business days (Mon–Fri, not in `holidays` as "YYYY-MM-DD"), in UTC.
export function addBusinessDays(date, n, holidays = []) {
	if (!Number.isInteger(n)) throw new RangeError(`n must be an integer: ${n}`);
	const off = new Set(holidays);
	const isBusiness = (d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && !off.has(d.toISOString().slice(0, 10));
	const out = new Date(date);
	if (n === 0) {
		while (!isBusiness(out)) out.setUTCDate(out.getUTCDate() + 1);
		return out;
	}
	for (let left = n; left > 0; ) {
		out.setUTCDate(out.getUTCDate() + 1);
		if (isBusiness(out)) left--;
	}
	return out;
}
