import type { PDFPageProxy } from "pdfjs-dist";
import type { PaddleOcrLine } from "./ocr/paddleOcr";

export type PdfStructuredLine = {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence?: number;
  blockType?: "table";
};

export type PdfSelectionFragment = PdfStructuredLine & {
  pageNumber: number;
};

export type PdfStructuredText = {
  text: string;
  keptLines: number;
  removedPageNumbers: number;
  removedImageLines: number;
  listItems: number;
  tableCount: number;
  tableRows: number;
};

export type PixelRect = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

const BULLET_ONLY_RE = /^[•●◦▪▫‣⁃·∙*-]$/u;
const LIST_MARKER_RE = /^\s*((?:[•●◦▪▫‣⁃·∙*-])|(?:\(?\d{1,3}\)?[.)、])|(?:[A-Za-z][.)])|(?:[一二三四五六七八九十百]+[、.)]))\s*(.*)$/u;

function isListMarkerOnly(text: string): boolean {
  const match = text.match(LIST_MARKER_RE);
  return !!match && !match[2].trim();
}

function median(values: number[]): number {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 1;
}

function normalizeLineText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

function overlapRatio(line: PdfStructuredLine, rect: PixelRect): number {
  const x0 = Math.max(line.x0, rect.x0);
  const y0 = Math.max(line.y0, rect.y0);
  const x1 = Math.min(line.x1, rect.x1);
  const y1 = Math.min(line.y1, rect.y1);
  if (x1 <= x0 || y1 <= y0) return 0;
  const intersection = (x1 - x0) * (y1 - y0);
  const area = Math.max(1, (line.x1 - line.x0) * (line.y1 - line.y0));
  return intersection / area;
}

function looksLikePageNumber(text: string, y0: number, y1: number, pageHeight: number): boolean {
  const compact = text.replace(/\s+/g, "").trim();
  const edge = y1 <= pageHeight * 0.09 || y0 >= pageHeight * 0.91;
  if (!edge) return false;
  return (
    /^[-–—]?(?:\d{1,4}|[ivxlcdm]{1,8})[-–—]?$/i.test(compact) ||
    /^第?\d{1,4}页$/u.test(compact) ||
    /^(?:page|p\.)?\d{1,4}(?:\/|of)\d{1,4}$/i.test(compact)
  );
}

