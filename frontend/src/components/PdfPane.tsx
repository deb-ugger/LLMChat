import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
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
  fileToArrayBuffer,
  listRecentPdfs,
  loadPdfSession,
  loadRecentPdf,
  savePdfSession,
  savePdfSessionMeta,
  touchRecentAsCurrent,
  type PdfRecentSummary,
  type PdfSessionMeta,
  type ViewMode,
} from "../pdfSession";
import { getEngineInfo } from "../translateEngines";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import { highlightSearchHtml } from "../highlightText";
import {
  copyImageBlob,
  downloadImageBlob,
  findImageAtPoint,
  type PdfImageHit,
} from "../pdfImages";

const PDF_DOCUMENT_OPTIONS = {
  cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${import.meta.env.BASE_URL}standard_fonts/`,
} as const;

export type { ViewMode };

type OutlineItem = {
  title: string;
  pageNumber: number | null;
  dest: unknown;
  items: OutlineItem[];
};

type Props = {
  onTextSelected: (text: string) => void;
  visible?: boolean;
  translateProvider?: string;
  model?: string;
};

type FileMeta = {
  fileName: string;
  fileSize: number;
  lastModified: number;
};

const VIEW_OPTIONS: { id: ViewMode; label: string }[] = [
  { id: "single", label: "单页视图" },
  { id: "single-scroll", label: "单页滚动" },
  { id: "double", label: "双页视图" },
  { id: "double-scroll", label: "双页滚动" },
];

const MIN_SCALE = 0.4;
const MAX_SCALE = 5;
/** UI 100% maps to this pdf.js scale (former ~140%). */
const SCALE_UI_BASE = 1.4;
const DEFAULT_SCALE = SCALE_UI_BASE;
const SCALE_STEP = SCALE_UI_BASE * 0.15;

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
): Promise<OutlineItem[]> {
  if (!items) return [];
  const result: OutlineItem[] = [];
  for (const item of items) {
    const pageNumber = await resolveDestPage(pdf, item.dest);
    result.push({
      title: item.title || "（无标题）",
      pageNumber,
      dest: item.dest,
      items: await buildOutline(pdf, item.items),
    });
  }
  return result;
}

function OutlineTree({
  items,
  onGo,
  resolvePage,
}: {
  items: OutlineItem[];
  onGo: (page: number) => void;
  resolvePage: (
    dest: unknown,
    fallback: number | null,
  ) => Promise<number | null>;
}) {
  return (
    <ul className="pdf-outline-list">
      {items.map((it, i) => (
        <li key={`${it.title}-${i}`}>
          <button
            type="button"
            className="pdf-outline-item"
            onClick={() => {
              void (async () => {
                const page = await resolvePage(it.dest, it.pageNumber);
                if (page != null) onGo(page);
              })();
            }}
            title={
              it.pageNumber != null ? `第 ${it.pageNumber} 页` : "点击跳转"
            }
          >
            {it.title}
          </button>
          {it.items.length > 0 && (
            <OutlineTree
              items={it.items}
              onGo={onGo}
              resolvePage={resolvePage}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

export function PdfPane({
  onTextSelected,
  visible = true,
  translateProvider = "google",
  model = "",
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [fileMeta, setFileMeta] = useState<FileMeta | null>(null);
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
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [handMode, setHandMode] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [docLoading, setDocLoading] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [recentList, setRecentList] = useState<PdfRecentSummary[]>([]);
  const [scaleInput, setScaleInput] = useState(
    String(scaleToPercent(DEFAULT_SCALE)),
  );
  const [pageInput, setPageInput] = useState("1");
  const [imgMenu, setImgMenu] = useState<{
    x: number;
    y: number;
    pageNumber: number;
    imageHit: PdfImageHit | null;
  } | null>(null);
  const [imgBusy, setImgBusy] = useState(false);
  const [fitMode, setFitMode] = useState<
    "actual" | "fitHeight" | "fitWidth" | "custom"
  >("actual");
  const pageExtraRotationRef = useRef<Map<number, number>>(new Map());
  const { width: outlineWidth, beginResize: beginOutlineResize } =
    usePersistedWidth("llmchat-pdf-outline-width", 220, 140, 480);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewerDivRef = useRef<HTMLDivElement>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const openMenuRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const pageWidthRef = useRef(0);
  const pendingScrollRef = useRef<{ top: number; left: number } | null>(null);
  const restoredPageRef = useRef<number | null>(null);
  const wasVisibleRef = useRef(visible);
  const suppressPersistRef = useRef(false);
  const metaSaveTimer = useRef<number | null>(null);
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

  const resolveOutlinePage = useCallback(
    async (dest: unknown, fallback: number | null) => {
      if (fallback != null) return fallback;
      const pdf = pdfRef.current;
      if (!pdf) return null;
      return resolveDestPage(pdf, dest);
    },
    [],
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

  const goToPage = useCallback(
    (page: number, _opts?: { smooth?: boolean }) => {
      const next = clampPage(page);
      setPageNumber(next);
      if (!pageInputFocusedRef.current) {
        setPageInput(String(next));
      }
      const viewer = pdfViewerRef.current;
      if (viewer) {
        viewer.currentPageNumber = next;
      }
      restoredPageRef.current = next;
    },
    [clampPage],
  );

  const commitPageInput = useCallback(() => {
    pageInputFocusedRef.current = false;
    const raw = pageInput.trim();
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) {
      setPageInput(String(pageNumber));
      return;
    }
    const next = clampPage(Math.round(n));
    setPageInput(String(next));
    if (next !== pageNumber) {
      goToPage(next);
    }
  }, [clampPage, goToPage, pageInput, pageNumber]);

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
    const pct = Number(scaleInput);
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
      setPageInput(String(pageNumber));
    }
  }, [pageNumber]);

  const refreshRecent = useCallback(async () => {
    setRecentList(await listRecentPdfs());
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

  const persistMeta = useCallback(() => {
    if (!fileMeta) return;
    if (suppressPersistRef.current) return;
    const root = scrollRef.current;
    const meta: PdfSessionMeta = {
      ...fileMeta,
      viewMode,
      pageNumber,
      scale,
      scrollTop: root?.scrollTop ?? 0,
      scrollLeft: root?.scrollLeft ?? 0,
      outlineOpen,
    };
    if (metaSaveTimer.current) window.clearTimeout(metaSaveTimer.current);
    metaSaveTimer.current = window.setTimeout(() => {
      void savePdfSessionMeta(meta);
    }, 350);
  }, [fileMeta, outlineOpen, pageNumber, scale, viewMode]);

  const onPdfScroll = useCallback(() => {
    persistMeta();
  }, [persistMeta]);

  useEffect(() => {
    persistMeta();
  }, [persistMeta]);

  // Init official PDFViewer after the real viewer DOM is mounted.
  // Must not run while `restoring` early-return used to omit the container
  // (that left viewerReady stuck false and the literature pane blank).
  useEffect(() => {
    if (restoring || !visible) return;

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
      const p = evt.pageNumber;
      setPageNumber(p);
      restoredPageRef.current = p;
      if (!pageInputFocusedRef.current) {
        setPageInput(String(p));
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
      const keep = Math.min(
        Math.max(1, restoredPageRef.current ?? 1),
        pdfViewer.pagesCount || 1,
      );
      pdfViewer.currentPageNumber = keep;
      setPageNumber(keep);
      window.setTimeout(() => reapplyPageRotationsRef.current(), 0);
      const pending = pendingScrollRef.current;
      if (pending) {
        window.setTimeout(() => {
          container.scrollTop = pending.top;
          container.scrollLeft = pending.left;
          pendingScrollRef.current = null;
          suppressPersistRef.current = false;
        }, 80);
      } else {
        suppressPersistRef.current = false;
      }
    };

    eventBus.on("pagechanging", onPageChanging);
    eventBus.on("scalechanging", onScaleChanging);
    eventBus.on("pagesinit", onPagesInit);

    return () => {
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
  }, [restoring, visible, applyScrollSpread]);

  // Load document into viewer when file / viewer are ready
  useEffect(() => {
    if (restoring || !visible || !file || !viewerReady) return;
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
        try {
          const raw = await pdf.getOutline();
          setOutline(await buildOutline(pdf, raw));
        } catch {
          setOutline([]);
        }
        linkServiceRef.current?.setDocument(pdf, null);
        findControllerRef.current?.setDocument(pdf);
        pdfViewer.setDocument(pdf);
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
      void prev?.destroy();
    };
  }, [restoring, visible, file, viewerReady]);

  // Session restore on first mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await loadPdfSession();
      if (cancelled) return;
      if (!session) {
        setRestoring(false);
        return;
      }
      suppressPersistRef.current = true;
      const blob = new Blob([session.fileData], { type: "application/pdf" });
      const restored = new File([blob], session.fileName, {
        type: "application/pdf",
        lastModified: session.lastModified || Date.now(),
      });
      setFile(restored);
      setFileMeta({
        fileName: session.fileName,
        fileSize: session.fileSize,
        lastModified: session.lastModified,
      });
      setViewMode(
        isViewMode(session.viewMode) ? session.viewMode : "single-scroll",
      );
      const keepPage = Math.max(1, session.pageNumber || 1);
      restoredPageRef.current = keepPage;
      setPageNumber(keepPage);
      const savedScale = session.scale || DEFAULT_SCALE;
      setScale(
        Math.min(
          MAX_SCALE,
          Math.max(
            MIN_SCALE,
            savedScale < SCALE_UI_BASE * 0.85 ? DEFAULT_SCALE : savedScale,
          ),
        ),
      );
      setOutlineOpen(!!session.outlineOpen);
      pendingScrollRef.current = {
        top: session.scrollTop || 0,
        left: session.scrollLeft || 0,
      };
      setRestoring(false);
      void refreshRecent();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshRecent]);

  // Re-lock when literature pane becomes visible
  useEffect(() => {
    const becameVisible = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!becameVisible || !file || !numPages) return;
    const keep = restoredPageRef.current ?? pageNumber;
    const viewer = pdfViewerRef.current;
    if (viewer) {
      viewer.currentPageNumber = keep;
      viewer.update();
    }
    setPageNumber(keep);
    const pending = pendingScrollRef.current;
    const root = scrollRef.current;
    if (root && pending) {
      root.scrollTop = pending.top;
      root.scrollLeft = pending.left;
    }
  }, [visible, file, numPages, pageNumber]);

  const openFile = useCallback(
    async (f: File) => {
      const session = await loadPdfSession();
      const sameAsSaved =
        !!session &&
        session.fileName === f.name &&
        session.fileSize === f.size &&
        session.lastModified === f.lastModified;

      setFile(f);
      setFileMeta({
        fileName: f.name,
        fileSize: f.size,
        lastModified: f.lastModified,
      });
      setOutline([]);
      setError(null);
      setRecentOpen(false);

      if (sameAsSaved && session) {
        const keep = Math.max(1, session.pageNumber || 1);
        suppressPersistRef.current = true;
        restoredPageRef.current = keep;
        setPageNumber(keep);
        pendingScrollRef.current = {
          top: session.scrollTop || 0,
          left: session.scrollLeft || 0,
        };
        void refreshRecent();
        return;
      }

      restoredPageRef.current = 1;
      setPageNumber(1);
      pendingScrollRef.current = { top: 0, left: 0 };
      try {
        const data = await fileToArrayBuffer(f);
        await savePdfSession({
          fileName: f.name,
          fileSize: f.size,
          lastModified: f.lastModified,
          fileData: data,
          viewMode,
          pageNumber: 1,
          scale,
          scrollTop: 0,
          scrollLeft: 0,
          outlineOpen,
        });
        void refreshRecent();
      } catch {
        // ignore
      }
    },
    [outlineOpen, refreshRecent, scale, viewMode],
  );

  const openRecent = useCallback(
    async (id: string) => {
      const entry = await loadRecentPdf(id);
      if (!entry) return;
      const blob = new Blob([entry.fileData], { type: "application/pdf" });
      const f = new File([blob], entry.fileName, {
        type: "application/pdf",
        lastModified: entry.lastModified || Date.now(),
      });
      setFile(f);
      setFileMeta({
        fileName: entry.fileName,
        fileSize: entry.fileSize,
        lastModified: entry.lastModified,
      });
      setOutline([]);
      setSearchHits([]);
      setError(null);
      setRecentOpen(false);
      const keep = Math.max(1, entry.pageNumber || 1);
      suppressPersistRef.current = true;
      restoredPageRef.current = keep;
      setPageNumber(keep);
      pendingScrollRef.current = {
        top: entry.scrollTop || 0,
        left: entry.scrollLeft || 0,
      };
      await touchRecentAsCurrent(
        entry,
        {
          pageNumber: Math.max(1, entry.pageNumber || 1),
          scrollTop: entry.scrollTop || 0,
          scrollLeft: entry.scrollLeft || 0,
        },
        { viewMode, scale, outlineOpen },
      );
      void refreshRecent();
    },
    [outlineOpen, refreshRecent, scale, viewMode],
  );

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

  const readPdfSelection = useCallback((): string | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const anchor = sel.anchorNode;
    const focus = sel.focusNode;
    const root = scrollRef.current;
    if (!root || !anchor || !focus) return null;
    if (!root.contains(anchor) || !root.contains(focus)) return null;
    const text = sel
      .toString()
      .replace(/\u00a0/g, " ")
      .replace(/-\s*[\r\n]+/g, "")
      .replace(/[\r\n]+/g, " ")
      .replace(/[ \t\f\v]+/g, " ")
      .trim();
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

  // Right-click on PDF page: zoom/fit (whole doc) + rotate (this page); image actions if hit
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !file) return;

    const onContextMenu = (e: MouseEvent) => {
      const pdf = pdfRef.current;
      if (!pdf || handMode) return;
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
      setImgBusy(true);
      void (async () => {
        let imageHit: PdfImageHit | null = null;
        try {
          const page = await pdf.getPage(pageNum);
          imageHit = await findImageAtPoint(
            page,
            pageNum,
            pageEl,
            clientX,
            clientY,
          );
        } catch {
          imageHit = null;
        } finally {
          setImgBusy(false);
        }
        setImgMenu((prev) => {
          if (prev?.imageHit?.objectUrl) {
            URL.revokeObjectURL(prev.imageHit.objectUrl);
          }
          return {
            x: clientX,
            y: clientY,
            pageNumber: pageNum,
            imageHit,
          };
        });
      })();
    };

    root.addEventListener("contextmenu", onContextMenu, true);
    return () => root.removeEventListener("contextmenu", onContextMenu, true);
  }, [file, handMode, viewerReady]);

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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeImgMenu = useCallback(() => {
    if (imgMenu?.imageHit?.objectUrl) {
      URL.revokeObjectURL(imgMenu.imageHit.objectUrl);
    }
    setImgMenu(null);
  }, [imgMenu]);

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
    <div className="pdf-pane">
      <div className="pdf-toolbar">
        <div
          className="pdf-open-menu"
          ref={openMenuRef}
          onMouseEnter={openRecentMenu}
          onMouseLeave={scheduleCloseRecentMenu}
        >
          <button
            type="button"
            className="pdf-tool-btn"
            onClick={() => fileInputRef.current?.click()}
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
                  <button
                    key={item.id}
                    type="button"
                    className="pdf-recent-item"
                    title={`${item.fileName} · 第 ${item.pageNumber} 页`}
                    onClick={() => void openRecent(item.id)}
                  >
                    <span className="pdf-recent-name">{item.fileName}</span>
                    <span className="pdf-recent-meta">p.{item.pageNumber}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            void openFile(f);
            e.target.value = "";
          }}
        />
        {fileMeta && (
          <span className="pdf-file-name" title={fileMeta.fileName}>
            {fileMeta.fileName}
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

        <button
          type="button"
          className={`pdf-tool-btn${searchOpen ? " active" : ""}`}
          disabled={!file}
          onClick={() => {
            setSearchOpen((v) => !v);
            if (!searchOpen) setOutlineOpen(false);
          }}
          title="搜索"
        >
          搜索
        </button>

        <div className="pdf-view-menu" ref={viewMenuRef}>
          <button
            type="button"
            className="pdf-tool-btn"
            disabled={!file}
            onClick={(e) => {
              const r = (
                e.currentTarget as HTMLButtonElement
              ).getBoundingClientRect();
              setViewMenuPos({ top: r.bottom + 4, left: r.left });
              setViewMenuOpen((v) => !v);
            }}
            title="页面显示模式"
          >
            视图 ▾
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
                  <span className="pdf-view-check">
                    {viewMode === opt.id ? "✓" : ""}
                  </span>
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className={`pdf-tool-btn${handMode ? " active" : ""}`}
          disabled={!file}
          onClick={() => setHandMode((v) => !v)}
          title="拖动手势（也可按住 Alt 拖动）"
        >
          拖动
        </button>

        <button
          type="button"
          className="pdf-tool-btn pdf-tool-icon-btn"
          disabled={!file || pageNumber <= 1}
          onClick={() => goToPage(pageNumber - pageStep)}
          title="上一页"
          aria-label="上一页"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
            <path
              fill="currentColor"
              d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"
            />
          </svg>
        </button>
        <span className="pdf-page-label">
          <input
            className="pdf-page-input"
            type="number"
            min={1}
            max={numPages || 1}
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
                setPageInput(String(pageNumber));
                pageInputFocusedRef.current = false;
                e.currentTarget.blur();
              }
            }}
            inputMode="numeric"
            title="输入页码后按回车或点击别处跳转"
          />
          / {numPages || "—"}
        </span>
        <button
          type="button"
          className="pdf-tool-btn pdf-tool-icon-btn"
          disabled={!file || !numPages || pageNumber >= numPages}
          onClick={() => goToPage(pageNumber + pageStep)}
          title="下一页"
          aria-label="下一页"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
            <path
              fill="currentColor"
              d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"
            />
          </svg>
        </button>
        <button
          type="button"
          className="pdf-tool-btn"
          onClick={() => changeScale((s) => s - SCALE_STEP)}
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
            title="自定义缩放百分比（100% 约为原 140%）"
          />
          %
        </span>
        <button
          type="button"
          className="pdf-tool-btn"
          onClick={() => changeScale((s) => s + SCALE_STEP)}
        >
          +
        </button>
        <span className="pdf-toolbar-engine" title={engineBadge}>
          {engineBadge}
        </span>
      </div>

      <div className="pdf-main">
        {outlineOpen && (
          <aside className="pdf-outline" style={{ width: outlineWidth }}>
            <div className="pdf-outline-title">目录</div>
            {outline.length === 0 ? (
              <p className="hint">当前 PDF 无目录大纲</p>
            ) : (
              <OutlineTree
                items={outline}
                onGo={goToPage}
                resolvePage={resolveOutlinePage}
              />
            )}
            <div
              className="col-resizer"
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
            <div
              className="col-resizer"
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
              <p>
                打开带文字层的英文 PDF，在左侧 PDF
                区域内拖选文本即可翻译（长度不限）。
              </p>
              <p className="hint">
                会记住上次打开的文件、视图、页码、缩放与滚动位置。扫描件无文字层时无法框选。
              </p>
              <button
                type="button"
                className="send-btn"
                onClick={() => fileInputRef.current?.click()}
              >
                选择文件
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
          <div className="pdf-ctx-backdrop" onClick={closeImgMenu} />
          <div
            className="pdf-ctx-menu"
            style={{ left: imgMenu.x, top: imgMenu.y }}
            role="menu"
          >
            {imgMenu.imageHit && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const hit = imgMenu.imageHit!;
                    void copyImageBlob(hit.blob).finally(closeImgMenu);
                  }}
                >
                  复制图片
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const hit = imgMenu.imageHit!;
                    downloadImageBlob(
                      hit.blob,
                      `pdf-p${hit.pageNumber}-image.png`,
                    );
                    closeImgMenu();
                  }}
                >
                  图片另存为
                </button>
                <div className="pdf-ctx-sep" />
              </>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                changeScale((s) => s + SCALE_STEP);
                closeImgMenu();
              }}
            >
              放大
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                changeScale((s) => s - SCALE_STEP);
                closeImgMenu();
              }}
            >
              缩小
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
              逆时针旋转
            </button>
          </div>
        </>
      )}

      {imgBusy && <div className="pdf-img-busy" aria-hidden />}
    </div>
  );
}
