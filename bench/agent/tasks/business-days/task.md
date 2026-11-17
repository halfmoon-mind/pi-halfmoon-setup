`addBusinessDays(date, n, holidays)` in `src/days.mjs` ignores holidays, cannot count backward and is wrong for `n = 0` on a weekend. Make it follow these rules:
- Everything is in UTC.
- A business day is Monday to Friday and not in `holidays`, an array of `"YYYY-MM-DD"` strings matched against the day's `toISOString().slice(0, 10)`.
- A positive `n` counts `n` business days forward, a negative `n` counts backward.
- `n = 0` returns the date itself when it is a business day, otherwise the next business day after it.
- The UTC time of day of `date` is kept.
- It returns a new Date and never mutates the input.
- A non-integer `n` (such as `1.5` or `NaN`) throws a RangeError.

Keep the existing tests passing.
