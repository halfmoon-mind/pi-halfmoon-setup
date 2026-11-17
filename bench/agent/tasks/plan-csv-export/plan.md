# CSV export

## Goal
`exportRecords(records, { format: "csv", columns })` returns CSV text, beside today's json format.

## Plan
- [ ] 1. Add `escapeCell(value)` in a new CSV module. - files: src/csv.mjs (new), test/csv.test.mjs (new) - check: `node --test test/csv.test.mjs`
  `escapeCell` turns `null` and `undefined` into `""` and any other value into `String(value)`. When that text contains a comma, a double quote, a CR or a LF, it is wrapped in double quotes with each inner double quote doubled: `a,b` → `"a,b"`, `say "hi"` → `"say ""hi"""`. Test those cases plus a plain cell and a number.
- [ ] 2. Add `toCsv(records, columns)` to the same module. - files: src/csv.mjs (new), test/csv.test.mjs (new) - check: `node --test test/csv.test.mjs`
  The first line is the column names, each through `escapeCell`, joined with `,`. Then one line per record, its values in column order, each through `escapeCell`; a missing key is an empty cell. Lines join with `\n`, with no trailing newline. No records gives just the header line.
- [ ] 3. Support `format: "csv"` in `exportRecords`. - files: src/export.mjs, test/export.test.mjs - check: `node --test test/export.test.mjs`
  `exportRecords(records, { format: "csv", columns })` returns `toCsv(records, columns)`; without `columns` it uses the first record's keys (none for no records). The json format stays as it is, and an unknown format still throws.

## Not doing
No CSV parsing and no other formats.

## Success criteria
- `node --test`
