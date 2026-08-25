import assert from "node:assert/strict";
import {
  buildNativePdfSelectionText,
  buildStructuredPdfText,
  type PdfSelectionFragment,
  type PdfStructuredLine,
} from "../src/pdfOcr.ts";

const line = (
  text: string,
  x0: number,
  y0: number,
  x1 = x0 + 180,
  y1 = y0 + 12,
): PdfStructuredLine => ({ text, x0, y0, x1, y1 });

const structured = buildStructuredPdfText(
  [
    line("Document title", 20, 20, 300, 36),
    line("• First item", 20, 80),
    line("continued explanation", 40, 94),
    line("1、Second item", 20, 120),
    line("ordinary paragraph first line", 20, 180),
    line("continues on the next line", 20, 194),
    line("text printed inside a figure", 300, 300, 480, 312),
    line("- 12 -", 280, 970, 320, 982),
  ],
  600,
  1000,
  [{ x0: 250, y0: 250, x1: 520, y1: 500 }],
);

assert.equal(structured.removedPageNumbers, 1);
assert.equal(structured.removedImageLines, 1);
assert.equal(structured.listItems, 2);
assert.match(structured.text, /^Document title/m);
assert.match(structured.text, /^- First item continued explanation$/m);
assert.match(structured.text, /^1\. Second item$/m);
assert.match(
  structured.text,
  /^ordinary paragraph first line continues on the next line$/m,
);
assert.doesNotMatch(structured.text, /inside a figure|- 12 -/);

const columns = buildStructuredPdfText(
  [
    line("Left 1", 20, 40, 220, 52),
    line("Right 1", 330, 40, 540, 52),
    line("Left 2", 20, 80, 220, 92),
    line("Right 2", 330, 80, 540, 92),
    line("Left 3", 20, 120, 220, 132),
    line("Right 3", 330, 120, 540, 132),
    line("Left 4", 20, 160, 220, 172),
    line("Right 4", 330, 160, 540, 172),
  ],
  600,
  800,
);

assert.ok(columns.text.indexOf("Left 4") < columns.text.indexOf("Right 1"));
assert.equal(columns.tableCount, 0);

const table = buildStructuredPdfText(
  [
    line("Name", 30, 40, 90, 52),
    line("Version", 210, 40, 275, 52),
    line("Status", 390, 40, 445, 52),
    line("Alpha", 30, 68, 82, 80),
    line("1.0", 210, 68, 238, 80),
    line("Stable", 390, 68, 442, 80),
    line("Beta", 30, 96, 72, 108),
    line("2.0", 210, 96, 238, 108),
    line("Preview", 390, 96, 452, 108),
  ],
  600,
  800,
);

assert.equal(table.tableCount, 1);
assert.equal(table.tableRows, 3);
assert.match(table.text, /^\| Name \| Version \| Status \|$/m);
assert.match(table.text, /^\| --- \| --- \| --- \|$/m);
assert.match(table.text, /^\| Beta \| 2\.0 \| Preview \|$/m);

const keyValueTable = buildStructuredPdfText(
  [
    line("Key", 30, 40, 65, 52),
    line("Value", 180, 40, 390, 52),
    line("OS", 30, 68, 52, 80),
    line("Windows", 180, 68, 390, 80),
    line("Arch", 30, 96, 65, 108),
    line("x64", 180, 96, 390, 108),
  ],
  600,
  800,
);

assert.equal(keyValueTable.tableCount, 1);
assert.match(keyValueTable.text, /^\| OS \| Windows \|$/m);

const splitBullets = buildStructuredPdfText(
  [
    line("•", 30, 40, 36, 52),
    line("First separated item", 66, 40, 210, 52),
    line("•", 30, 68, 36, 80),
    line("Second separated item", 66, 68, 220, 80),
    line("•", 30, 96, 36, 108),
    line("Third separated item", 66, 96, 210, 108),
  ],
  600,
  800,
);

assert.equal(splitBullets.tableCount, 0);
assert.equal(splitBullets.listItems, 3);
assert.match(splitBullets.text, /^- First separated item$/m);

const selection = (
  text: string,
  x0: number,
  y0: number,
  pageNumber = 1,
  x1 = x0 + Math.max(12, text.length * 7),
  y1 = y0 + 12,
): PdfSelectionFragment => ({ text, x0, y0, x1, y1, pageNumber });

const normalParagraphSelection = buildNativePdfSelectionText([
  selection("A normal paragraph wraps", 20, 20),
  selection("onto the next visual line.", 20, 34),
  selection("Inter-", 20, 48),
  selection("national words are dehyphenated.", 20, 62),
]);
assert.equal(
  normalParagraphSelection,
  "A normal paragraph wraps onto the next visual line. International words are dehyphenated.",
);

const listSelection = buildNativePdfSelectionText([
  selection("•", 20, 20, 1, 26),
  selection("First item", 42, 20),
  selection("continues without a copied line break", 42, 34),
  selection("2、", 20, 52, 1, 34),
  selection("Second item", 42, 52),
  selection("ordinary paragraph", 20, 84),
  selection("still wraps normally", 20, 98),
]);
assert.equal(
  listSelection,
  "- First item continues without a copied line break\n2. Second item\n\nordinary paragraph still wraps normally",
);

const crossPageSelection = buildNativePdfSelectionText([
  selection("End of page one.", 20, 700, 1),
  selection("Start of page two.", 20, 20, 2),
]);
assert.equal(crossPageSelection, "End of page one.\n\nStart of page two.");

const separatedColumns = buildNativePdfSelectionText([
  selection("Left column", 20, 20, 1, 95),
  selection("Right column", 260, 20, 1, 345),
]);
assert.equal(separatedColumns, "Left column\nRight column");

console.log("PDF OCR structure tests passed");
