# File reading

**English** | [한국어](file-reading.ko.md)

## PDF reading

pi's `read` sends a PDF as each page's text layer (`pdftotext -layout`), plus a JPEG, 1,100 px on its long side, of the pages that draw (10 or more vector paths: charts, diagrams, ruled tables), embed a picture, or have under 100 characters of text (scans). For a PDF, `offset` and `limit` count pages: 10 by default, at most 20 per call. Other files go to pi's own `read`.

Text keeps table numbers exact, and an image carries what text cannot, so a page gets an image only when it needs one. Measured on six pages each of a two-column paper, an FOMC projections report, and a scanned paper, with 12 questions per document on prose, tables, and charts, asked through `claude -p` on Opus 5.5 at medium effort, twice or three times each:

| How the PDF is sent | Tokens (paper / report / scan) | Correct |
|---|---|---|
| Text layer only | 15.0K / 4.6K / 0.1K | 34/72: no charts, nothing from the scan |
| Every page as a 100 dpi image (Claude Code's `Read` with `pages`) | 7.5K / 7.5K / 7.8K | 69/72: misreads in dense tables |
| The whole PDF as a document block (Claude Code's `Read` without `pages`) | 24.2K / 13.9K / 9.5K | 72/72 |
| This extension | 19.4K / 11.8K / 7.9K | 108/108 |

## Office file reading

`read` also opens `.docx`, `.xlsx` and `.pptx` (and their macro-enabled `m` versions). Each goes as text where the file's XML holds the answer exactly, and as an image only where text misses it:

- **Word**: pandoc's Markdown (`pandoc -s -t gfm --track-changes=all`), so tracked insertions, deletions and comments show as `<span>` tags, with each embedded picture where it sits and the page header and footer text, which pandoc drops. `offset` and `limit` count lines.
- **Excel**: each sheet as a grid with column letters and row numbers, values as their number format shows them, each formula after its value, and merged ranges. No images: a rendered sheet cuts off narrow columns (`###`) and loses formulas and cell addresses. `offset` and `limit` count lines.
- **PowerPoint**: each slide's titles, text, tables, chart data (from the chart's own XML, so exact even without data labels) and speaker notes, plus a 1,100 px JPEG, rendered through LibreOffice, of each slide with a picture, a connector, a diagram, or a drawn shape that is not a text box. Without LibreOffice those slides come with their embedded pictures only. `offset` and `limit` count slides: 10 by default, at most 20 per call.

Measured on one test document per format, built to hold what each way of sending can lose: a contract with tracked changes, a comment, a merged-cell table, a chart picture and a page header; a budget workbook with formulas, merged headers, a cross-sheet reference and 150 transaction rows; a review deck with charts without data labels, speaker notes, a screenshot, an arrow flowchart, and status shown only by color. Each had 12 questions, asked three times through `claude -p` on Opus 5.5 at medium effort, and graded by Sonnet against an answer key. With one document per format and questions aimed at what each way drops, the table shows what each way misses more than how often.

| How the file is sent | Tokens | Correct | Misses |
|---|---|---|---|
| Word as text only (textutil, markitdown, pandoc's defaults) | 0.3–0.6K | 21/36 | The text before revision, the deleted sentence, the comment, the chart picture, the header |
| Word as page images, or as a rendered PDF through PDF reading | 2.5K / 3.0K | 33/36 | The comment |
| **Word through this extension** | **1.1K** | **36/36** | |
| Excel as CSV or markitdown | 4.3K / 5.7K | 33/36 | Formulas |
| Excel rendered by Numbers or LibreOffice, as page images | 5.7K / 8.8K | 32/36, 30/36 | Formulas, cut-off cells |
| Excel rendered by Numbers or LibreOffice, through PDF reading | 7.7K / 7.2K | 30/36, 24/36 | Formulas, cell addresses, cut-off cells |
| **Excel through this extension** | **6.7K** | **36/36** | |
| PowerPoint as markitdown text | 0.7K | 27/36 | The screenshot, the arrows, the colors |
| PowerPoint as slide images, or as a rendered PDF through PDF reading | 10.4K / 7.9K | 33/36 | Speaker notes |
| PowerPoint through this extension without LibreOffice | 1.1K | 30/36 | The arrows, the colors |
| **PowerPoint through this extension** | **3.5K** | **36/36** | |