function mergeSamePhysicalLine(lines: PdfStructuredLine[]): PdfStructuredLine[] {
  const sorted = [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const out: PdfStructuredLine[] = [];
  for (const line of sorted) {
    const height = Math.max(1, line.y1 - line.y0);
    const cy = (line.y0 + line.y1) / 2;
    const candidate = [...out].reverse().find((prev) => {
      const prevHeight = Math.max(1, prev.y1 - prev.y0);
      const prevCy = (prev.y0 + prev.y1) / 2;
      const gap = line.x0 - prev.x1;
      const maxGap = isListMarkerOnly(prev.text)
        ? Math.max(height, prevHeight) * 4
        : Math.max(height, prevHeight) * 2.2;
      return (
        Math.abs(cy - prevCy) <= Math.max(height, prevHeight) * 0.42 &&
        gap >= -Math.min(height, prevHeight) * 0.35 &&
        gap <= maxGap
      );
    });
    if (!candidate) {
      out.push({ ...line });
      continue;
    }
    const joinWithoutSpace = BULLET_ONLY_RE.test(candidate.text) || /[-/（(]$/.test(candidate.text);
    candidate.text = normalizeLineText(
      `${candidate.text}${joinWithoutSpace ? "" : " "}${line.text}`,
    );
    candidate.x0 = Math.min(candidate.x0, line.x0);
    candidate.y0 = Math.min(candidate.y0, line.y0);
    candidate.x1 = Math.max(candidate.x1, line.x1);
    candidate.y1 = Math.max(candidate.y1, line.y1);
    if (line.confidence !== undefined) {
      candidate.confidence = Math.min(candidate.confidence ?? 100, line.confidence);
    }
  }
  return out;
}

function findColumnSplit(lines: PdfStructuredLine[], pageWidth: number): number | null {
  if (lines.length < 8 || pageWidth <= 0) return null;
  let best: { split: number; score: number } | null = null;
  for (let ratio = 0.3; ratio <= 0.7; ratio += 0.025) {
    const split = pageWidth * ratio;
    const gutter = pageWidth * 0.018;
    const left = lines.filter((line) => line.x1 < split - gutter).length;
    const right = lines.filter((line) => line.x0 > split + gutter).length;
    const crossing = lines.length - left - right;
    if (left < 3 || right < 3 || crossing > Math.max(3, lines.length * 0.22)) continue;
    const score = Math.min(left, right) * 3 - crossing * 4 - Math.abs(left - right) * 0.2;
    if (!best || score > best.score) best = { split, score };
  }
  return best?.split ?? null;
}

function readingOrder(lines: PdfStructuredLine[], pageWidth: number): PdfStructuredLine[] {
  const split = findColumnSplit(lines, pageWidth);
  if (!split) return [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

  const gutter = pageWidth * 0.018;
  const spanning = lines
    .filter((line) => line.x0 <= split + gutter && line.x1 >= split - gutter)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const result: PdfStructuredLine[] = [];
  let bandTop = -Infinity;
  const emitBand = (bandBottom: number) => {
    const band = lines.filter(
      (line) =>
        !spanning.includes(line) &&
        line.y0 >= bandTop &&
        line.y0 < bandBottom,
    );
    const left = band
      .filter((line) => line.x1 < split + gutter)
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const right = band
      .filter((line) => line.x0 >= split - gutter)
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    result.push(...left, ...right);
  };
  for (const span of spanning) {
    emitBand(span.y0);
    result.push(span);
    bandTop = Math.max(bandTop, span.y1);
  }
  emitBand(Infinity);
  return result;
}

function normalizeListMarker(marker: string): string {
  if (/^[•●◦▪▫‣⁃·∙*-]$/u.test(marker)) return "-";
  if (/^[一二三四五六七八九十百]+[、.)]$/u.test(marker)) return marker;
  return marker.replace(/、$/, ".");
}

function joinWrappedText(previous: string, current: string): string {
  if (/-$/.test(previous) && /^[a-z]/.test(current)) {
    return `${previous.slice(0, -1)}${current}`;
  }
  return `${previous} ${current}`.replace(/\s+/g, " ").trim();
}

function mergeSelectionPhysicalLines(
  fragments: PdfSelectionFragment[],
): PdfSelectionFragment[] {
  const lines: PdfSelectionFragment[] = [];
  for (const raw of fragments) {
    const fragment = { ...raw, text: normalizeLineText(raw.text) };
    if (!fragment.text) continue;
    const previous = lines[lines.length - 1];
    if (!previous || previous.pageNumber !== fragment.pageNumber) {
      lines.push(fragment);
      continue;
    }
    const height = Math.max(
      1,
      previous.y1 - previous.y0,
      fragment.y1 - fragment.y0,
    );
    const previousCenter = (previous.y0 + previous.y1) / 2;
    const currentCenter = (fragment.y0 + fragment.y1) / 2;
    const gap = fragment.x0 - previous.x1;
    const maxSameLineGap = isListMarkerOnly(previous.text)
      ? height * 4.5
      : height * 5.5;
    if (
      Math.abs(previousCenter - currentCenter) > Math.max(4, height * 0.42) ||
      gap > maxSameLineGap
    ) {
      lines.push(fragment);
      continue;
    }
    const withoutSpace =
      BULLET_ONLY_RE.test(previous.text) ||
      /[-/（(]$/u.test(previous.text) ||
      /^[,.;:!?，。；：！？)）\]}]/u.test(fragment.text);
    const separator = !withoutSpace && gap > 1.5 ? " " : "";
    previous.text = normalizeLineText(`${previous.text}${separator}${fragment.text}`);
    previous.x0 = Math.min(previous.x0, fragment.x0);
    previous.y0 = Math.min(previous.y0, fragment.y0);
    previous.x1 = Math.max(previous.x1, fragment.x1);
    previous.y1 = Math.max(previous.y1, fragment.y1);
  }
  return lines;
}

/**
 * Format a native PDF text-layer selection. By default soft wraps remain
 * copy-friendly spaces; callers can instead retain every physical line for
 * code-sensitive copying and translation.
 */
