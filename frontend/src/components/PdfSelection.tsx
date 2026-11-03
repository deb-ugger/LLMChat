import {
buildNativePdfSelectionText,
type PdfSelectionFragment
} from "../pdfOcr";
function normalizePdfExtractedText(
  raw: string,
  clearLineBreaks = true,
): string {
  const normalized = raw.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
  if (!clearLineBreaks) {
    return normalized.replace(/^\n+|\n+$/g, "");
  }
  return normalized
    .replace(/-\s*[\r\n]+/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .trim();
}

type PdfTextFragment = {
  text: string;
  rect: DOMRect | null;
  pageNumber: number;
};

function spanRectForTextNode(node: Node): DOMRect | null {
  const host =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement;
  const span = host?.closest(".textLayer span") as HTMLElement | null;
  if (!span) return null;
  return span.getBoundingClientRect();
}

function pageNumberForTextNode(node: Node): number {
  const host =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement;
  const page = host?.closest(".page") as HTMLElement | null;
  const value = Number(
    page?.dataset.pageNumber || page?.getAttribute("data-page-number") || 1,
  );
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function mergePdfTextFragments(
  fragments: PdfTextFragment[],
  clearLineBreaks = true,
): string {
  const positioned: PdfSelectionFragment[] = fragments.flatMap(
    ({ text, rect, pageNumber }) =>
      rect
        ? [
            {
              text,
              pageNumber,
              x0: rect.left,
              y0: rect.top,
              x1: rect.right,
              y1: rect.bottom,
            },
          ]
        : [],
  );
  if (positioned.length === fragments.length) {
    return normalizePdfExtractedText(
      buildNativePdfSelectionText(positioned, !clearLineBreaks),
      clearLineBreaks,
    );
  }
  return normalizePdfExtractedText(
    fragments.map((fragment) => fragment.text).join("\n"),
    clearLineBreaks,
  );
}

function isPrintedPageNumberSpan(span: HTMLElement): boolean {
  const raw = (span.textContent || "").replace(/\s+/g, "");
  if (!/^\d{1,4}$/.test(raw)) return false;
  const page = span.closest(".page") as HTMLElement | null;
  if (!page) return false;
  const pageNum = Number(
    page.dataset.pageNumber || page.getAttribute("data-page-number"),
  );
  const n = Number(raw);
  const pageRect = page.getBoundingClientRect();
  const spanRect = span.getBoundingClientRect();
  if (pageRect.height <= 1) {
    return Number.isFinite(pageNum) && Math.abs(n - pageNum) <= 1;
  }
  const relY =
    (spanRect.top + spanRect.height / 2 - pageRect.top) / pageRect.height;
  const nearEdge = relY < 0.1 || relY > 0.88;
  if (!nearEdge) return false;
  if (Number.isFinite(pageNum) && Math.abs(n - pageNum) <= 1) return true;
  return raw.length <= 3;
}

function isPrintedPageNumberNode(textNode: Node): boolean {
  const el =
    textNode.nodeType === Node.ELEMENT_NODE
      ? (textNode as HTMLElement)
      : textNode.parentElement;
  if (!el) return false;
  const span = el.closest(".textLayer span") as HTMLElement | null;
  if (!span) return false;
  return isPrintedPageNumberSpan(span);
}

function readPageTextFromDom(
  pageEl: HTMLElement,
  clearLineBreaks = true,
): string {
  const layer = pageEl.querySelector(".textLayer");
  if (!layer) return "";
  const parts: PdfTextFragment[] = [];
  for (const span of layer.querySelectorAll("span")) {
    if (isPrintedPageNumberSpan(span as HTMLElement)) continue;
    const t = span.textContent || "";
    if (t) {
      parts.push({
        text: t,
        rect: span.getBoundingClientRect(),
        pageNumber: pageNumberForTextNode(span),
      });
    }
  }
  return mergePdfTextFragments(parts, clearLineBreaks);
}
export { isPrintedPageNumberNode,mergePdfTextFragments,normalizePdfExtractedText,pageNumberForTextNode,readPageTextFromDom,spanRectForTextNode };
export type { PdfTextFragment };
