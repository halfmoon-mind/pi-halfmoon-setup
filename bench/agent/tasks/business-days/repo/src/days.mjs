// `date` plus `n` business days (Mon–Fri), in UTC.
export function addBusinessDays(date, n, holidays = []) {
	const out = new Date(date);
	while (n > 0) {
		out.setUTCDate(out.getUTCDate() + 1);
		const day = out.getUTCDay();
		if (day >= 1 && day <= 5) n--;
	}
	return out;
}