export function buildNativePdfSelectionText(
  fragments: PdfSelectionFragment[],
  preservePhysicalLines = false,
): string {
  const lines = mergeSelectionPhysicalLines(fragments);
  if (!lines.length) return "";
  const typicalHeight = median(
    lines.map((line) => Math.max(1, line.y1 - line.y0)),
  );
  const pageMinX = new Map<number, number>();
  for (const line of lines) {
    pageMinX.set(
      line.pageNumber,
      Math.min(pageMinX.get(line.pageNumber) ?? Infinity, line.x0),
    );
  }

  if (preservePhysicalLines) {
    const indentWidth = Math.max(4, typicalHeight * 0.75);
    const output: string[] = [];
    let previousPage: number | null = null;
    for (const line of lines) {
      if (
        previousPage !== null &&
        previousPage !== line.pageNumber &&
        output[output.length - 1] !== ""
      ) {
        output.push("");
      }
      const minX = pageMinX.get(line.pageNumber) ?? line.x0;
      const indentLevel = Math.max(
        0,
        Math.min(24, Math.round((line.x0 - minX) / indentWidth)),
      );
      output.push(`${"  ".repeat(indentLevel)}${line.text}`);
      previousPage = line.pageNumber;
    }
    return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  }

  const output: string[] = [];
  let previous: PdfSelectionFragment | null = null;
  let activeListX: number | null = null;
  for (const line of lines) {
    const pageChanged = previous && previous.pageNumber !== line.pageNumber;
    if (pageChanged) {
      if (output.length && output[output.length - 1] !== "") output.push("");
      previous = null;
      activeListX = null;
    }

    const listMatch = line.text.match(LIST_MARKER_RE);
    const verticalGap = previous ? line.y0 - previous.y1 : Infinity;
    if (listMatch && listMatch[2]) {
      const minX = pageMinX.get(line.pageNumber) ?? line.x0;
      const indent = Math.max(
        0,
        Math.min(
          4,
          Math.round((line.x0 - minX) / Math.max(18, typicalHeight * 1.7)),
        ),
      );
      output.push(
        `${"  ".repeat(indent)}${normalizeListMarker(listMatch[1])} ${listMatch[2]}`,
      );
      activeListX = line.x0;
      previous = line;
      continue;
    }

    const listContinuation =
      previous &&
      activeListX !== null &&
      verticalGap >= -typicalHeight * 0.3 &&
      verticalGap <= typicalHeight * 1.05 &&
      line.x0 >= activeListX + typicalHeight * 0.45;
    if (listContinuation && output.length) {
      output[output.length - 1] = joinWrappedText(
        output[output.length - 1],
        line.text,
      );
      previous = line;
      continue;
    }

    const heightDifference = previous
      ? Math.abs(
          line.y1 - line.y0 - (previous.y1 - previous.y0),
        )
      : Infinity;
    const indentDifference = previous ? line.x0 - previous.x0 : Infinity;
    const obviousParagraphBoundary =
      !!previous &&
      (verticalGap < -typicalHeight * 0.45 ||
        verticalGap > typicalHeight * 0.85 ||
        heightDifference > typicalHeight * 0.45 ||
        (indentDifference > typicalHeight * 1.25 &&
          /[.!?。！？:：]$/u.test(previous.text)));
    if (previous && activeListX === null && !obviousParagraphBoundary) {
      output[output.length - 1] = joinWrappedText(
        output[output.length - 1],
        line.text,
      );
    } else {
      if (
        output.length &&
        previous &&
        verticalGap > typicalHeight * 1.55 &&
        output[output.length - 1] !== ""
      ) {
        output.push("");
      }
      output.push(line.text);
    }
    activeListX = null;
    previous = line;
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

type PhysicalRow = {
  cells: PdfStructuredLine[];
  source: PdfStructuredLine[];
  y0: number;
  y1: number;
};

function mergeRowFragments(
  fragments: PdfStructuredLine[],
  typicalHeight: number,
  pageWidth: number,
): PdfStructuredLine[] {
  const sorted = [...fragments].sort((a, b) => a.x0 - b.x0);
  const cells: PdfStructuredLine[] = [];
  const wordGap = Math.max(typicalHeight * 1.25, pageWidth * 0.012);
  for (const fragment of sorted) {
    const previous = cells[cells.length - 1];
    if (!previous || fragment.x0 - previous.x1 > wordGap) {
      cells.push({ ...fragment });
      continue;
    }
    previous.text = normalizeLineText(`${previous.text} ${fragment.text}`);
    previous.x0 = Math.min(previous.x0, fragment.x0);
    previous.y0 = Math.min(previous.y0, fragment.y0);
    previous.x1 = Math.max(previous.x1, fragment.x1);
    previous.y1 = Math.max(previous.y1, fragment.y1);
  }
  return cells;
}

function groupPhysicalRows(
  lines: PdfStructuredLine[],
  pageWidth: number,
  typicalHeight: number,
): PhysicalRow[] {
  const sorted = [...lines].sort(
    (a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0,
  );
  const rows: PdfStructuredLine[][] = [];
  for (const line of sorted) {
    const cy = (line.y0 + line.y1) / 2;
    const row = [...rows].reverse().find((candidate) => {
      const centers = candidate.map((item) => (item.y0 + item.y1) / 2);
      const rowCy = centers.reduce((sum, value) => sum + value, 0) / centers.length;
      const rowHeight = Math.max(
        typicalHeight,
        ...candidate.map((item) => Math.max(1, item.y1 - item.y0)),
        Math.max(1, line.y1 - line.y0),
      );
      return Math.abs(cy - rowCy) <= rowHeight * 0.46;
    });
    if (row) row.push(line);
    else rows.push([line]);
  }
  return rows.map((source) => ({
    cells: mergeRowFragments(source, typicalHeight, pageWidth),
    source,
    y0: Math.min(...source.map((line) => line.y0)),
    y1: Math.max(...source.map((line) => line.y1)),
  }));
}

function rowLooksTabular(row: PhysicalRow, pageWidth: number): boolean {
  if (row.cells.length < 2 || row.cells.length > 12) return false;
  if (isListMarkerOnly(row.cells[0].text)) return false;
  if (row.cells.length >= 3) return true;
  const [left, right] = row.cells;
  const leftWidth = left.x1 - left.x0;
  const rightWidth = right.x1 - right.x0;
  // Two equally wide page columns are indistinguishable from a borderless
  // two-column table without vector border data. Accept key/value-style rows
  // only when at least one column is visibly narrow.
  return Math.min(leftWidth, rightWidth) <= pageWidth * 0.24;
}

function rowsAlign(
  reference: PhysicalRow,
  candidate: PhysicalRow,
  pageWidth: number,
  typicalHeight: number,
): boolean {
  if (reference.cells.length !== candidate.cells.length) return false;
  const tolerance = Math.max(typicalHeight * 2, pageWidth * 0.028);
  return reference.cells.every(
    (cell, index) => Math.abs(cell.x0 - candidate.cells[index].x0) <= tolerance,
  );
}

function escapeMarkdownCell(text: string): string {
  return normalizeLineText(text).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function tableMarkdown(rows: PhysicalRow[]): string {
  const header = rows[0].cells.map((cell) => escapeMarkdownCell(cell.text));
  const output = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows.slice(1)) {
    output.push(`| ${row.cells.map((cell) => escapeMarkdownCell(cell.text)).join(" | ")} |`);
  }
  return output.join("\n");
}

function extractTableBlocks(
  lines: PdfStructuredLine[],
  pageWidth: number,
): { remaining: PdfStructuredLine[]; tables: PdfStructuredLine[]; tableRows: number } {
  if (lines.length < 4 || pageWidth <= 0) {
    return { remaining: lines, tables: [], tableRows: 0 };
  }
  const typicalHeight = median(lines.map((line) => Math.max(1, line.y1 - line.y0)));
  const rows = groupPhysicalRows(lines, pageWidth, typicalHeight);
  const consumed = new Set<PdfStructuredLine>();
  const tables: PdfStructuredLine[] = [];
  let tableRows = 0;

  for (let index = 0; index < rows.length; ) {
    const first = rows[index];
    if (!rowLooksTabular(first, pageWidth)) {
      index += 1;
      continue;
    }
    const run = [first];
    let cursor = index + 1;
    while (cursor < rows.length) {
      const next = rows[cursor];
      const gap = next.y0 - run[run.length - 1].y1;
      if (
        gap > typicalHeight * 3.2 ||
        !rowLooksTabular(next, pageWidth) ||
        !rowsAlign(first, next, pageWidth, typicalHeight)
      ) {
        break;
      }
      run.push(next);
      cursor += 1;
    }

    const enoughRows = run.length >= (first.cells.length >= 3 ? 2 : 3);
    if (!enoughRows) {
      index += 1;
      continue;
    }
    for (const row of run) {
      for (const source of row.source) consumed.add(source);
    }
    tables.push({
      text: tableMarkdown(run),
      x0: Math.min(...run.flatMap((row) => row.cells.map((cell) => cell.x0))),
      y0: run[0].y0,
      x1: Math.max(...run.flatMap((row) => row.cells.map((cell) => cell.x1))),
      y1: run[run.length - 1].y1,
      blockType: "table",
    });
    tableRows += run.length;
    index = cursor;
  }

  return {
    remaining: lines.filter((line) => !consumed.has(line)),
    tables,
    tableRows,
  };
}

export function buildStructuredPdfText(
  rawLines: PdfStructuredLine[],
  pageWidth: number,
  pageHeight: number,
  excludedImageRects: PixelRect[] = [],
): PdfStructuredText {
  let removedPageNumbers = 0;
  let removedImageLines = 0;
  const filtered = rawLines
    .map((line) => ({ ...line, text: normalizeLineText(line.text) }))
    .filter((line) => {
      if (!line.text) return false;
      if (looksLikePageNumber(line.text, line.y0, line.y1, pageHeight)) {
        removedPageNumbers += 1;
        return false;
      }
      if (excludedImageRects.some((rect) => overlapRatio(line, rect) >= 0.5)) {
        removedImageLines += 1;
        return false;
      }
      return true;
    });

  const detectedTables = extractTableBlocks(filtered, pageWidth);
  const ordered = readingOrder(
    [...mergeSamePhysicalLine(detectedTables.remaining), ...detectedTables.tables],
    pageWidth,
  );
  const typicalHeight = median(ordered.map((line) => Math.max(1, line.y1 - line.y0)));
  const minX = ordered.length ? Math.min(...ordered.map((line) => line.x0)) : 0;
  const output: string[] = [];
  let listItems = 0;
  let previous: PdfStructuredLine | null = null;
  let previousWasList = false;

  for (const line of ordered) {
    if (line.blockType === "table") {
      if (output.length && output[output.length - 1] !== "") output.push("");
      output.push(line.text, "");
      previous = null;
      previousWasList = false;
      continue;
    }
    const match = line.text.match(LIST_MARKER_RE);
    const verticalGap = previous ? line.y0 - previous.y1 : Infinity;
    if (match && match[2]) {
      const indent = Math.max(
        0,
        Math.min(4, Math.round((line.x0 - minX) / Math.max(20, typicalHeight * 1.8))),
      );
      output.push(`${"  ".repeat(indent)}${normalizeListMarker(match[1])} ${match[2]}`);
      listItems += 1;
      previousWasList = true;
      previous = line;
      continue;
    }

    const likelyListContinuation =
      previousWasList &&
      previous &&
      verticalGap <= typicalHeight * 1.15 &&
      line.x0 >= previous.x0 + typicalHeight * 0.55;
    if (likelyListContinuation && output.length) {
      output[output.length - 1] = joinWrappedText(output[output.length - 1], line.text);
      previous = line;
      continue;
    }

    const sameParagraph =
      !previousWasList &&
      previous &&
      verticalGap >= -typicalHeight * 0.25 &&
      verticalGap <= typicalHeight * 0.95 &&
      Math.abs(line.x0 - previous.x0) <= typicalHeight * 0.65 &&
      Math.abs((line.y1 - line.y0) - (previous.y1 - previous.y0)) <= typicalHeight * 0.45;
    if (sameParagraph && output.length) {
      output[output.length - 1] = joinWrappedText(output[output.length - 1], line.text);
    } else {
      if (output.length && previous && verticalGap > typicalHeight * 1.45) output.push("");
      output.push(line.text);
    }
    previousWasList = false;
    previous = line;
  }

  return {
    text: output.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    keptLines: ordered.length,
    removedPageNumbers,
    removedImageLines,
    listItems,
    tableCount: detectedTables.tables.length,
    tableRows: detectedTables.tableRows,
  };
}

export async function extractNativePdfLines(page: PDFPageProxy): Promise<PdfStructuredLine[]> {
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  const items: PdfStructuredLine[] = [];
  for (const raw of content.items) {
    if (!raw || typeof raw !== "object" || !("str" in raw) || !("transform" in raw)) continue;
    const item = raw as {
      str: string;
      width?: number;
      height?: number;
      transform: number[];
    };
    const text = normalizeLineText(item.str);
    if (!text) continue;
    const [x, baselineY] = viewport.convertToViewportPoint(
      Number(item.transform[4]) || 0,
      Number(item.transform[5]) || 0,
    );
    const height = Math.max(1, Math.abs(Number(item.height) || Number(item.transform[3]) || 10));
    const width = Math.max(height * 0.4, Math.abs(Number(item.width) || text.length * height * 0.55));
    items.push({ text, x0: x, y0: baselineY - height, x1: x + width, y1: baselineY });
  }
  // Keep PDF.js spans separate until page-number/image filtering has run.
  // Merging first could attach an isolated footer page number to nearby text.
  return items;
}

export function paddleLinesToPdfLines(lines: PaddleOcrLine[]): PdfStructuredLine[] {
  return lines.map((line) => ({
    text: line.text,
    x0: line.x0,
    y0: line.y0,
    x1: line.x1,
    y1: line.y1,
    confidence: line.confidence,
  }));
}

export function nativeTextLooksUsable(lines: PdfStructuredLine[]): boolean {
  const text = lines.map((line) => line.text).join("");
  const meaningful = Array.from(text).filter((char) => /[\p{L}\p{N}]/u.test(char)).length;
  const replacement = (text.match(/[�□]/g) || []).length;
  return meaningful >= 24 && replacement / Math.max(1, text.length) < 0.03;
}
