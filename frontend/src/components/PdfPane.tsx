import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
// 必须先于 pdf_viewer：后者启动时读取 globalThis.pdfjsLib
import {
  AnnotationMode,
  getDocument,
  type PDFDocumentProxy,
} from "../pdfjsBootstrap";
import {
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
  ScrollMode,
  SpreadMode,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import {
  loadPdfSession,
  loadRecentPdf,
  relocatePdfRecent,
  removeRecentPdf,
  savePdfSession,
  savePdfSessionMeta,
  type PdfSession,
  type PdfSessionMeta,
  type ViewMode,
} from "../pdfSession";
import {
  listRecentDocuments,
  recentKindLabel,
  removeRecentDocument,
  type LitRecentItem,
} from "../litRecent";
import { sha256Hex } from "../fileFingerprint";
import { getEngineInfo } from "../translateEngines";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import { highlightSearchHtml } from "../highlightText";
import {
  collectPageImageRects,
  copyImageBlob,
  saveImageBlob,
  findImageAtPoint,
  syncPageImageHotspots,
  clearPageImageHotspots,
  type PdfImageHit,
} from "../pdfImages";
import {
  buildNativePdfSelectionText,
  buildStructuredPdfText,
  extractNativePdfLines,
  nativeTextLooksUsable,
  paddleLinesToPdfLines,
  type PixelRect,
  type PdfSelectionFragment,
} from "../pdfOcr";
import {
  LocalPaddleOcr,
  OCR_MODE_LABELS,
  normalizeOcrMode,
} from "../ocr/paddleOcr";
import {
  loadLocalDoc,
  pickAndLoadDocument,
  pickDocumentPath,
  detectDocKind,
  type LocalDocFile,
} from "../localDocFile";
import { message as tauriMessage } from "@tauri-apps/plugin-dialog";
import {
  DocOutlineTree,
  findActiveOutlineKeyByPage,
  type DocOutlineNode,
} from "./DocOutlineTree";

const PDF_DOCUMENT_OPTIONS = {
  cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${import.meta.env.BASE_URL}standard_fonts/`,
} as const;

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("无法生成 PDF 页面图片"))),
      "image/png",
    );
  });
}

export type { ViewMode };

type Props = {
  onTextSelected: (text: string) => void;
  visible?: boolean;
  translateProvider?: string;
  model?: string;
  ocrMode?: string;
  onOpenImageOcr?: (file: File) => void;
  /** Extra controls rendered at the end of the PDF toolbar. */
  toolbarExtra?: ReactNode;
  /** Open a document handed off from LiteratureView / EpubPane. */
  seedDoc?: LocalDocFile | null;
  /** Page hint from recent list (EPUB→PDF); PdfPane also re-reads IDB. */
  seedPageNumber?: number | null;
  onSeedConsumed?: () => void;
  /** When user picks an EPUB while this pane is active. */
  onOpenOtherKind?: (kind: "epub", doc: LocalDocFile) => void;
  /** Fired when a different document is opened (not on first load). */
  onDocumentChange?: () => void;
};

type FileMeta = {
  filePath: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
};

type PdfResume = Pick<
  PdfSessionMeta,
  | "pageNumber"
  | "scrollTop"
  | "scrollLeft"
  | "contentHash"
> &
  Partial<Pick<PdfSessionMeta, "viewMode" | "scale" | "outlineOpen">>;

async function promptPdfInvalid(
  fileName: string,
  reason: "missing" | "changed",
): Promise<"relocate" | "delete" | "cancel"> {
  const why =
    reason === "missing"
      ? `找不到「${fileName}」（可能已移动或删除）。`
      : `「${fileName}」内容已变化，可能不是同一文件。`;
  const result = await tauriMessage(
    `${why}\n\n阅读进度仍保留。请选择下一步：`,
    {
      title: "PDF 无法打开",
      kind: "warning",
      buttons: {
        yes: "重新定位",
        no: "删除该记录",
        cancel: "取消",
      },
    },
  );
  if (result === "重新定位" || result === "Yes") return "relocate";
  if (result === "删除该记录" || result === "No") return "delete";
  return "cancel";
}

async function promptHashMismatch(
  fileName: string,
): Promise<"apply" | "relocate" | "delete" | "cancel"> {
  const result = await tauriMessage(
    `所选文件与「${fileName}」校验不一致，可能不是同一本。\n阅读位置仅作近似恢复，页码会限制在新文件页数内。`,
    {
      title: "文件内容不一致",
      kind: "warning",
      buttons: {
        yes: "仍应用原进度",
        no: "重新选择",
        cancel: "取消",
      },
    },
  );
  if (result === "仍应用原进度" || result === "Yes") return "apply";
  if (result === "重新选择" || result === "No") return "relocate";
  return "cancel";
}

const VIEW_OPTIONS: { id: ViewMode; label: string }[] = [
  { id: "single", label: "单页视图" },
  { id: "single-scroll", label: "单页滚动" },
  { id: "double", label: "双页视图" },
  { id: "double-scroll", label: "双页滚动" },
];

function ViewModeIcon({ mode }: { mode: ViewMode }) {
  if (mode === "single") {
    return (
      <svg className="pdf-view-icon" viewBox="0 0 24 24" aria-hidden>
        <rect x="6" y="3" width="12" height="18" rx="1.5" />
      </svg>
    );
  }
  if (mode === "single-scroll") {
    return (
      <svg className="pdf-view-icon" viewBox="0 0 24 24" aria-hidden>
        <rect x="7" y="2.5" width="10" height="8" rx="1" />
        <rect x="7" y="13.5" width="10" height="8" rx="1" />
      </svg>
    );
  }
  if (mode === "double") {
    return (
      <svg className="pdf-view-icon" viewBox="0 0 24 24" aria-hidden>
        <rect x="2.5" y="5" width="8.5" height="14" rx="1" />
        <rect x="13" y="5" width="8.5" height="14" rx="1" />
      </svg>
    );
  }
  return (
    <svg className="pdf-view-icon" viewBox="0 0 24 24" aria-hidden>
      <rect x="2.5" y="2.5" width="8.5" height="8" rx="1" />
      <rect x="13" y="2.5" width="8.5" height="8" rx="1" />
      <rect x="2.5" y="13.5" width="8.5" height="8" rx="1" />
      <rect x="13" y="13.5" width="8.5" height="8" rx="1" />
    </svg>
  );
}

const MIN_SCALE = 0.4;
const MAX_SCALE = 5;
/** UI 100% maps to this pdf.js scale (former UI 70% under base 1.4). */
const SCALE_UI_BASE = 0.98;
const DEFAULT_SCALE = SCALE_UI_BASE;
const SCALE_STEP = SCALE_UI_BASE * 0.15;

/** Preview zoom: buttons ±25%, wheel finer ±8%. Cap below 1:1 only on init-fit. */
const IMG_PREVIEW_ZOOM_BTN = 0.25;
const IMG_PREVIEW_ZOOM_WHEEL = 0.08;
const IMG_PREVIEW_ZOOM_MIN = 0.05;
const IMG_PREVIEW_ZOOM_MAX = 8;

function clampImgPreviewZoom(z: number): number {
  return Math.min(
    IMG_PREVIEW_ZOOM_MAX,
    Math.max(IMG_PREVIEW_ZOOM_MIN, Math.round(z * 1000) / 1000),
  );
}

/** Prefer 1:1; if too large for the app window, shrink until fully visible. */
function fitImgPreviewZoom(
  naturalW: number,
  naturalH: number,
  overlay: HTMLElement,
  barHeight: number,
  stagePad: number,
): number {
  if (naturalW < 1 || naturalH < 1) return 1;
  const style = getComputedStyle(overlay);
  const padX =
    (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const padY =
    (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const availW = Math.max(1, overlay.clientWidth - padX - stagePad * 2);
  const availH = Math.max(
    1,
    overlay.clientHeight - padY - Math.max(0, barHeight) - stagePad * 2,
  );
  return clampImgPreviewZoom(Math.min(1, availW / naturalW, availH / naturalH));
}

function scaleToPercent(scale: number): number {
  return Math.round((scale / SCALE_UI_BASE) * 100);
}

function percentToScale(pct: number): number {
  return +((pct / 100) * SCALE_UI_BASE).toFixed(2);
}

function isViewMode(v: unknown): v is ViewMode {
  return (
    v === "single" ||
    v === "single-scroll" ||
    v === "double" ||
    v === "double-scroll"
  );
}

/** Normalize PDF text-layer extraction (hyphenation / whitespace). */
function normalizePdfExtractedText(raw: string): string {
  return raw
    .replace(/\u00a0/g, " ")
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

/** Preserve semantic structure while keeping ordinary PDF soft wraps copy-friendly. */
function mergePdfTextFragments(fragments: PdfTextFragment[]): string {
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
    return buildNativePdfSelectionText(positioned);
  }
  return normalizePdfExtractedText(fragments.map((fragment) => fragment.text).join("\n"));
}

/** Skip PDF footer/header printed page numbers in the text layer. */
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

/** All visible text on a rendered page (skips printed page numbers). */
function readPageTextFromDom(pageEl: HTMLElement): string {
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
  return mergePdfTextFragments(parts);
}

async function copyPlainText(text: string): Promise<boolean> {
  const t = text.trim();
  if (!t) return false;
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = t;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      el.remove();
      return true;
    } catch {
      return false;
    }
  }
}

function viewModeToScrollSpread(mode: ViewMode): {
  scroll: number;
  spread: number;
} {
  switch (mode) {
    case "single":
      return { scroll: ScrollMode.PAGE, spread: SpreadMode.NONE };
    case "double":
      return { scroll: ScrollMode.PAGE, spread: SpreadMode.ODD };
    case "double-scroll":
      return { scroll: ScrollMode.VERTICAL, spread: SpreadMode.ODD };
    case "single-scroll":
    default:
      return { scroll: ScrollMode.VERTICAL, spread: SpreadMode.NONE };
  }
}

async function resolveDestPage(
  pdf: PDFDocumentProxy,
  dest: unknown,
): Promise<number | null> {
  try {
    let explicit: unknown = dest;
    if (explicit == null) return null;
    if (typeof explicit === "string") {
      explicit = await pdf.getDestination(explicit);
    } else if (
      typeof explicit === "object" &&
      explicit !== null &&
      "then" in explicit &&
      typeof (explicit as Promise<unknown>).then === "function"
    ) {
      explicit = await (explicit as Promise<unknown>);
      if (typeof explicit === "string") {
        explicit = await pdf.getDestination(explicit);
      }
    }
    if (!Array.isArray(explicit) || explicit.length === 0) return null;

    const destRef = explicit[0];
    let pageIndex: number;
    if (typeof destRef === "number") {
      pageIndex = destRef;
    } else {
      pageIndex = await pdf.getPageIndex(destRef as never);
    }
    if (!Number.isFinite(pageIndex) || pageIndex < 0) return null;
    return pageIndex + 1;
  } catch {
    return null;
  }
}

async function buildOutline(
  pdf: PDFDocumentProxy,
  items: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>,
  pageLabels: string[] | null,
): Promise<DocOutlineNode[]> {
  if (!items) return [];
  const result: DocOutlineNode[] = [];
  for (const item of items) {
    const pageNumber = await resolveDestPage(pdf, item.dest);
    const rawLabel =
      pageNumber != null && pageLabels?.length
        ? pageLabels[pageNumber - 1] ?? null
        : null;
    const pageLabel =
      rawLabel && rawLabel !== String(pageNumber) ? rawLabel : null;
    result.push({
      title: item.title || "（无标题）",
      pageNumber,
      pageLabel,
      dest: item.dest,
      items: await buildOutline(pdf, item.items, pageLabels),
    });
  }
  return result;
}

function pageDisplayLabel(
  pageLabels: string[] | null,
  pageIndex: number,
): string | null {
  if (pageIndex < 1 || !pageLabels?.length) return null;
  const label = pageLabels[pageIndex - 1];
  if (!label || label === String(pageIndex)) return null;
  return label;
}

/** PDF page index: positive integer only (never Roman page-labels like "i"). */
function sanitizePdfPage(n: unknown, fallback = 1): number {
  const v = typeof n === "number" ? n : Number.parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.floor(v);
}

/** Always re-read progress from IndexedDB for this path. */
async function fetchSavedPdfProgress(
  filePath: string,
): Promise<PdfResume | null> {
  const path = (filePath || "").trim();
  if (!path) return null;
  const recent = await loadRecentPdf(path);
  if (recent?.filePath) {
    return {
      pageNumber: sanitizePdfPage(recent.pageNumber),
      scrollTop: recent.scrollTop || 0,
      scrollLeft: recent.scrollLeft || 0,
      viewMode: recent.viewMode,
      scale: recent.scale,
      outlineOpen: !!recent.outlineOpen,
      contentHash: recent.contentHash,
    };
  }
  const session = await loadPdfSession();
  if (session?.filePath === path) {
    return {
      pageNumber: sanitizePdfPage(session.pageNumber),
      scrollTop: session.scrollTop || 0,
      scrollLeft: session.scrollLeft || 0,
      viewMode: session.viewMode,
      scale: session.scale,
      outlineOpen: !!session.outlineOpen,
      contentHash: session.contentHash,
    };
  }
  return null;
}

export function PdfPane({
  onTextSelected,
  visible = true,
  translateProvider = "google",
  model = "",
  ocrMode = "fast",
  onOpenImageOcr,
  toolbarExtra,
  seedDoc = null,
  seedPageNumber = null,
  onSeedConsumed,
  onOpenOtherKind,
  onDocumentChange,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [fileMeta, setFileMeta] = useState<FileMeta | null>(null);
  const openedDocPathRef = useRef<string | null>(null);
  /** SHA-256 of the currently open file bytes (for session meta). */
  const contentHashRef = useRef<string | undefined>(undefined);
  const handlePdfIntegrityIssueRef = useRef<
    (args: {
      reason: "missing" | "changed";
      saved: PdfSession;
      oldPath: string;
    }) => Promise<void>
  >(async () => undefined);
  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [viewMode, setViewMode] = useState<ViewMode>("single-scroll");
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchHits, setSearchHits] = useState<
    { page: number; snippet: string; matchIndex: number }[]
  >([]);
  const [viewMenuPos, setViewMenuPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [outline, setOutline] = useState<DocOutlineNode[]>([]);
  const [pageLabels, setPageLabels] = useState<string[] | null>(null);
  const pageLabelsRef = useRef<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [handMode, setHandMode] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [docLoading, setDocLoading] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [recentList, setRecentList] = useState<LitRecentItem[]>([]);
  const [scaleInput, setScaleInput] = useState(
    String(scaleToPercent(DEFAULT_SCALE)),
  );
  const [pageInput, setPageInput] = useState("1");
  const [imgMenu, setImgMenu] = useState<{
    x: number;
    y: number;
    pageNumber: number;
    imageHit: PdfImageHit | null;
    /** Non-empty when there is a text selection at right-click time */
    selectedText: string | null;
  } | null>(null);
  const [imgPreview, setImgPreview] = useState<{
    hit: PdfImageHit;
    zoom: number;
    naturalW: number;
    naturalH: number;
  } | null>(null);
  const [imgBusy, setImgBusy] = useState(false);
  const [pageOcrBusy, setPageOcrBusy] = useState(false);
  const [pageOcrStatus, setPageOcrStatus] = useState<string | null>(null);
  const [imgToast, setImgToast] = useState<{
    message: string;
    ok: boolean;
  } | null>(null);
  const imgToastTimerRef = useRef<number | null>(null);
  const imgStageRef = useRef<HTMLDivElement>(null);
  const imgViewerRef = useRef<HTMLDivElement>(null);
  const imgBarRef = useRef<HTMLDivElement>(null);
  const [fitMode, setFitMode] = useState<
    "actual" | "fitHeight" | "fitWidth" | "custom"
  >("actual");
  const pageExtraRotationRef = useRef<Map<number, number>>(new Map());
  const { width: outlineWidth, beginResize: beginOutlineResize } =
    usePersistedWidth("llmchat-pdf-outline-width", 220, 140, 480);

  const debounceRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewerDivRef = useRef<HTMLDivElement>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const openMenuRef = useRef<HTMLDivElement>(null);
  const imgCtxMenuRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const pageOcrEnginesRef = useRef<Map<string, LocalPaddleOcr>>(new Map());
  const pageTextCacheRef = useRef<Map<string, { text: string; status: string }>>(new Map());
  const pageWidthRef = useRef(0);
  const pendingScrollRef = useRef<{ top: number; left: number } | null>(null);
  /** Last user/session page; may update on scroll. */
  const restoredPageRef = useRef<number | null>(null);
  /** Page to apply on pagesinit; not overwritten by PDF.js interim page=1. */
  const restoreTargetPageRef = useRef<number | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const lastGoodPageByPathRef = useRef<Map<string, number>>(new Map());
  /**
   * Last known good PDF page for this book. Updated only by real navigation /
   * successful restore — never by teardown pagechanging→1. Used when hiding
   * the pane and when reopening after EPUB switch.
   */
  const committedPageRef = useRef(1);
  /** While opening a PDF, pin the page we must restore (beats any page-1 persist). */
  const forcedResumePageRef = useRef<number | null>(null);
  const suppressPersistRef = useRef(false);
  const metaSaveTimer = useRef<number | null>(null);
  const persistMetaRef = useRef<
    (opts?: { immediate?: boolean; force?: boolean }) => void
  >(() => undefined);
  const fileMetaRef = useRef<FileMeta | null>(null);
  const pageNumberRef = useRef(1);
  const selectingRef = useRef(false);
  const lastEmittedTextRef = useRef("");
  const pageInputFocusedRef = useRef(false);
  const applyingViewerScaleRef = useRef(false);
  const viewModeRef = useRef(viewMode);
  const scaleRef = useRef(scale);
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  const eventBusRef = useRef<EventBus | null>(null);
  const linkServiceRef = useRef<PDFLinkService | null>(null);
  const findControllerRef = useRef<PDFFindController | null>(null);
  const pdfViewerRef = useRef<PDFViewer | null>(null);
  const viewerReadyRef = useRef(false);
  const [viewerReady, setViewerReady] = useState(false);

  viewModeRef.current = viewMode;
  scaleRef.current = scale;
  pageLabelsRef.current = pageLabels;
  fileMetaRef.current = fileMeta;
  pageNumberRef.current = pageNumber;

  useEffect(() => {
    return () => {
      const engines = [...pageOcrEnginesRef.current.values()];
      pageOcrEnginesRef.current.clear();
      for (const engine of engines) void engine.dispose();
    };
  }, []);

  useEffect(() => {
    setPageOcrStatus(null);
    pageTextCacheRef.current.clear();
  }, [file]);

  const resolveOutlinePage = useCallback(
    async (dest: unknown, fallback: number | null) => {
      if (fallback != null) return fallback;
      const pdf = pdfRef.current;
      if (!pdf) return null;
      return resolveDestPage(pdf, dest);
    },
    [],
  );

  const outlineActiveKey = useMemo(
    () => findActiveOutlineKeyByPage(outline, pageNumber),
    [outline, pageNumber],
  );

  const clampPage = useCallback(
    (page: number) => {
      if (!numPages) return Math.max(1, page);
      return Math.min(Math.max(1, page), numPages);
    },
    [numPages],
  );

  const applyScrollSpread = useCallback((mode: ViewMode) => {
    const viewer = pdfViewerRef.current;
    if (!viewer) return;
    const { scroll, spread } = viewModeToScrollSpread(mode);
    viewer.scrollMode = scroll;
    viewer.spreadMode = spread;
  }, []);

  const syncPageInputDisplay = useCallback((pageIndex: number) => {
    if (pageInputFocusedRef.current) return;
    // Toolbar shows PDF ordinal (1..N), not printed page-labels (i, ii, …).
    setPageInput(String(sanitizePdfPage(pageIndex)));
  }, []);

  const goToPage = useCallback(
    (page: number, _opts?: { smooth?: boolean }) => {
      const next = clampPage(sanitizePdfPage(page));
      setPageNumber(next);
      syncPageInputDisplay(next);
      const viewer = pdfViewerRef.current;
      if (viewer) {
        viewer.currentPageNumber = next;
      }
      restoredPageRef.current = next;
      committedPageRef.current = next;
    },
    [clampPage, syncPageInputDisplay],
  );

  /** Hard rule: after any PDF open, re-read page from IDB and jump there. */
  const jumpToSavedPage = useCallback(async (filePath?: string | null) => {
    const path =
      (filePath || "").trim() ||
      fileMetaRef.current?.filePath ||
      openedDocPathRef.current;
    if (!path) return;
    const saved = await fetchSavedPdfProgress(path);
    const remembered = lastGoodPageByPathRef.current.get(path);
    const page = sanitizePdfPage(
      forcedResumePageRef.current ??
        remembered ??
        saved?.pageNumber ??
        committedPageRef.current,
    );
    if (page > 1) lastGoodPageByPathRef.current.set(path, page);
    const scrollTop = saved?.scrollTop || 0;
    const scrollLeft = saved?.scrollLeft || 0;
    suppressPersistRef.current = true;
    forcedResumePageRef.current = page;
    restoreTargetPageRef.current = page;
    restoredPageRef.current = page;
    committedPageRef.current = page;
    pendingScrollRef.current = { top: scrollTop, left: scrollLeft };
    setPageNumber(page);
    if (!pageInputFocusedRef.current) setPageInput(String(page));

    const viewer = pdfViewerRef.current;
    const count = viewer?.pagesCount || 0;
    // Viewer not ready yet (typical EPUB→PDF): keep the target, let pagesinit retry.
    if (!viewer || count < 1) return;

    const keep = Math.min(page, count);
    viewer.currentPageNumber = keep;
    restoredPageRef.current = keep;
    committedPageRef.current = keep;
    restoreTargetPageRef.current = null;
    forcedResumePageRef.current = null;
    setPageNumber(keep);
    if (!pageInputFocusedRef.current) setPageInput(String(keep));
    const pending = pendingScrollRef.current;
    const root = scrollRef.current;
    if (root && pending) {
      const maxTop = Math.max(0, root.scrollHeight - root.clientHeight);
      const maxLeft = Math.max(0, root.scrollWidth - root.clientWidth);
      root.scrollTop = Math.min(maxTop, Math.max(0, pending.top));
      root.scrollLeft = Math.min(maxLeft, Math.max(0, pending.left));
      pendingScrollRef.current = null;
    }
    window.setTimeout(() => {
      suppressPersistRef.current = false;
      persistMetaRef.current({ immediate: true, force: true });
    }, 150);
  }, []);

  const jumpToSavedPageRef = useRef(jumpToSavedPage);
  jumpToSavedPageRef.current = jumpToSavedPage;

  const onOutlineActivate = useCallback(
    (node: DocOutlineNode) => {
      void (async () => {
        const link = linkServiceRef.current;
        if (node.dest != null && link) {
          suppressPersistRef.current = true;
          try {
            await link.goToDestination(node.dest as string | unknown[]);
          } finally {
            suppressPersistRef.current = false;
          }
          const p = pdfViewerRef.current?.currentPageNumber;
          if (p != null) {
            restoredPageRef.current = p;
            setPageNumber(p);
            syncPageInputDisplay(p);
            persistMetaRef.current({ immediate: true });
          }
          return;
        }
        const page = await resolveOutlinePage(
          node.dest,
          node.pageNumber ?? null,
        );
        if (page != null) goToPage(page);
      })();
    },
    [goToPage, resolveOutlinePage, syncPageInputDisplay],
  );

  const commitPageInput = useCallback(() => {
    pageInputFocusedRef.current = false;
    const raw = pageInput.trim();
    if (!raw) {
      syncPageInputDisplay(pageNumber);
      return;
    }
    // Only accept positive integers (PDF page index). Printed labels like "i"
    // are shown in the tooltip, not typed into this box.
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || String(n) !== raw || n < 1) {
      syncPageInputDisplay(pageNumber);
      return;
    }
    goToPage(clampPage(n));
  }, [clampPage, goToPage, pageInput, pageNumber, syncPageInputDisplay]);

  const fitScaleForDouble = useCallback(
    (preferred?: number) => {
      const root = scrollRef.current;
      const pageW = pageWidthRef.current;
      if (!root || !pageW) return preferred ?? scale;
      const gap = 16; // matches .spread .page horizontal margins (8px + 8px)
      const padding = 40;
      const available = root.clientWidth - padding;
      const fit = available / (pageW * 2 + gap);
      const next = Math.min(preferred ?? scale, fit);
      return Math.max(MIN_SCALE, Math.min(MAX_SCALE, +next.toFixed(2)));
    },
    [scale],
  );

  const reapplyPageRotations = useCallback(() => {
    const viewer = pdfViewerRef.current;
    if (!viewer) return;
    const scaleNow = viewer.currentScale;
    for (const [pageNum, rot] of pageExtraRotationRef.current) {
      const pageView = viewer.getPageView(pageNum - 1) as
        | { update: (o: { scale?: number; rotation?: number }) => void; rotation?: number }
        | undefined;
      if (!pageView) continue;
      if (pageView.rotation === rot) continue;
      pageView.update({ scale: scaleNow, rotation: rot });
    }
  }, []);
  const reapplyPageRotationsRef = useRef(reapplyPageRotations);
  reapplyPageRotationsRef.current = reapplyPageRotations;

  const changeScale = useCallback(
    (nextOrFn: number | ((s: number) => number)) => {
      const keepPage = pageNumber;
      setFitMode("custom");
      setScale((s) => {
        const raw = typeof nextOrFn === "function" ? nextOrFn(s) : nextOrFn;
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, +raw.toFixed(2)));
        const viewer = pdfViewerRef.current;
        if (viewer) {
          applyingViewerScaleRef.current = true;
          viewer.currentScale = next;
          viewer.currentPageNumber = keepPage;
          applyingViewerScaleRef.current = false;
          window.setTimeout(() => reapplyPageRotations(), 0);
        }
        return next;
      });
      setPageNumber(keepPage);
    },
    [pageNumber, reapplyPageRotations],
  );

  const applyFitMode = useCallback(
    (mode: "actual" | "fitHeight" | "fitWidth") => {
      const viewer = pdfViewerRef.current;
      if (!viewer) return;
      const keepPage = pageNumber;
      if (mode === "actual") {
        setFitMode("actual");
        applyingViewerScaleRef.current = true;
        viewer.currentScale = DEFAULT_SCALE;
        applyingViewerScaleRef.current = false;
        setScale(DEFAULT_SCALE);
      } else {
        setFitMode(mode);
        applyingViewerScaleRef.current = true;
        viewer.currentScaleValue =
          mode === "fitWidth" ? "page-width" : "page-height";
        applyingViewerScaleRef.current = false;
        const next = viewer.currentScale;
        if (Number.isFinite(next)) {
          setScale(
            Math.min(MAX_SCALE, Math.max(MIN_SCALE, +next.toFixed(2))),
          );
        }
      }
      viewer.currentPageNumber = keepPage;
      setPageNumber(keepPage);
      window.setTimeout(() => reapplyPageRotations(), 0);
    },
    [pageNumber, reapplyPageRotations],
  );

  const rotatePage = useCallback(
    (pageNum: number, delta: number) => {
      const viewer = pdfViewerRef.current;
      if (!viewer || pageNum < 1) return;
      const pageView = viewer.getPageView(pageNum - 1) as
        | {
            update: (o: { scale?: number; rotation?: number }) => void;
            rotation?: number;
            reset?: () => void;
            draw?: () => Promise<unknown>;
          }
        | undefined;
      if (!pageView) return;
      const cur = pageExtraRotationRef.current.get(pageNum) ?? pageView.rotation ?? 0;
      const next = (((cur + delta) % 360) + 360) % 360;
      pageExtraRotationRef.current.set(pageNum, next);
      pageView.update({ scale: viewer.currentScale, rotation: next });
      try {
        pageView.reset?.();
      } catch {
        /* ignore */
      }
      void pageView.draw?.();
      viewer.update();
    },
    [],
  );

  const commitScaleInput = useCallback(() => {
    const raw = scaleInput.trim();
    if (!raw) {
      setScaleInput(String(scaleToPercent(scale)));
      return;
    }
    const pct = Number(raw);
    if (!Number.isFinite(pct)) {
      setScaleInput(String(scaleToPercent(scale)));
      return;
    }
    const next = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, percentToScale(pct)),
    );
    changeScale(next);
    setScaleInput(String(scaleToPercent(next)));
  }, [changeScale, scale, scaleInput]);

  const applyViewMode = useCallback(
    (mode: ViewMode) => {
      const keepPage = pageNumber;
      let nextScale = scale;
      if (mode === "double" || mode === "double-scroll") {
        nextScale = fitScaleForDouble(scale);
        setScale(nextScale);
      }
      setViewMode(mode);
      setPageNumber(keepPage);
      const viewer = pdfViewerRef.current;
      if (viewer) {
        applyScrollSpread(mode);
        applyingViewerScaleRef.current = true;
        viewer.currentScale = nextScale;
        applyingViewerScaleRef.current = false;
        viewer.currentPageNumber = keepPage;
      }
    },
    [applyScrollSpread, fitScaleForDouble, pageNumber, scale],
  );

  useEffect(() => {
    setScaleInput(String(scaleToPercent(scale)));
  }, [scale]);

  useEffect(() => {
    if (!pageInputFocusedRef.current) {
      syncPageInputDisplay(pageNumber);
    }
  }, [pageNumber, pageLabels, syncPageInputDisplay]);

  const currentPageLabel = useMemo(
    () => pageDisplayLabel(pageLabels, pageNumber),
    [pageLabels, pageNumber],
  );

  const refreshRecent = useCallback(async () => {
    setRecentList(await listRecentDocuments());
  }, []);

  const recentCloseTimer = useRef<number | null>(null);

  const openRecentMenu = useCallback(() => {
    if (recentCloseTimer.current != null) {
      window.clearTimeout(recentCloseTimer.current);
      recentCloseTimer.current = null;
    }
    void refreshRecent().then(() => setRecentOpen(true));
  }, [refreshRecent]);

  const scheduleCloseRecentMenu = useCallback(() => {
    if (recentCloseTimer.current != null) {
      window.clearTimeout(recentCloseTimer.current);
    }
    recentCloseTimer.current = window.setTimeout(() => {
      setRecentOpen(false);
      recentCloseTimer.current = null;
    }, 220);
  }, []);

  useEffect(() => {
    return () => {
      if (recentCloseTimer.current != null) {
        window.clearTimeout(recentCloseTimer.current);
      }
    };
  }, []);

  const engineBadge = useMemo(() => {
    if (translateProvider === "llm") {
      return model ? `模型：${model}` : "模型：大模型";
    }
    const info = getEngineInfo(translateProvider);
    return info ? `引擎：${info.label}` : `引擎：${translateProvider}`;
  }, [model, translateProvider]);

  const persistMeta = useCallback((opts?: { immediate?: boolean; force?: boolean }) => {
    if (!fileMeta) return;
    if (!visibleRef.current && !opts?.force) return;
    if (suppressPersistRef.current && !opts?.force) return;
    const root = scrollRef.current;
    const path = fileMeta.filePath;
    const remembered = lastGoodPageByPathRef.current.get(path);
    const page = sanitizePdfPage(
      forcedResumePageRef.current ??
        restoreTargetPageRef.current ??
        remembered ??
        committedPageRef.current ??
        restoredPageRef.current ??
        pageNumber,
    );
    if (page > 1) lastGoodPageByPathRef.current.set(path, page);
    const meta: PdfSessionMeta = {
      ...fileMeta,
      viewMode,
      pageNumber: page,
      scale,
      scrollTop: root?.scrollTop ?? 0,
      scrollLeft: root?.scrollLeft ?? 0,
      outlineOpen,
      contentHash: contentHashRef.current,
    };
    if (metaSaveTimer.current) window.clearTimeout(metaSaveTimer.current);
    if (opts?.immediate) {
      metaSaveTimer.current = null;
      void savePdfSessionMeta(meta);
      return;
    }
    metaSaveTimer.current = window.setTimeout(() => {
      void savePdfSessionMeta(meta);
    }, 350);
  }, [fileMeta, outlineOpen, pageNumber, scale, viewMode]);

  persistMetaRef.current = persistMeta;

  const syncPageFromViewer = useCallback(() => {
    const viewer = pdfViewerRef.current;
    if (!viewer || viewer.pagesCount <= 0) return;
    if (suppressPersistRef.current) return;
    if (
      forcedResumePageRef.current != null ||
      restoreTargetPageRef.current != null
    ) {
      return;
    }
    const p = sanitizePdfPage(viewer.currentPageNumber);
    if (p < 1) return;
    setPageNumber((prev) => {
      if (prev === p) return prev;
      restoredPageRef.current = p;
      committedPageRef.current = p;
      if (!pageInputFocusedRef.current) {
        setPageInput(String(p));
      }
      return p;
    });
  }, []);

  const onPdfScroll = useCallback(() => {
    syncPageFromViewer();
    persistMeta();
  }, [persistMeta, syncPageFromViewer]);

  useEffect(() => {
    persistMeta();
  }, [persistMeta]);

  // Flush reading position before process kill / tab hide (rebuild Stop-Process).
  useEffect(() => {
    const flush = () => persistMeta({ immediate: true });
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [persistMeta]);

  // Init official PDFViewer after the real viewer DOM is mounted.
  // Must not run while `restoring` early-return used to omit the container
  // (that left viewerReady stuck false and the literature pane blank).
  useEffect(() => {
    if (restoring) return;

    const container = scrollRef.current;
    const viewerEl = viewerDivRef.current;
    if (!container || !viewerEl || pdfViewerRef.current) return;

    let pdfViewer: PDFViewer;
    let eventBus: EventBus;
    try {
      eventBus = new EventBus();
      const linkService = new PDFLinkService({
        eventBus,
        externalLinkTarget: LinkTarget.BLANK,
        externalLinkRel: "noopener noreferrer",
      });
      const findController = new PDFFindController({
        eventBus,
        linkService,
      });
      pdfViewer = new PDFViewer({
        container,
        viewer: viewerEl,
        eventBus,
        linkService,
        findController,
        annotationMode: AnnotationMode.ENABLE,
        textLayerMode: 1,
      });
      linkService.setViewer(pdfViewer);
      eventBusRef.current = eventBus;
      linkServiceRef.current = linkService;
      findControllerRef.current = findController;
      pdfViewerRef.current = pdfViewer;
      viewerReadyRef.current = true;
      setViewerReady(true);
      setError(null);
    } catch (err) {
      viewerReadyRef.current = false;
      setViewerReady(false);
      setError(
        err instanceof Error
          ? `PDF 阅读器初始化失败：${err.message}`
          : "PDF 阅读器初始化失败",
      );
      return;
    }

    const onPageChanging = (evt: { pageNumber: number }) => {
      if (!visibleRef.current) return;
      const p = sanitizePdfPage(evt.pageNumber);
      const restoreTarget = restoreTargetPageRef.current;
      if (suppressPersistRef.current) {
        // Teardown / mid-restore: ignore interim pages (especially page 1).
        if (p === 1) return;
        if (restoreTarget != null && p !== restoreTarget) return;
      }
      setPageNumber(p);
      if (!pageInputFocusedRef.current) {
        setPageInput(String(p));
      }
      if (!suppressPersistRef.current) {
        restoredPageRef.current = p;
        committedPageRef.current = p;
        const path = openedDocPathRef.current;
        if (p > 1 && path) lastGoodPageByPathRef.current.set(path, p);
      }
    };
    const onScaleChanging = (evt: { scale: number }) => {
      if (applyingViewerScaleRef.current) return;
      const s = evt.scale;
      if (!Number.isFinite(s)) return;
      setFitMode("custom");
      setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, +s.toFixed(2))));
    };
    const onPagesInit = () => {
      applyScrollSpread(viewModeRef.current);
      applyingViewerScaleRef.current = true;
      try {
        pdfViewer.currentScale = scaleRef.current;
      } finally {
        applyingViewerScaleRef.current = false;
      }
      const target = sanitizePdfPage(
        forcedResumePageRef.current ??
          restoreTargetPageRef.current ??
          committedPageRef.current ??
          restoredPageRef.current ??
          1,
      );
      const pageCount = pdfViewer.pagesCount;
      // CRITICAL: pagesCount may be 0/undefined at the first pagesinit tick.
      // `Math.min(target, pagesCount || 1)` used to force page 1 and then
      // persist it — wiping real progress after every EPUB↔PDF switch.
      if (!pageCount || pageCount < 1) {
        restoreTargetPageRef.current = target;
        restoredPageRef.current = target;
        committedPageRef.current = target;
        setPageNumber(target);
        if (!pageInputFocusedRef.current) setPageInput(String(target));
        window.setTimeout(() => {
          void jumpToSavedPageRef.current(openedDocPathRef.current);
        }, 0);
        return;
      }
      const keep = Math.min(target, pageCount);
      pdfViewer.currentPageNumber = keep;
      restoredPageRef.current = keep;
      committedPageRef.current = keep;
      restoreTargetPageRef.current = null;
      setPageNumber(keep);
      if (!pageInputFocusedRef.current) {
        setPageInput(String(keep));
      }
      window.setTimeout(() => reapplyPageRotationsRef.current(), 0);
      const pending = pendingScrollRef.current;
      const finishRestore = () => {
        // Always re-read from IDB after the viewer is ready (EPUB→PDF handoff).
        void jumpToSavedPageRef.current(openedDocPathRef.current).finally(() => {
          suppressPersistRef.current = false;
        });
      };
      if (pending) {
        window.setTimeout(() => {
          const maxTop = Math.max(
            0,
            container.scrollHeight - container.clientHeight,
          );
          const maxLeft = Math.max(
            0,
            container.scrollWidth - container.clientWidth,
          );
          container.scrollTop = Math.min(maxTop, Math.max(0, pending.top));
          container.scrollLeft = Math.min(maxLeft, Math.max(0, pending.left));
          pendingScrollRef.current = null;
          finishRestore();
        }, 80);
      } else {
        finishRestore();
      }
    };

    eventBus.on("pagechanging", onPageChanging);
    eventBus.on("scalechanging", onScaleChanging);
    eventBus.on("pagesinit", onPagesInit);

    return () => {
      suppressPersistRef.current = true;
      eventBus.off("pagechanging", onPageChanging);
      eventBus.off("scalechanging", onScaleChanging);
      eventBus.off("pagesinit", onPagesInit);
      try {
        pdfViewer.setDocument(null as never);
      } catch {
        /* ignore */
      }
      pdfViewerRef.current = null;
      eventBusRef.current = null;
      linkServiceRef.current = null;
      findControllerRef.current = null;
      viewerReadyRef.current = false;
      setViewerReady(false);
    };
  }, [restoring, applyScrollSpread]);

  // PDFViewer normally refreshes its visible-page set from scroll events.
  // Maximizing/restoring the desktop window changes the container dimensions
  // without scrolling, which can leave the newly visible spread page blank
  // until the user touches the wheel. Refresh once after layout and again
  // after the resize settles so both pages are rendered immediately.
  useEffect(() => {
    if (restoring || !viewerReady) return;
    const container = scrollRef.current;
    if (!container) return;

    let frame = 0;
    let settleTimer = 0;
    const updateViewer = () => {
      const viewer = pdfViewerRef.current;
      if (!viewer || !visibleRef.current) return;
      viewer.update();
    };
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      frame = window.requestAnimationFrame(updateViewer);
      settleTimer = window.setTimeout(updateViewer, 160);
    };

    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(container);
    window.addEventListener("resize", scheduleUpdate);
    scheduleUpdate();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
    };
  }, [restoring, viewerReady, visible]);

  // Load document into viewer when file / viewer are ready
  useEffect(() => {
    if (restoring || !file || !viewerReady) return;
    const pdfViewer = pdfViewerRef.current;
    if (!pdfViewer) return;
    let cancelled = false;
    setDocLoading(true);
    setError(null);
    pageExtraRotationRef.current.clear();

    (async () => {
      try {
        const data = await file.arrayBuffer();
        if (cancelled) return;
        const loadingTask = getDocument({
          data: data.slice(0),
          ...PDF_DOCUMENT_OPTIONS,
        });
        const pdf = await loadingTask.promise;
        if (cancelled) {
          void pdf.destroy();
          return;
        }
        pdfRef.current = pdf;
        setNumPages(pdf.numPages);
        try {
          const page = await pdf.getPage(1);
          pageWidthRef.current = page.getViewport({ scale: 1 }).width;
        } catch {
          pageWidthRef.current = 0;
        }
        let labels: string[] | null = null;
        try {
          const rawLabels = await pdf.getPageLabels();
          if (rawLabels?.length === pdf.numPages) {
            labels = rawLabels;
          }
        } catch {
          labels = null;
        }
        if (cancelled) return;
        try {
          const raw = await pdf.getOutline();
          setOutline(await buildOutline(pdf, raw, labels));
        } catch {
          setOutline([]);
        }
        linkServiceRef.current?.setDocument(pdf, null);
        findControllerRef.current?.setDocument(pdf);
        pdfViewer.setDocument(pdf);
        if (labels) {
          pdfViewer.setPageLabels(labels);
          setPageLabels(labels);
        } else {
          pdfViewer.setPageLabels(null);
          setPageLabels(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setNumPages(0);
        }
      } finally {
        if (!cancelled) setDocLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      suppressPersistRef.current = true;
      try {
        pdfViewerRef.current?.setDocument(null as never);
      } catch {
        /* ignore */
      }
      try {
        linkServiceRef.current?.setDocument(null);
      } catch {
        /* ignore */
      }
      try {
        findControllerRef.current?.setDocument(null as never);
      } catch {
        /* ignore */
      }
      const prev = pdfRef.current;
      pdfRef.current = null;
      setPageLabels(null);
      void prev?.destroy();
    };
  }, [restoring, file, viewerReady]);

  // Session restore on first mount (path-only: re-read from disk)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await loadPdfSession();
      if (cancelled) return;
      if (!session?.filePath) {
        setRestoring(false);
        return;
      }
      try {
        const doc = await loadLocalDoc(session.filePath);
        if (cancelled) return;
        const hash = await sha256Hex(doc.bytes);
        if (cancelled) return;
        if (session.contentHash && session.contentHash !== hash) {
          setRestoring(false);
          void refreshRecent();
          await handlePdfIntegrityIssueRef.current({
            reason: "changed",
            saved: session,
            oldPath: session.filePath,
          });
          return;
        }
        suppressPersistRef.current = true;
        contentHashRef.current = hash;
        const restored = new File([doc.bytes], doc.fileName, {
          type: "application/pdf",
          lastModified: doc.lastModified || Date.now(),
        });
        setFile(restored);
        setFileMeta({
          filePath: doc.filePath,
          fileName: doc.fileName,
          fileSize: doc.fileSize,
          lastModified: doc.lastModified,
        });
        setViewMode(
          isViewMode(session.viewMode) ? session.viewMode : "single-scroll",
        );
        const keepPage = sanitizePdfPage(session.pageNumber);
        restoreTargetPageRef.current = keepPage;
        restoredPageRef.current = keepPage;
        committedPageRef.current = keepPage;
        setPageNumber(keepPage);
        const savedScale = session.scale || DEFAULT_SCALE;
        setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, savedScale)));
        setOutlineOpen(!!session.outlineOpen);
        pendingScrollRef.current = {
          top: session.scrollTop || 0,
          left: session.scrollLeft || 0,
        };
        setError(null);
        if (!session.contentHash) {
          await savePdfSession({ ...session, contentHash: hash });
        }
      } catch {
        if (!cancelled) {
          setRestoring(false);
          void refreshRecent();
          await handlePdfIntegrityIssueRef.current({
            reason: "missing",
            saved: session,
            oldPath: session.filePath,
          });
          return;
        }
      } finally {
        if (!cancelled) {
          setRestoring(false);
          void refreshRecent();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshRecent]);

  // Persist on hide only. Becoming visible must NOT sync the live viewer
  // (it is still on page 1 after EPUB→PDF remount) — pagesinit/jumpToSavedPage
  // own restore.
  useEffect(() => {
    if (!visible) return;

    return () => {
      if (!fileMetaRef.current) return;
      const path = fileMetaRef.current.filePath;
      const keepHide = sanitizePdfPage(
        restoreTargetPageRef.current ??
          forcedResumePageRef.current ??
          lastGoodPageByPathRef.current.get(path) ??
          committedPageRef.current,
      );
      restoredPageRef.current = keepHide;
      committedPageRef.current = keepHide;
      if (keepHide > 1 && path) {
        lastGoodPageByPathRef.current.set(path, keepHide);
      }
      suppressPersistRef.current = true;
      persistMetaRef.current({ immediate: true, force: true });
    };
  }, [visible]);

  const applyOpenedDoc = useCallback(
    async (
      doc: {
        filePath: string;
        fileName: string;
        fileSize: number;
        lastModified: number;
        bytes: ArrayBuffer;
      },
      opts?: {
        restoreFromSession?: boolean;
        /** Prefer this position (e.g. from 最近打开) over the current session. */
        resume?: PdfResume;
        contentHash?: string;
        /** When relocating, remove the old recent key. */
        relocateFrom?: string;
      },
    ) => {
      const hash = opts?.contentHash || (await sha256Hex(doc.bytes));

      // Same book already open (content hash match): keep the viewer, only
      // refresh path/session metadata when needed.
      const sameBookOpen =
        !!hash &&
        contentHashRef.current === hash &&
        openedDocPathRef.current != null &&
        !!pdfRef.current;

      if (sameBookOpen) {
        setError(null);
        setRecentOpen(false);
        const live = pdfViewerRef.current?.currentPageNumber;
        const liveOk =
          pdfViewerRef.current &&
          (pdfViewerRef.current.pagesCount || 0) > 0 &&
          typeof live === "number" &&
          live > 1;
        if (liveOk && live != null) {
          committedPageRef.current = live;
          restoredPageRef.current = live;
          lastGoodPageByPathRef.current.set(doc.filePath, live);
          persistMetaRef.current({ immediate: true, force: true });
          void refreshRecent();
          return;
        }
        const pathChanged = openedDocPathRef.current !== doc.filePath;
        const needRelocate =
          !!opts?.relocateFrom && opts.relocateFrom !== doc.filePath;
        const saved = await fetchSavedPdfProgress(doc.filePath);
        const page = sanitizePdfPage(
          opts?.resume?.pageNumber ??
            lastGoodPageByPathRef.current.get(doc.filePath) ??
            saved?.pageNumber ??
            committedPageRef.current,
        );
        if (pathChanged || needRelocate) {
          if (openedDocPathRef.current !== doc.filePath) {
            onDocumentChange?.();
          }
          openedDocPathRef.current = doc.filePath;
          setFileMeta({
            filePath: doc.filePath,
            fileName: doc.fileName,
            fileSize: doc.fileSize,
            lastModified: doc.lastModified,
          });
          const root = scrollRef.current;
          const next: PdfSession = {
            filePath: doc.filePath,
            fileName: doc.fileName,
            fileSize: doc.fileSize,
            lastModified: doc.lastModified,
            viewMode,
            pageNumber: page,
            scale,
            scrollTop: root?.scrollTop ?? saved?.scrollTop ?? 0,
            scrollLeft: root?.scrollLeft ?? saved?.scrollLeft ?? 0,
            outlineOpen,
            contentHash: hash,
          };
          if (needRelocate) {
            await relocatePdfRecent(opts!.relocateFrom!, next);
          } else {
            await savePdfSession(next);
          }
        }
        await jumpToSavedPage(doc.filePath);
        void refreshRecent();
        return;
      }

      if (
        openedDocPathRef.current !== null &&
        openedDocPathRef.current !== doc.filePath
      ) {
        onDocumentChange?.();
      }
      openedDocPathRef.current = doc.filePath;
      contentHashRef.current = hash;

      // Always re-read this book's saved progress from IDB.
      const savedProgress = await fetchSavedPdfProgress(doc.filePath);
      const resume = opts?.resume ?? savedProgress;
      const restoreFrom: PdfResume | null = resume;

      // Commit restore targets BEFORE setFile so document-load / pagesinit
      // never race with a missing target (which defaulted to page 1).
      if (restoreFrom) {
        const keep = sanitizePdfPage(restoreFrom.pageNumber);
        suppressPersistRef.current = true;
        forcedResumePageRef.current = keep;
        restoreTargetPageRef.current = keep;
        restoredPageRef.current = keep;
        committedPageRef.current = keep;
        setPageNumber(keep);
        pendingScrollRef.current = {
          top: restoreFrom.scrollTop || 0,
          left: restoreFrom.scrollLeft || 0,
        };
      } else {
        suppressPersistRef.current = true;
        forcedResumePageRef.current = null;
        restoreTargetPageRef.current = 1;
        restoredPageRef.current = 1;
        committedPageRef.current = 1;
        setPageNumber(1);
        pendingScrollRef.current = { top: 0, left: 0 };
      }

      const f = new File([doc.bytes], doc.fileName, {
        type: "application/pdf",
        lastModified: doc.lastModified || Date.now(),
      });
      setFile(f);
      setFileMeta({
        filePath: doc.filePath,
        fileName: doc.fileName,
        fileSize: doc.fileSize,
        lastModified: doc.lastModified,
      });
      setOutline([]);
      setSearchHits([]);
      setError(null);
      setRecentOpen(false);

      const buildSession = (
        page: number,
        scrollTop: number,
        scrollLeft: number,
        view: ViewMode,
        nextScale: number,
        nextOutline: boolean,
      ): PdfSession => ({
        filePath: doc.filePath,
        fileName: doc.fileName,
        fileSize: doc.fileSize,
        lastModified: doc.lastModified,
        viewMode: view,
        pageNumber: page,
        scale: nextScale,
        scrollTop,
        scrollLeft,
        outlineOpen: nextOutline,
        contentHash: hash,
      });

      if (restoreFrom) {
        const keep = sanitizePdfPage(restoreFrom.pageNumber);
        const nextView = isViewMode(restoreFrom.viewMode)
          ? restoreFrom.viewMode
          : viewMode;
        if (isViewMode(restoreFrom.viewMode)) setViewMode(restoreFrom.viewMode);
        const nextScale = restoreFrom.scale
          ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, restoreFrom.scale))
          : scale;
        if (restoreFrom.scale) setScale(nextScale);
        const nextOutline = !!restoreFrom.outlineOpen;
        setOutlineOpen(nextOutline);
        const next = buildSession(
          keep,
          restoreFrom.scrollTop || 0,
          restoreFrom.scrollLeft || 0,
          nextView,
          nextScale,
          nextOutline,
        );
        if (opts?.relocateFrom && opts.relocateFrom !== doc.filePath) {
          await relocatePdfRecent(opts.relocateFrom, next);
        } else {
          await savePdfSession(next);
        }
        void refreshRecent();
        // Viewer may not be ready yet; pagesinit will call jumpToSavedPage too.
        await jumpToSavedPage(doc.filePath);
        return;
      }

      try {
        const next = buildSession(1, 0, 0, viewMode, scale, outlineOpen);
        if (opts?.relocateFrom && opts.relocateFrom !== doc.filePath) {
          await relocatePdfRecent(opts.relocateFrom, next);
        } else {
          await savePdfSession(next);
        }
        void refreshRecent();
      } catch {
        // ignore
      }
    },
    [
      jumpToSavedPage,
      onDocumentChange,
      outlineOpen,
      refreshRecent,
      scale,
      viewMode,
    ],
  );

  const handlePdfIntegrityIssue = useCallback(
    async (args: {
      reason: "missing" | "changed";
      saved: PdfSession;
      oldPath: string;
    }) => {
      const { reason, saved, oldPath } = args;
      const fileName = saved.fileName || oldPath;

      const resumeFromSaved = (): PdfResume => ({
        pageNumber: sanitizePdfPage(saved.pageNumber),
        scrollTop: saved.scrollTop || 0,
        scrollLeft: saved.scrollLeft || 0,
        viewMode: isViewMode(saved.viewMode) ? saved.viewMode : viewMode,
        scale: saved.scale || scale,
        outlineOpen: !!saved.outlineOpen,
        contentHash: saved.contentHash,
      });

      const openWithDoc = async (
        doc: LocalDocFile,
        hash: string,
        applyProgress: boolean,
      ) => {
        await applyOpenedDoc(doc, {
          restoreFromSession: true,
          relocateFrom: oldPath,
          contentHash: hash,
          resume: applyProgress ? resumeFromSaved() : undefined,
        });
        setError(null);
      };

      const runRelocateLoop = async (): Promise<void> => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const path = await pickDocumentPath(["pdf"]);
          if (!path) {
            // User cancelled the file dialog — abort with no further UI.
            setError(null);
            setRecentOpen(false);
            return;
          }
          let doc: LocalDocFile;
          let hash: string;
          try {
            doc = await loadLocalDoc(path);
            hash = await sha256Hex(doc.bytes);
          } catch {
            setError("无法读取所选文件，请重试。");
            continue;
          }

          const expected = (saved.contentHash || "").trim();
          if (!expected || expected === hash) {
            await openWithDoc(doc, hash, true);
            return;
          }

          const mismatch = await promptHashMismatch(fileName);
          if (mismatch === "apply") {
            await openWithDoc(doc, hash, true);
            return;
          }
          if (mismatch === "relocate") continue;
          if (mismatch === "delete") {
            await removeRecentPdf(oldPath);
            void refreshRecent();
            setError(null);
            setRecentOpen(false);
            return;
          }
          // Cancel on mismatch dialog — stop, no banner.
          setError(null);
          setRecentOpen(false);
          return;
        }
      };

      const action = await promptPdfInvalid(fileName, reason);
      if (action === "relocate") {
        await runRelocateLoop();
        return;
      }
      if (action === "delete") {
        await removeRecentPdf(oldPath);
        void refreshRecent();
        setError(null);
        setRecentOpen(false);
        return;
      }
      // Cancel: leave UI exactly as before the click — no error banner, no further dialogs.
      setError(null);
      setRecentOpen(false);
    },
    [applyOpenedDoc, refreshRecent, scale, viewMode],
  );

  handlePdfIntegrityIssueRef.current = handlePdfIntegrityIssue;

  const openFilePicker = useCallback(async () => {
    try {
      const doc = await pickAndLoadDocument(["pdf", "epub"]);
      if (!doc) return;
      const kind = detectDocKind(doc.filePath);
      if (kind === "epub") {
        persistMetaRef.current({ immediate: true, force: true });
        onOpenOtherKind?.("epub", doc);
        return;
      }
      const hash = await sha256Hex(doc.bytes);
      const session = await loadPdfSession();
      if (
        session?.filePath === doc.filePath &&
        session.contentHash &&
        session.contentHash !== hash
      ) {
        await handlePdfIntegrityIssue({
          reason: "changed",
          saved: session,
          oldPath: session.filePath,
        });
        return;
      }
      await applyOpenedDoc(doc, {
        contentHash: hash,
        resume:
          session?.filePath === doc.filePath
            ? {
                pageNumber: session.pageNumber,
                scrollTop: session.scrollTop,
                scrollLeft: session.scrollLeft,
                viewMode: session.viewMode,
                scale: session.scale,
                outlineOpen: session.outlineOpen,
                contentHash: hash,
              }
            : undefined,
        restoreFromSession: session?.filePath === doc.filePath,
      });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "打开 PDF 失败。请确认文件仍在原路径。",
      );
    }
  }, [applyOpenedDoc, handlePdfIntegrityIssue, onOpenOtherKind]);

  const openRecent = useCallback(
    async (item: LitRecentItem) => {
      if (item.kind === "epub") {
        try {
          // Flush PDF progress before the pane is hidden for EPUB.
          persistMetaRef.current({ immediate: true, force: true });
          const doc = await loadLocalDoc(item.filePath);
          onOpenOtherKind?.("epub", doc);
          setRecentOpen(false);
        } catch {
          setError(
            "找不到该 EPUB（文件可能已移动或变更）。请重新选择文件；阅读进度仍会保留。",
          );
          setRecentOpen(false);
        }
        return;
      }
      const entry = await loadRecentPdf(item.filePath);
      if (!entry?.filePath) return;
      try {
        const doc = await loadLocalDoc(entry.filePath);
        const hash = await sha256Hex(doc.bytes);
        if (entry.contentHash && entry.contentHash !== hash) {
          await handlePdfIntegrityIssue({
            reason: "changed",
            saved: entry,
            oldPath: entry.filePath,
          });
          return;
        }
        const keepPage = sanitizePdfPage(entry.pageNumber);
        await applyOpenedDoc(doc, {
          restoreFromSession: true,
          contentHash: hash,
          resume: {
            pageNumber: keepPage,
            scrollTop: entry.scrollTop || 0,
            scrollLeft: entry.scrollLeft || 0,
            viewMode: isViewMode(entry.viewMode) ? entry.viewMode : viewMode,
            scale: entry.scale || scale,
            outlineOpen: !!entry.outlineOpen,
            contentHash: hash,
          },
        });
        void refreshRecent();
      } catch {
        await handlePdfIntegrityIssue({
          reason: "missing",
          saved: entry,
          oldPath: entry.filePath,
        });
      }
    },
    [
      applyOpenedDoc,
      handlePdfIntegrityIssue,
      onOpenOtherKind,
      refreshRecent,
      scale,
      viewMode,
    ],
  );

  const removeRecent = useCallback(
    async (item: LitRecentItem) => {
      await removeRecentDocument(item);
      await refreshRecent();
    },
    [refreshRecent],
  );

  // Seed from LiteratureView / EpubPane handoff — wait until this pane is
  // actually shown so the viewer exists before we try to jump.
  useEffect(() => {
    if (!seedDoc || !visible) return;
    let cancelled = false;
    (async () => {
      try {
        const hash = await sha256Hex(seedDoc.bytes);
        if (cancelled) return;
        const saved = await fetchSavedPdfProgress(seedDoc.filePath);
        if (cancelled) return;
        const remembered = lastGoodPageByPathRef.current.get(seedDoc.filePath);
        const hint =
          typeof seedPageNumber === "number" && seedPageNumber > 0
            ? Math.floor(seedPageNumber)
            : 0;
        const page = sanitizePdfPage(
          hint > 0
            ? hint
            : (remembered ?? saved?.pageNumber ?? committedPageRef.current),
        );
        if (page > 1) {
          lastGoodPageByPathRef.current.set(seedDoc.filePath, page);
        }
        forcedResumePageRef.current = page;
        restoreTargetPageRef.current = page;
        suppressPersistRef.current = true;
        await applyOpenedDoc(seedDoc, {
          contentHash: hash,
          resume: {
            pageNumber: page,
            scrollTop: saved?.scrollTop || 0,
            scrollLeft: saved?.scrollLeft || 0,
            viewMode: saved?.viewMode,
            scale: saved?.scale,
            outlineOpen: saved?.outlineOpen,
            contentHash: saved?.contentHash,
          },
          restoreFromSession: true,
        });
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "打开 PDF 失败");
        }
      } finally {
        if (!cancelled) onSeedConsumed?.();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedDoc, visible]);

  const runPdfSearch = useCallback(async () => {
    const pdf = pdfRef.current;
    const q = searchQuery.trim();
    if (!pdf || !q) {
      setSearchHits([]);
      return;
    }
    setSearchBusy(true);
    setSearchOpen(true);
    try {
      const needle = q.toLowerCase();
      const hits: { page: number; snippet: string; matchIndex: number }[] = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const parts: string[] = [];
        for (const item of content.items) {
          if (item && typeof item === "object" && "str" in item) {
            parts.push(String((item as { str: string }).str));
          }
        }
        const text = parts.join(" ").replace(/\s+/g, " ").trim();
        const lower = text.toLowerCase();
        let from = 0;
        let guard = 0;
        while (guard++ < 20) {
          const idx = lower.indexOf(needle, from);
          if (idx < 0) break;
          const start = Math.max(0, idx - 24);
          const end = Math.min(text.length, idx + needle.length + 36);
          let snippet = text.slice(start, end);
          if (start > 0) snippet = "…" + snippet;
          if (end < text.length) snippet = snippet + "…";
          hits.push({ page: p, snippet, matchIndex: hits.length });
          from = idx + needle.length;
          if (hits.length >= 200) break;
        }
        if (hits.length >= 200) break;
      }
      setSearchHits(hits);
      eventBusRef.current?.dispatch("find", {
        source: null,
        type: "",
        query: q,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious: false,
        matchDiacritics: false,
      });
    } catch {
      setSearchHits([]);
    } finally {
      setSearchBusy(false);
    }
  }, [searchQuery]);

  const jumpToSearchHit = useCallback(
    (hit: { page: number; snippet: string; matchIndex: number }) => {
      const q = searchQuery.trim();
      goToPage(hit.page);
      if (q) {
        eventBusRef.current?.dispatch("find", {
          source: null,
          type: "",
          query: q,
          caseSensitive: false,
          entireWord: false,
          highlightAll: true,
          findPrevious: false,
          matchDiacritics: false,
        });
      }
    },
    [goToPage, searchQuery],
  );

  const extractCurrentPage = useCallback(
    async (forceOcr = false) => {
      const pdf = pdfRef.current;
      if (!pdf || pageOcrBusy) return;
      const currentPage = Math.max(1, Math.min(pdf.numPages, pageNumberRef.current));
      const mode = normalizeOcrMode(ocrMode);
      const documentKey =
        contentHashRef.current ||
        fileMetaRef.current?.filePath ||
        `${file?.name || "pdf"}:${file?.size || 0}`;
      const cacheKey = `${documentKey}:${currentPage}:${forceOcr ? `ocr-${mode}` : "smart"}`;
      const cached = pageTextCacheRef.current.get(cacheKey);
      if (cached) {
        onTextSelected(cached.text);
        setPageOcrStatus(cached.status);
        return;
      }

      setPageOcrBusy(true);
      setPageOcrStatus(forceOcr ? `正在使用${OCR_MODE_LABELS[mode]}识别第 ${currentPage} 页…` : `正在提取第 ${currentPage} 页…`);
      try {
        const page = await pdf.getPage(currentPage);
        const unitViewport = page.getViewport({ scale: 1 });
        const imagePdfRects = await collectPageImageRects(page).catch(() => []);
        const toPixelRects = (scale: number): PixelRect[] => {
          const viewport = page.getViewport({ scale });
          return imagePdfRects.map((rect) => {
            const [x1, y1] = viewport.convertToViewportPoint(rect.xMin, rect.yMin);
            const [x2, y2] = viewport.convertToViewportPoint(rect.xMax, rect.yMax);
            return {
              x0: Math.min(x1, x2),
              y0: Math.min(y1, y2),
              x1: Math.max(x1, x2),
              y1: Math.max(y1, y2),
            };
          });
        };

        const nativeLines = forceOcr ? [] : await extractNativePdfLines(page);
        if (!forceOcr && nativeTextLooksUsable(nativeLines)) {
          const structured = buildStructuredPdfText(
            nativeLines,
            unitViewport.width,
            unitViewport.height,
            toPixelRects(1),
          );
          if (!structured.text) throw new Error("本页没有可提取的正文");
          const status = `第 ${currentPage} 页使用原生文字层 · ${structured.keptLines} 行${
            structured.listItems ? ` · ${structured.listItems} 个列表项` : ""
          }${structured.tableCount ? ` · ${structured.tableCount} 个表格/${structured.tableRows} 行` : ""
          }${structured.removedPageNumbers ? ` · 已排除 ${structured.removedPageNumbers} 个页码` : ""}${
            structured.removedImageLines ? ` · 已排除 ${structured.removedImageLines} 行图片文字` : ""
          }`;
          pageTextCacheRef.current.set(cacheKey, { text: structured.text, status });
          onTextSelected(structured.text);
          setPageOcrStatus(status);
          return;
        }

        const longestSide = Math.max(unitViewport.width, unitViewport.height);
        const renderScale = Math.min(4, Math.max(2.5, 2800 / Math.max(1, longestSide)));
        const viewport = page.getViewport({ scale: renderScale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("无法创建 PDF OCR 画布");
        await page.render({ canvasContext: context, viewport }).promise;

        const imageRects = toPixelRects(renderScale);
        const pageArea = Math.max(1, canvas.width * canvas.height);
        const isScannedPage = imageRects.some(
          (rect) => ((rect.x1 - rect.x0) * (rect.y1 - rect.y0)) / pageArea >= 0.68,
        );
        const excludedImageRects = isScannedPage ? [] : imageRects;
        if (!isScannedPage) {
          context.save();
          context.fillStyle = "#fff";
          for (const rect of excludedImageRects) {
            const pad = 2;
            context.fillRect(
              Math.max(0, rect.x0 - pad),
              Math.max(0, rect.y0 - pad),
              Math.min(canvas.width, rect.x1 + pad) - Math.max(0, rect.x0 - pad),
              Math.min(canvas.height, rect.y1 + pad) - Math.max(0, rect.y0 - pad),
            );
          }
          context.restore();
        }

        const blob = await canvasToPngBlob(canvas);
        let engine = pageOcrEnginesRef.current.get(mode);
        if (!engine) {
          engine = new LocalPaddleOcr(mode);
          pageOcrEnginesRef.current.set(mode, engine);
        }
        setPageOcrStatus(`正在使用${OCR_MODE_LABELS[mode]}识别第 ${currentPage} 页…`);
        const recognition = await engine.recognize(blob);
        const structured = buildStructuredPdfText(
          paddleLinesToPdfLines(recognition.lines),
          canvas.width,
          canvas.height,
          excludedImageRects,
        );
        if (!structured.text) throw new Error("本页没有识别到可复制的正文");
        const status = `第 ${currentPage} 页使用${OCR_MODE_LABELS[mode]} · ${structured.keptLines} 行${
          structured.listItems ? ` · ${structured.listItems} 个列表项` : ""
        }${structured.tableCount ? ` · ${structured.tableCount} 个表格/${structured.tableRows} 行` : ""
        }${structured.removedPageNumbers ? ` · 已排除 ${structured.removedPageNumbers} 个页码` : ""}${
          excludedImageRects.length ? ` · 已屏蔽 ${excludedImageRects.length} 个图片区域` : ""
        }`;
        pageTextCacheRef.current.set(cacheKey, { text: structured.text, status });
        onTextSelected(structured.text);
        setPageOcrStatus(status);
      } catch (reason) {
        setPageOcrStatus(
          reason instanceof Error ? reason.message : "PDF 页面提取失败",
        );
      } finally {
        setPageOcrBusy(false);
      }
    },
    [file, ocrMode, onTextSelected, pageOcrBusy],
  );

  const readPdfSelection = useCallback((): string | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const anchor = sel.anchorNode;
    const focus = sel.focusNode;
    const root = scrollRef.current;
    if (!root || !anchor || !focus) return null;
    if (!root.contains(anchor) || !root.contains(focus)) return null;

    const fragments: PdfTextFragment[] = [];
    try {
      for (let ri = 0; ri < sel.rangeCount; ri++) {
        const range = sel.getRangeAt(ri);
        const ancestor = range.commonAncestorContainer;
        const scope: Node =
          ancestor.nodeType === Node.ELEMENT_NODE
            ? ancestor
            : ancestor.parentElement || ancestor;
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          if (!range.intersectsNode(node)) {
            node = walker.nextNode();
            continue;
          }
          if (isPrintedPageNumberNode(node)) {
            node = walker.nextNode();
            continue;
          }
          const full = node.textContent || "";
          let start = 0;
          let end = full.length;
          if (node === range.startContainer) start = range.startOffset;
          if (node === range.endContainer) end = range.endOffset;
          if (end > start) {
            fragments.push({
              text: full.slice(start, end),
              rect: spanRectForTextNode(node),
              pageNumber: pageNumberForTextNode(node),
            });
          }
          node = walker.nextNode();
        }
      }
    } catch {
      fragments.length = 0;
    }

    const text =
      fragments.length > 0
        ? mergePdfTextFragments(fragments)
        : normalizePdfExtractedText(sel.toString());
    return text || null;
  }, []);

  const scheduleSelectionTranslate = useCallback(() => {
    if (handMode) return;
    if (selectingRef.current) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      if (selectingRef.current) return;
      const text = readPdfSelection();
      if (!text) return;
      if (text === lastEmittedTextRef.current) return;
      lastEmittedTextRef.current = text;
      onTextSelected(text);
    }, 650);
  }, [handMode, onTextSelected, readPdfSelection]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const root = scrollRef.current;
      if (!root || !(e.target instanceof Node) || !root.contains(e.target)) {
        return;
      }
      if (handMode) return;
      selectingRef.current = true;
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
    const onPointerUp = () => {
      if (!selectingRef.current) return;
      selectingRef.current = false;
      scheduleSelectionTranslate();
    };
    const onSelectionChange = () => {
      if (selectingRef.current) {
        if (debounceRef.current) {
          window.clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        return;
      }
      if (readPdfSelection()) {
        scheduleSelectionTranslate();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [handMode, readPdfSelection, scheduleSelectionTranslate]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!viewMenuRef.current?.contains(t)) {
        setViewMenuOpen(false);
      }
      if (!openMenuRef.current?.contains(t)) {
        setRecentOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Mark selectable PDF images with a hand cursor after each page render.
  useEffect(() => {
    const eventBus = eventBusRef.current;
    if (!eventBus || !file || !viewerReady) return;

    let cancelled = false;
    const onPageRendered = (evt: {
      pageNumber?: number;
      source?: { div?: HTMLElement | null };
    }) => {
      const pageNum = evt.pageNumber;
      const pageEl =
        evt.source?.div ||
        (typeof pageNum === "number"
          ? (scrollRef.current?.querySelector(
              `.page[data-page-number="${pageNum}"]`,
            ) as HTMLElement | null)
          : null);
      if (!pageEl || !Number.isFinite(pageNum) || (pageNum as number) < 1) {
        return;
      }
      const pdf = pdfRef.current;
      if (!pdf) return;
      void (async () => {
        try {
          const page = await pdf.getPage(pageNum as number);
          if (cancelled) return;
          await syncPageImageHotspots(page, pageEl);
        } catch {
          /* ignore hotspot sync errors */
        }
      })();
    };

    eventBus.on("pagerendered", onPageRendered);
    return () => {
      cancelled = true;
      eventBus.off("pagerendered", onPageRendered);
      if (scrollRef.current) clearPageImageHotspots(scrollRef.current);
    };
  }, [file, viewerReady]);

  // Right-click on PDF page: zoom/fit (whole doc) + rotate (this page); image actions if hit
  // Double-click image: open fullscreen preview
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !file) return;

    const resolveHit = async (
      pageEl: HTMLElement,
      pageNum: number,
      clientX: number,
      clientY: number,
    ) => {
      const pdf = pdfRef.current;
      if (!pdf) return null;
      try {
        const page = await pdf.getPage(pageNum);
        return await findImageAtPoint(page, pageNum, pageEl, clientX, clientY);
      } catch {
        return null;
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      if (handMode) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const pageEl = target.closest(".page") as HTMLElement | null;
      if (!pageEl || !root.contains(pageEl)) return;

      const pageNum = Number(
        pageEl.dataset.pageNumber || pageEl.getAttribute("data-page-number"),
      );
      if (!Number.isFinite(pageNum) || pageNum < 1) return;

      e.preventDefault();
      e.stopPropagation();
      const clientX = e.clientX;
      const clientY = e.clientY;
      // Capture selection before async work (selection may clear later).
      const selectedText = readPdfSelection();
      setImgBusy(true);
      void (async () => {
        const imageHit = await resolveHit(pageEl, pageNum, clientX, clientY);
        setImgBusy(false);
        setImgMenu((prev) => {
          if (prev?.imageHit?.objectUrl) {
            URL.revokeObjectURL(prev.imageHit.objectUrl);
          }
          return {
            x: clientX,
            y: clientY,
            pageNumber: pageNum,
            imageHit,
            selectedText,
          };
        });
      })();
    };

    const onDblClick = (e: MouseEvent) => {
      if (handMode) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // textLayer 常盖住图片；与右键一样按坐标命中，有图则预览，无图则保留选词
      const pageEl = target.closest(".page") as HTMLElement | null;
      if (!pageEl || !root.contains(pageEl)) return;

      const pageNum = Number(
        pageEl.dataset.pageNumber || pageEl.getAttribute("data-page-number"),
      );
      if (!Number.isFinite(pageNum) || pageNum < 1) return;

      const clientX = e.clientX;
      const clientY = e.clientY;
      setImgBusy(true);
      void (async () => {
        const imageHit = await resolveHit(pageEl, pageNum, clientX, clientY);
        setImgBusy(false);
        if (!imageHit) return;
        window.getSelection()?.removeAllRanges();
        setImgPreview((prev) => {
          if (prev?.hit.objectUrl) URL.revokeObjectURL(prev.hit.objectUrl);
          return {
            hit: imageHit,
            zoom: 1,
            naturalW: 0,
            naturalH: 0,
          };
        });
      })();
    };

    root.addEventListener("contextmenu", onContextMenu, true);
    root.addEventListener("dblclick", onDblClick, true);
    return () => {
      root.removeEventListener("contextmenu", onContextMenu, true);
      root.removeEventListener("dblclick", onDblClick, true);
    };
  }, [file, handMode, viewerReady, readPdfSelection]);

  // Ctrl/Meta + wheel → zoom 15%; Shift + wheel → horizontal scroll.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        const dir = e.deltaY > 0 ? -1 : 1;
        changeScale((s) => s + dir * SCALE_STEP);
        return;
      }
      if (e.shiftKey) {
        root.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [changeScale, file, restoring, viewerReady]);

  useEffect(() => {
    return () => {
      if (imgMenu?.imageHit?.objectUrl) {
        URL.revokeObjectURL(imgMenu.imageHit.objectUrl);
      }
      if (imgPreview?.hit.objectUrl) {
        URL.revokeObjectURL(imgPreview.hit.objectUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeImgMenu = useCallback(() => {
    setImgMenu((prev) => {
      if (prev?.imageHit?.objectUrl) {
        URL.revokeObjectURL(prev.imageHit.objectUrl);
      }
      return null;
    });
  }, []);

  const closeImgPreview = useCallback(() => {
    setImgPreview((prev) => {
      if (prev?.hit.objectUrl) URL.revokeObjectURL(prev.hit.objectUrl);
      return null;
    });
  }, []);

  const showImgToast = useCallback((message: string, ok = true) => {
    if (imgToastTimerRef.current != null) {
      window.clearTimeout(imgToastTimerRef.current);
    }
    setImgToast({ message, ok });
    imgToastTimerRef.current = window.setTimeout(() => {
      setImgToast(null);
      imgToastTimerRef.current = null;
    }, 1600);
  }, []);

  const copySelectedPdfText = useCallback(
    async (text: string) => {
      const ok = await copyPlainText(text);
      showImgToast(ok ? "已复制选中文本" : "复制失败", ok);
    },
    [showImgToast],
  );

  const copyCurrentPageText = useCallback(
    async (pageNumber: number) => {
      const root = scrollRef.current;
      const pageEl = root?.querySelector(
        `.page[data-page-number="${pageNumber}"]`,
      ) as HTMLElement | null;
      let text = pageEl ? readPageTextFromDom(pageEl) : "";
      if (!text) {
        const pdf = pdfRef.current;
        if (pdf && pageNumber >= 1) {
          try {
            const page = await pdf.getPage(pageNumber);
            const content = await page.getTextContent();
            const parts: string[] = [];
            for (const item of content.items) {
              if (item && typeof item === "object" && "str" in item) {
                parts.push(String((item as { str: string }).str));
              }
            }
            text = normalizePdfExtractedText(parts.join(" "));
          } catch {
            text = "";
          }
        }
      }
      if (!text) {
        showImgToast("当前页无可复制文本", false);
        return;
      }
      const ok = await copyPlainText(text);
      showImgToast(ok ? "已复制当前页文本" : "复制失败", ok);
    },
    [showImgToast],
  );

  useEffect(() => {
    return () => {
      if (imgToastTimerRef.current != null) {
        window.clearTimeout(imgToastTimerRef.current);
      }
    };
  }, []);

  const openImgPreview = useCallback((hit: PdfImageHit) => {
    setImgPreview((prev) => {
      if (prev?.hit.objectUrl && prev.hit.objectUrl !== hit.objectUrl) {
        URL.revokeObjectURL(prev.hit.objectUrl);
      }
      return { hit, zoom: 1, naturalW: 0, naturalH: 0 };
    });
  }, []);

  const applyImgPreviewNaturalSize = useCallback(
    (img: HTMLImageElement) => {
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      if (!nw || !nh) return;
      const overlay = imgViewerRef.current;
      const barH = imgBarRef.current?.offsetHeight ?? 44;
      const stage = imgStageRef.current;
      const stagePad = stage
        ? (parseFloat(getComputedStyle(stage).paddingLeft) || 0) || 12
        : 12;
      const zoom = overlay
        ? fitImgPreviewZoom(nw, nh, overlay, barH, stagePad)
        : 1;
      setImgPreview((p) => {
        if (!p) return p;
        // Only apply initial fit once — don't reset after user zooms.
        if (p.naturalW > 0 && p.naturalH > 0) return p;
        return { ...p, naturalW: nw, naturalH: nh, zoom };
      });
    },
    [],
  );

  const nudgeImgPreviewZoom = useCallback((delta: number) => {
    setImgPreview((p) =>
      p ? { ...p, zoom: clampImgPreviewZoom(p.zoom + delta) } : p,
    );
  }, []);

  useEffect(() => {
    if (!imgPreview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeImgPreview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [imgPreview, closeImgPreview]);

  useEffect(() => {
    if (!imgPreview) return;
    const stage = imgStageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.deltaY > 0 ? -1 : 1;
      nudgeImgPreviewZoom(dir * IMG_PREVIEW_ZOOM_WHEEL);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [imgPreview, nudgeImgPreviewZoom]);

  // 菜单打开时：左键点外部关闭；右键在 PDF 页上由页面监听器换菜单位置，
  // 右键在其它区域则关闭。backdrop 不拦截指针，避免挡住再次右键。
  useEffect(() => {
    if (!imgMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const t = e.target as Node | null;
      if (t && imgCtxMenuRef.current?.contains(t)) return;
      closeImgMenu();
    };
    const onContextMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && imgCtxMenuRef.current?.contains(t)) {
        e.preventDefault();
        return;
      }
      const root = scrollRef.current;
      if (root && t && root.contains(t) && t.closest(".page")) {
        return;
      }
      closeImgMenu();
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
    };
  }, [imgMenu, closeImgMenu]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      if (metaSaveTimer.current) window.clearTimeout(metaSaveTimer.current);
    };
  }, []);

  const pageStep = viewMode.startsWith("double") ? 2 : 1;

  const onScrollPanStart = (e: ReactMouseEvent<HTMLDivElement>) => {
    const root = scrollRef.current;
    if (!root) return;
    const useHand = handMode || e.button === 1 || e.altKey;
    if (!useHand || e.button === 2) return;
    e.preventDefault();
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: root.scrollLeft,
      scrollTop: root.scrollTop,
    };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      const root = scrollRef.current;
      if (!drag?.active || !root) return;
      root.scrollLeft = drag.scrollLeft - (e.clientX - drag.startX);
      root.scrollTop = drag.scrollTop - (e.clientY - drag.startY);
    };
    const onUp = () => {
      if (dragRef.current) dragRef.current.active = false;
      persistMeta();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [persistMeta]);

  return (
    <div
      className={"pdf-pane" + (visible ? "" : " is-hidden")}
      aria-hidden={!visible}
    >
      <div className="pdf-toolbar">
        <div className="pdf-toolbar-row pdf-toolbar-primary">
        <div
          className="pdf-open-menu"
          ref={openMenuRef}
          onMouseEnter={openRecentMenu}
          onMouseLeave={scheduleCloseRecentMenu}
        >
          <button
            type="button"
            className="pdf-tool-btn"
            onClick={() => void openFilePicker()}
            title="打开 PDF"
          >
            打开 PDF
          </button>
          {recentOpen && (
            <div
              className="pdf-recent-dropdown"
              onMouseEnter={openRecentMenu}
              onMouseLeave={scheduleCloseRecentMenu}
            >
              <div className="pdf-recent-title">最近打开</div>
              {recentList.length === 0 ? (
                <div className="pdf-recent-empty">暂无记录</div>
              ) : (
                recentList.map((item) => (
                  <div key={item.id} className="pdf-recent-row">
                    <button
                      type="button"
                      className="pdf-recent-item"
                      title={`${item.filePath}${
                        item.pageNumber ? ` · 第 ${item.pageNumber} 页` : ""
                      }`}
                      onClick={() => void openRecent(item)}
                    >
                      <span className="pdf-recent-kind">
                        {recentKindLabel(item.kind)}
                      </span>
                      <span className="pdf-recent-name">{item.fileName}</span>
                      {item.kind === "pdf" && item.pageNumber ? (
                        <span className="pdf-recent-meta">
                          p.{item.pageNumber}
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="pdf-recent-remove"
                      title="从最近列表移除"
                      aria-label={`移除 ${item.fileName}`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void removeRecent(item);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        {fileMeta && (
          <span className="pdf-file-name" title={fileMeta.filePath}>
            <span className="pdf-recent-kind">{recentKindLabel("pdf")}</span>
            <span className="pdf-file-name-text">{fileMeta.fileName}</span>
          </span>
        )}

        <button
          type="button"
          className={`pdf-tool-btn${outlineOpen ? " active" : ""}`}
          disabled={!file}
          onClick={() => {
            setOutlineOpen((v) => !v);
            if (!outlineOpen) setSearchOpen(false);
          }}
          title="目录"
        >
          目录
        </button>

        <span className="pdf-toolbar-engine" title={engineBadge}>
          {engineBadge}
        </span>
        {toolbarExtra}
        </div>

        <div className="pdf-toolbar-row pdf-toolbar-secondary">
          <div className="pdf-toolbar-secondary-start">

        <button
          type="button"
          className={`pdf-tool-btn pdf-tool-icon-btn pdf-toolbar-glyph-btn${searchOpen ? " active" : ""}`}
          disabled={!file}
          onClick={() => {
            setSearchOpen((v) => !v);
            if (!searchOpen) setOutlineOpen(false);
          }}
          title="搜索"
          aria-label="搜索"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
            <path
              fill="currentColor"
              d="M10.5 4a6.5 6.5 0 1 0 4.05 11.58L19 20l1-1-4.42-4.45A6.5 6.5 0 0 0 10.5 4zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z"
            />
          </svg>
        </button>

        <button
          type="button"
          className="pdf-tool-btn"
          disabled={!file || pageOcrBusy}
          onClick={(event) => void extractCurrentPage(event.shiftKey)}
          title={`智能提取本页：原生文字优先，无可用文字层时使用${OCR_MODE_LABELS[normalizeOcrMode(ocrMode)]}。Shift+点击强制 OCR；复制结果不包含页码和图片。`}
        >
          {pageOcrBusy ? "提取中…" : "提取本页"}
        </button>

        <div className="pdf-view-menu" ref={viewMenuRef}>
          <button
            type="button"
            className="pdf-tool-btn pdf-view-trigger"
            disabled={!file}
            onClick={(e) => {
              const r = (
                e.currentTarget as HTMLButtonElement
              ).getBoundingClientRect();
              setViewMenuPos({ top: r.bottom + 4, left: r.left });
              setViewMenuOpen((v) => !v);
            }}
            title={`页面显示模式：${VIEW_OPTIONS.find((option) => option.id === viewMode)?.label || "视图"}`}
            aria-label="切换页面显示模式"
          >
            <ViewModeIcon mode={viewMode} />
            <span className="pdf-view-chevron" aria-hidden>▾</span>
          </button>
          {viewMenuOpen && viewMenuPos && (
            <div
              className="pdf-view-dropdown"
              style={{
                position: "fixed",
                top: viewMenuPos.top,
                left: viewMenuPos.left,
                zIndex: 10000,
              }}
            >
              {VIEW_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={
                    viewMode === opt.id
                      ? "pdf-view-option active"
                      : "pdf-view-option"
                  }
                  onClick={() => {
                    applyViewMode(opt.id);
                    setViewMenuOpen(false);
                  }}
                >
                  <ViewModeIcon mode={opt.id} />
                  <span className="pdf-view-option-label">{opt.label}</span>
                  <span className="pdf-view-check">{viewMode === opt.id ? "✓" : ""}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className={`pdf-tool-btn pdf-tool-icon-btn pdf-toolbar-glyph-btn${handMode ? " active" : ""}`}
          disabled={!file}
          onClick={() => setHandMode((v) => !v)}
          title="拖动手势（也可按住 Alt 拖动）"
          aria-label="拖动手势"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
            <path
              fill="currentColor"
              d="M7.5 11V6.5a1.5 1.5 0 0 1 3 0V10h.5V4.5a1.5 1.5 0 0 1 3 0V10h.5V6a1.5 1.5 0 0 1 3 0v4.5h.5V8a1.5 1.5 0 0 1 3 0v6.5c0 4.14-3.36 7.5-7.5 7.5h-1.2a7 7 0 0 1-5.57-2.77L3.3 14.7a1.65 1.65 0 0 1 2.33-2.33L7.5 14.1V11z"
            />
          </svg>
        </button>

          {pageOcrStatus ? (
            <span className="pdf-page-ocr-status" title={pageOcrStatus}>
              {pageOcrStatus}
            </span>
          ) : null}
          </div>

          <div className="pdf-toolbar-pagination">

        <button
          type="button"
          className="pdf-tool-btn pdf-tool-icon-btn pdf-tool-round-btn"
          disabled={!file || pageNumber <= 1}
          onClick={() => goToPage(pageNumber - pageStep)}
          title="上一页"
          aria-label="上一页"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="m15 6-6 6 6 6"
            />
          </svg>
        </button>
        <span
          className="pdf-page-label"
          title={
            currentPageLabel
              ? `书籍页码 ${currentPageLabel} · PDF 第 ${pageNumber} / ${numPages || "?"} 页`
              : "输入 PDF 页序（正整数）后回车"
          }
        >
          <input
            className="pdf-page-input"
            type="text"
            value={pageInput}
            onFocus={() => {
              pageInputFocusedRef.current = true;
            }}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={() => commitPageInput()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                syncPageInputDisplay(pageNumber);
                pageInputFocusedRef.current = false;
                e.currentTarget.blur();
              }
            }}
            inputMode="numeric"
            pattern="[0-9]*"
          />
          / {numPages || "—"}
        </span>
        <button
          type="button"
          className="pdf-tool-btn pdf-tool-icon-btn pdf-tool-round-btn"
          disabled={!file || !numPages || pageNumber >= numPages}
          onClick={() => goToPage(pageNumber + pageStep)}
          title="下一页"
          aria-label="下一页"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="m9 6 6 6-6 6"
            />
          </svg>
        </button>
          </div>

          <div className="pdf-toolbar-zoom">
        <button
          type="button"
          className="pdf-tool-btn pdf-tool-round-btn"
          onClick={() => changeScale((s) => s - SCALE_STEP)}
          title="缩小"
          aria-label="缩小"
        >
          −
        </button>
        <span className="pdf-scale-edit">
          <input
            className="pdf-scale-input"
            type="number"
            min={scaleToPercent(MIN_SCALE)}
            max={scaleToPercent(MAX_SCALE)}
            step={1}
            value={scaleInput}
            onChange={(e) => setScaleInput(e.target.value)}
            onBlur={commitScaleInput}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            title="自定义缩放百分比"
          />
          %
        </span>
        <button
          type="button"
          className="pdf-tool-btn pdf-tool-round-btn"
          onClick={() => changeScale((s) => s + SCALE_STEP)}
          title="放大"
          aria-label="放大"
        >
          +
        </button>
          </div>
        </div>
      </div>

      <div className="pdf-main">
        {outlineOpen && (
          <aside className="pdf-outline" style={{ width: outlineWidth }}>
            <div className="pdf-outline-body">
              <DocOutlineTree
                items={outline}
                onActivate={onOutlineActivate}
                activeKey={outlineActiveKey}
                emptyHint="当前 PDF 无目录大纲"
              />
            </div>
            <div
              className="col-resizer pdf-outline-resizer"
              title="拖动调整目录宽度"
              onMouseDown={(e) => beginOutlineResize(e, "grow-right")}
            />
          </aside>
        )}

        {searchOpen && (
          <aside
            className="pdf-outline pdf-search-pane"
            style={{ width: outlineWidth }}
          >
            <div className="pdf-outline-body">
              <div className="pdf-outline-title">搜索</div>
              <div className="pdf-search-bar">
                <input
                  value={searchQuery}
                  placeholder="输入关键词…"
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runPdfSearch();
                  }}
                />
                <button
                  type="button"
                  className="pdf-tool-btn"
                  disabled={searchBusy || !searchQuery.trim()}
                  onClick={() => void runPdfSearch()}
                >
                  {searchBusy ? "…" : "查找"}
                </button>
              </div>
              <div className="pdf-search-count">
                {searchBusy
                  ? "搜索中…"
                  : searchHits.length > 0
                    ? `${searchHits.length} 条结果`
                    : searchQuery.trim()
                      ? "无匹配"
                      : ""}
              </div>
              <ul className="pdf-outline-list">
                {searchHits.map((hit) => (
                  <li key={`${hit.page}-${hit.matchIndex}`}>
                    <button
                      type="button"
                      className="pdf-outline-item pdf-search-hit"
                      onClick={() => jumpToSearchHit(hit)}
                      title={`第 ${hit.page} 页`}
                    >
                      <span className="pdf-search-page">p.{hit.page}</span>
                      <span
                        className="pdf-search-snippet"
                        dangerouslySetInnerHTML={{
                          __html: highlightSearchHtml(hit.snippet, searchQuery),
                        }}
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div
              className="col-resizer pdf-outline-resizer"
              title="拖动调整面板宽度"
              onMouseDown={(e) => beginOutlineResize(e, "grow-right")}
            />
          </aside>
        )}

        <div className="pdf-viewer-host">
          <div
            className={`pdf-scroll pdf-viewer-container${handMode ? " hand-mode" : ""}`}
            ref={scrollRef}
            onMouseDown={onScrollPanStart}
            onScroll={onPdfScroll}
          >
            <div className="pdfViewer" ref={viewerDivRef} />
          </div>
          {!file && !restoring && (
            <div className="pdf-empty pdf-viewer-overlay">
              {error ? (
                <p className="boot-error">{error}</p>
              ) : (
                <>
                  <p>
                    打开带文字层的英文 PDF，在左侧 PDF
                    区域内拖选文本即可翻译（长度不限）。
                  </p>
                  <p className="hint">
                    会记住本地路径与阅读进度（页码、缩放、滚动）。文件被移动后需重新选择；进度仍会保留。扫描件无文字层时无法框选。
                  </p>
                </>
              )}
              <button
                type="button"
                className="send-btn"
                onClick={() => void openFilePicker()}
              >
                {error ? "重新选择文件" : "选择文件"}
              </button>
            </div>
          )}
          {restoring && (
            <div className="pdf-empty pdf-viewer-overlay">
              正在恢复上次阅读位置…
            </div>
          )}
          {file && error && (
            <div className="pdf-empty boot-error pdf-viewer-overlay">
              {error}
            </div>
          )}
          {file && docLoading && (
            <div className="pdf-empty pdf-viewer-loading pdf-viewer-overlay">
              正在加载 PDF…
            </div>
          )}
        </div>
      </div>

      {imgMenu && (
        <>
          <div className="pdf-ctx-backdrop" aria-hidden />
          <div
            ref={imgCtxMenuRef}
            className="pdf-ctx-menu"
            style={{ left: imgMenu.x, top: imgMenu.y }}
            role="menu"
          >
            {imgMenu.imageHit ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const hit = imgMenu.imageHit!;
                    setImgMenu(null);
                    openImgPreview(hit);
                  }}
                >
                  查看图片
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const hit = imgMenu.imageHit!;
                    void copyImageBlob(hit.blob)
                      .then(() => showImgToast("复制成功"))
                      .catch(() => showImgToast("复制失败", false))
                      .finally(closeImgMenu);
                  }}
                >
                  复制图片
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const hit = imgMenu.imageHit!;
                    void saveImageBlob(
                      hit.blob,
                      `pdf-p${hit.pageNumber}-image.png`,
                    ).finally(closeImgMenu);
                  }}
                >
                  图片另存为
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const hit = imgMenu.imageHit!;
                    const file = new File(
                      [hit.blob],
                      `pdf-p${hit.pageNumber}-image.png`,
                      { type: hit.blob.type || "image/png" },
                    );
                    closeImgMenu();
                    onOpenImageOcr?.(file);
                  }}
                >
                  图片识别
                </button>
              </>
            ) : (
              <>
                {imgMenu.selectedText ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const text = imgMenu.selectedText!;
                      closeImgMenu();
                      void copySelectedPdfText(text);
                    }}
                  >
                    复制选中文本
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const page = imgMenu.pageNumber;
                    closeImgMenu();
                    void copyCurrentPageText(page);
                  }}
                >
                  复制当前页文本
                </button>
                <div className="pdf-ctx-sep" />
                {(
                  [
                    ["actual", "实际大小"],
                    ["fitHeight", "适应高度"],
                    ["fitWidth", "适应宽度"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    className={fitMode === id ? "is-checked" : undefined}
                    onClick={() => {
                      applyFitMode(id);
                      closeImgMenu();
                    }}
                  >
                    <span className="pdf-ctx-check">
                      {fitMode === id ? "✓" : ""}
                    </span>
                    {label}
                  </button>
                ))}
                <div className="pdf-ctx-sep" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    rotatePage(imgMenu.pageNumber, 90);
                    closeImgMenu();
                  }}
                >
                  <span className="pdf-ctx-check" />
                  顺时针旋转
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    rotatePage(imgMenu.pageNumber, -90);
                    closeImgMenu();
                  }}
                >
                  <span className="pdf-ctx-check" />
                  逆时针旋转
                </button>
              </>
            )}
          </div>
        </>
      )}

      {imgBusy && <div className="pdf-img-busy" aria-hidden />}

      {imgPreview && (
        <div
          ref={imgViewerRef}
          className="pdf-image-viewer"
          role="dialog"
          aria-modal="true"
          aria-label="查看图片"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeImgPreview();
          }}
        >
          <div className="pdf-image-viewer-panel">
            <div className="pdf-image-viewer-bar" ref={imgBarRef}>
              <div className="pdf-image-viewer-title">
                第 {imgPreview.hit.pageNumber} 页图片 ·{" "}
                {Math.round(imgPreview.zoom * 100)}%
              </div>
              <div className="pdf-image-viewer-actions">
                <button
                  type="button"
                  className="pdf-tool-btn"
                  onClick={() => nudgeImgPreviewZoom(-IMG_PREVIEW_ZOOM_BTN)}
                >
                  缩小
                </button>
                <button
                  type="button"
                  className="pdf-tool-btn"
                  onClick={() =>
                    setImgPreview((p) =>
                      p ? { ...p, zoom: 1 } : p,
                    )
                  }
                >
                  1:1
                </button>
                <button
                  type="button"
                  className="pdf-tool-btn"
                  onClick={() => nudgeImgPreviewZoom(IMG_PREVIEW_ZOOM_BTN)}
                >
                  放大
                </button>
                <button
                  type="button"
                  className="pdf-tool-btn"
                  onClick={() => {
                    void copyImageBlob(imgPreview.hit.blob)
                      .then(() => showImgToast("复制成功"))
                      .catch(() => showImgToast("复制失败", false));
                  }}
                >
                  复制
                </button>
                <button
                  type="button"
                  className="pdf-tool-btn"
                  onClick={() =>
                    void saveImageBlob(
                      imgPreview.hit.blob,
                      `pdf-p${imgPreview.hit.pageNumber}-image.png`,
                    )
                  }
                >
                  另存为
                </button>
                <button
                  type="button"
                  className="pdf-tool-btn"
                  onClick={closeImgPreview}
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="pdf-image-viewer-stage" ref={imgStageRef}>
              <img
                src={imgPreview.hit.objectUrl}
                alt={`PDF 第 ${imgPreview.hit.pageNumber} 页图片`}
                style={{
                  width:
                    imgPreview.naturalW > 0
                      ? `${imgPreview.naturalW * imgPreview.zoom}px`
                      : undefined,
                  height:
                    imgPreview.naturalH > 0
                      ? `${imgPreview.naturalH * imgPreview.zoom}px`
                      : undefined,
                  maxWidth: "none",
                  maxHeight: "none",
                }}
                draggable={false}
                onLoad={(e) => applyImgPreviewNaturalSize(e.currentTarget)}
                ref={(el) => {
                  if (el?.complete && el.naturalWidth > 0) {
                    applyImgPreviewNaturalSize(el);
                  }
                }}
              />
            </div>
          </div>
        </div>
      )}

      {imgToast && (
        <div
          className={
            "settings-toast pdf-img-toast" +
            (imgToast.ok ? " is-ok" : " is-fail")
          }
          role="status"
        >
          {imgToast.message}
        </div>
      )}
    </div>
  );
}
