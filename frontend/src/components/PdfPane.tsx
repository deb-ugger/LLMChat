import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Document, Page, pdfjs } from "react-pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
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

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

/** Keep outside the component — react-pdf remounts Document if options identity changes. */
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

const SCROLL_PAGE_BUFFER = 3;

function highlightSearchText(str: string, query: string): string {
  // Yellow wash only — text stays transparent so canvas glyphs aren't doubled
  return highlightSearchHtml(str, query).split('class="search-hit-mark"').join(
    'class="search-hit-mark pdf-search-mark"',
  );
}

const MIN_SCALE = 0.4;
const MAX_SCALE = 5;
/**
 * UI 100% maps to this react-pdf scale (former ~140%).
 * Display percent = round(scale / SCALE_UI_BASE * 100).
 */
const SCALE_UI_BASE = 1.4;
const DEFAULT_SCALE = SCALE_UI_BASE;
const SCALE_STEP = SCALE_UI_BASE * 0.1;

function scaleToPercent(scale: number): number {
  return Math.round((scale / SCALE_UI_BASE) * 100);
}

function percentToScale(pct: number): number {
  return +((pct / 100) * SCALE_UI_BASE).toFixed(2);
}

/**
 * Match Mozilla PDF.js viewer OutputScale (vscode-pdfviewer / 官方 Viewer)：
 * canvas 物理像素跟随屏幕 devicePixelRatio，上限 3，不再强行 3～5× 超采样。
 */
function pdfDevicePixelRatio(): number {
  if (typeof window === "undefined") return 1;
  const dpr = window.devicePixelRatio || 1;
  return Math.min(3, Math.max(1, +dpr.toFixed(2)));
}

function isViewMode(v: unknown): v is ViewMode {
  return (
    v === "single" ||
    v === "single-scroll" ||
    v === "double" ||
    v === "double-scroll"
  );
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
  resolvePage: (dest: unknown, fallback: number | null) => Promise<number | null>;
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
            <OutlineTree items={it.items} onGo={onGo} resolvePage={resolvePage} />
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
  const [highlightQuery, setHighlightQuery] = useState("");
  const [highlightPage, setHighlightPage] = useState<number | null>(null);
  const [viewMenuPos, setViewMenuPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [handMode, setHandMode] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [recentOpen, setRecentOpen] = useState(false);
  const [recentList, setRecentList] = useState<PdfRecentSummary[]>([]);
  const [scaleInput, setScaleInput] = useState(
    String(scaleToPercent(DEFAULT_SCALE)),
  );
  const [pageInput, setPageInput] = useState("1");
  const { width: outlineWidth, beginResize: beginOutlineResize } =
    usePersistedWidth("llmchat-pdf-outline-width", 220, 140, 480);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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
  const programmaticScrollRef = useRef(false);
  const pendingGoPageRef = useRef<number | null>(null);
  const pageInputFocusedRef = useRef(false);
  const goPageUnlockTimer = useRef<number | null>(null);
  const pendingViewPageRef = useRef<number | null>(null);
  const pendingScalePageRef = useRef<number | null>(null);
  const prevScaleRef = useRef(scale);
  const pageSyncTimer = useRef<number | null>(null);
  const pageHeightRef = useRef(0);
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

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

  const scrollToPageEl = useCallback((page: number, smooth = false) => {
    let tries = 0;
    const run = () => {
      // Wait for a live page — placeholders are white and must not be scrolled to.
      const el = scrollRef.current?.querySelector(
        `[data-page="${page}"]:not(.is-placeholder)`,
      ) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({
          behavior: smooth ? "smooth" : "auto",
          block: "start",
        });
        return;
      }
      if (tries++ < 90) requestAnimationFrame(run);
    };
    requestAnimationFrame(run);
  }, []);

  const jumpScrollToPage = useCallback(
    (page: number, smooth = false) => {
      const root = scrollRef.current;
      const ph = pageHeightRef.current;
      if (
        root &&
        ph > 40 &&
        (viewMode === "single-scroll" || viewMode === "double-scroll")
      ) {
        const gap = 12;
        const top =
          viewMode === "single-scroll"
            ? Math.max(0, (page - 1) * (ph + gap))
            : Math.max(0, Math.floor((page - 1) / 2) * (ph + gap));
        if (smooth) {
          root.scrollTo({ top, behavior: "smooth" });
        } else {
          root.scrollTop = top;
        }
      }
      scrollToPageEl(page, smooth);
    },
    [scrollToPageEl, viewMode],
  );

  const goToPage = useCallback(
    (page: number, opts?: { smooth?: boolean }) => {
      const next = clampPage(page);
      const smooth = opts?.smooth ?? false;

      if (viewMode === "single-scroll" || viewMode === "double-scroll") {
        // Set pending before state so the next render mounts around the target.
        pendingGoPageRef.current = next;
        programmaticScrollRef.current = true;
        if (goPageUnlockTimer.current != null) {
          window.clearTimeout(goPageUnlockTimer.current);
        }
        setPageNumber(next);
        if (!pageInputFocusedRef.current) {
          setPageInput(String(next));
        }

        // Defer scroll until after React mounts live pages (avoid white placeholders).
        requestAnimationFrame(() => {
          jumpScrollToPage(next, false);
          window.setTimeout(() => jumpScrollToPage(next, false), 50);
          window.setTimeout(() => jumpScrollToPage(next, smooth), smooth ? 100 : 200);
        });

        goPageUnlockTimer.current = window.setTimeout(() => {
          programmaticScrollRef.current = false;
          pendingGoPageRef.current = null;
          goPageUnlockTimer.current = null;
        }, smooth ? 1100 : 550);
      } else {
        pendingGoPageRef.current = null;
        setPageNumber(next);
        if (!pageInputFocusedRef.current) {
          setPageInput(String(next));
        }
        requestAnimationFrame(() => {
          const root = scrollRef.current;
          if (root) root.scrollTop = 0;
        });
      }
    },
    [clampPage, jumpScrollToPage, viewMode],
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
      goToPage(next, { smooth: false });
    }
  }, [clampPage, goToPage, pageInput, pageNumber]);

  const syncPageFromScroll = useCallback(() => {
    if (programmaticScrollRef.current) return;
    if (pendingGoPageRef.current != null) return;
    if (pageInputFocusedRef.current) return;
    if (viewMode !== "single-scroll" && viewMode !== "double-scroll") return;
    const root = scrollRef.current;
    if (!root) return;

    const pages = root.querySelectorAll<HTMLElement>("[data-page]");
    if (!pages.length) return;

    const rootRect = root.getBoundingClientRect();
    const anchorY = rootRect.top + Math.min(80, rootRect.height * 0.2);
    let bestPage = 1;
    let bestDist = Number.POSITIVE_INFINITY;

    pages.forEach((el) => {
      const page = Number(el.dataset.page);
      if (!Number.isFinite(page)) return;
      const rect = el.getBoundingClientRect();
      // Prefer the page whose top is closest to the viewport top band
      const dist = Math.abs(rect.top - anchorY);
      const visible =
        rect.bottom > rootRect.top + 8 && rect.top < rootRect.bottom - 8;
      if (!visible) return;
      if (dist < bestDist) {
        bestDist = dist;
        bestPage = page;
      }
    });

    setPageNumber((prev) => (prev === bestPage ? prev : bestPage));
    setPageInput((prev) =>
      pageInputFocusedRef.current || prev === String(bestPage)
        ? prev
        : String(bestPage),
    );
  }, [viewMode]);

  const fitScaleForDouble = useCallback(
    (preferred?: number) => {
      const root = scrollRef.current;
      const pageW = pageWidthRef.current;
      if (!root || !pageW) return preferred ?? scale;
      const gap = 12;
      const padding = 40;
      const available = root.clientWidth - padding;
      const fit = available / (pageW * 2 + gap);
      const next = Math.min(preferred ?? scale, fit);
      return Math.max(MIN_SCALE, Math.min(MAX_SCALE, +next.toFixed(2)));
    },
    [scale],
  );

  const applyViewMode = useCallback(
    (mode: ViewMode) => {
      const keepPage = pageNumber;
      programmaticScrollRef.current = true;
      pendingViewPageRef.current =
        mode === "single-scroll" || mode === "double-scroll" ? keepPage : null;
      if (mode === "double" || mode === "double-scroll") {
        setScale((s) => fitScaleForDouble(s));
      }
      setViewMode(mode);
      setPageNumber(keepPage);
      if (mode !== "single-scroll" && mode !== "double-scroll") {
        requestAnimationFrame(() => {
          const root = scrollRef.current;
          if (root) root.scrollTop = 0;
          programmaticScrollRef.current = false;
        });
      }
    },
    [fitScaleForDouble, pageNumber],
  );

  // Restore scroll position after entering a scroll view mode (avoid gray top / page 1)
  useEffect(() => {
    const page = pendingViewPageRef.current;
    if (page == null) return;
    if (viewMode !== "single-scroll" && viewMode !== "double-scroll") {
      pendingViewPageRef.current = null;
      return;
    }

    const jump = (smooth = false) => {
      const root = scrollRef.current;
      const ph = pageHeightRef.current;
      if (root && ph > 40) {
        const gap = 12;
        if (viewMode === "single-scroll") {
          root.scrollTop = Math.max(0, (page - 1) * (ph + gap));
        } else {
          const spreadIndex = Math.floor((page - 1) / 2);
          root.scrollTop = Math.max(0, spreadIndex * (ph + gap));
        }
      }
      scrollToPageEl(page, smooth);
    };

    programmaticScrollRef.current = true;
    setPageNumber(page);
    jump(false);
    const t1 = window.setTimeout(() => jump(false), 60);
    const t2 = window.setTimeout(() => jump(false), 220);
    const t3 = window.setTimeout(() => {
      jump(false);
      pendingViewPageRef.current = null;
      programmaticScrollRef.current = false;
    }, 900);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [viewMode, scrollToPageEl]);

  // Keep current page locked while zooming (avoid white placeholders + page jumps)
  useEffect(() => {
    const prev = prevScaleRef.current;
    if (prev > 0 && pageHeightRef.current > 40 && scale !== prev) {
      pageHeightRef.current = Math.max(
        120,
        pageHeightRef.current * (scale / prev),
      );
    }
    prevScaleRef.current = scale;

    const page = pendingScalePageRef.current;
    if (page == null) return;

    const jump = () => {
      setPageNumber(page);
      const root = scrollRef.current;
      const ph =
        pageHeightRef.current > 40
          ? pageHeightRef.current
          : Math.max(480, Math.round(1100 * scale));
      if (root) {
        const gap = 12;
        if (viewMode === "single-scroll") {
          root.scrollTop = Math.max(0, (page - 1) * (ph + gap));
        } else if (viewMode === "double-scroll") {
          const spreadIndex = Math.floor((page - 1) / 2);
          root.scrollTop = Math.max(0, spreadIndex * (ph + gap));
        } else {
          root.scrollTop = 0;
        }
      }
      scrollToPageEl(page, false);
    };

    programmaticScrollRef.current = true;
    jump();
    const t1 = window.setTimeout(jump, 50);
    const t2 = window.setTimeout(jump, 180);
    const t3 = window.setTimeout(() => {
      jump();
      pendingScalePageRef.current = null;
      programmaticScrollRef.current = false;
    }, 700);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [scale, scrollToPageEl, viewMode]);

  useEffect(() => {
    setScaleInput(String(scaleToPercent(scale)));
  }, [scale]);

  const changeScale = useCallback(
    (nextOrFn: number | ((s: number) => number)) => {
      const keepPage = pageNumber;
      programmaticScrollRef.current = true;
      pendingScalePageRef.current = keepPage;
      setPageNumber(keepPage);
      setScale((s) => {
        const raw = typeof nextOrFn === "function" ? nextOrFn(s) : nextOrFn;
        return Math.min(MAX_SCALE, Math.max(MIN_SCALE, +raw.toFixed(2)));
      });
    },
    [pageNumber],
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

  const devicePixelRatio = useMemo(() => pdfDevicePixelRatio(), []);

  const persistMeta = useCallback(() => {
    if (!fileMeta) return;
    if (programmaticScrollRef.current || suppressPersistRef.current) return;
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
    if (pageSyncTimer.current) window.clearTimeout(pageSyncTimer.current);
    pageSyncTimer.current = window.setTimeout(() => {
      syncPageFromScroll();
    }, 80);
  }, [persistMeta, syncPageFromScroll]);

  useEffect(() => {
    persistMeta();
  }, [persistMeta]);

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
      setViewMode(isViewMode(session.viewMode) ? session.viewMode : "single-scroll");
      const keepPage = Math.max(1, session.pageNumber || 1);
      restoredPageRef.current = keepPage;
      setPageNumber(keepPage);
      // Soften old low-zoom sessions that look washed-out on code fonts
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

  // Re-lock reading position when literature pane becomes visible
  useEffect(() => {
    const becameVisible = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!becameVisible || !file || !numPages) return;

    const keep = restoredPageRef.current ?? pageNumber;
    programmaticScrollRef.current = true;
    restoredPageRef.current = keep;
    setPageNumber(keep);

    const jump = () => {
      setPageNumber(keep);
      scrollToPageEl(keep, false);
      const root = scrollRef.current;
      const pending = pendingScrollRef.current;
      if (root && root.clientHeight >= 40 && pending) {
        root.scrollTop = pending.top;
        root.scrollLeft = pending.left;
      }
    };

    jump();
    const t1 = window.setTimeout(jump, 60);
    const t2 = window.setTimeout(jump, 220);
    const t3 = window.setTimeout(() => {
      jump();
      pendingScrollRef.current = null;
      programmaticScrollRef.current = false;
      suppressPersistRef.current = false;
    }, 800);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
    // Only re-run when pane becomes visible / document ready — not on every pageNumber tick
  }, [visible, file, numPages, scrollToPageEl]);

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
        // Restore reading position only; keep current view / scale
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
    setHighlightQuery("");
    setHighlightPage(null);
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
    } catch {
      setSearchHits([]);
    } finally {
      setSearchBusy(false);
    }
  }, [searchQuery]);

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
      // Only fire after selection action has fully stopped
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
        // Still dragging: never translate mid-selection
        if (debounceRef.current) {
          window.clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        return;
      }
      // Selection may settle/change shortly after pointer up (PDF text layer)
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

  useEffect(() => {
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      if (metaSaveTimer.current) window.clearTimeout(metaSaveTimer.current);
      if (pageSyncTimer.current) window.clearTimeout(pageSyncTimer.current);
      if (goPageUnlockTimer.current != null) {
        window.clearTimeout(goPageUnlockTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!pageInputFocusedRef.current) {
      setPageInput(String(pageNumber));
    }
  }, [pageNumber]);

  const pageStep = viewMode.startsWith("double") ? 2 : 1;

  const renderedPages = useMemo(() => {
    if (!numPages) return [] as number[][];
    if (viewMode === "single") {
      return [[pageNumber]];
    }
    if (viewMode === "double") {
      const left = pageNumber % 2 === 0 ? pageNumber - 1 : pageNumber;
      const right = left + 1;
      return [right <= numPages ? [left, right] : [left]];
    }
    if (viewMode === "single-scroll") {
      return Array.from({ length: numPages }, (_, i) => [i + 1]);
    }
    const pairs: number[][] = [];
    for (let p = 1; p <= numPages; p += 2) {
      pairs.push(p + 1 <= numPages ? [p, p + 1] : [p]);
    }
    return pairs;
  }, [numPages, pageNumber, viewMode]);

  const shouldMountPage = useCallback(
    (p: number) => {
      if (viewMode === "single" || viewMode === "double") return true;
      if (highlightPage === p) return true;
      const anchor =
        pendingGoPageRef.current ??
        pendingScalePageRef.current ??
        pageNumber;
      const buf =
        pendingGoPageRef.current != null || pendingScalePageRef.current != null
          ? SCROLL_PAGE_BUFFER + 2
          : SCROLL_PAGE_BUFFER;
      if (viewMode === "double-scroll") {
        // Always mount complete spreads to avoid 1-page → 2-page flash
        const left = p % 2 === 0 ? p - 1 : p;
        const right = left + 1;
        const pairBuf = buf + 1;
        return (
          Math.abs(left - anchor) <= pairBuf ||
          Math.abs(right - anchor) <= pairBuf ||
          (highlightPage != null &&
            (highlightPage === left || highlightPage === right))
        );
      }
      return Math.abs(p - anchor) <= buf;
    },
    [highlightPage, pageNumber, viewMode],
  );

  const placeholderHeight =
    pageHeightRef.current > 0
      ? pageHeightRef.current
      : Math.max(480, Math.round(1100 * scale));

  const pageSlotWidth =
    pageWidthRef.current > 0
      ? Math.round(pageWidthRef.current * scale)
      : undefined;

  const jumpToSearchHit = useCallback(
    (hit: { page: number; snippet: string; matchIndex: number }) => {
      const q = searchQuery.trim();
      setHighlightQuery(q);
      setHighlightPage(hit.page);
      goToPage(hit.page);
    },
    [goToPage, searchQuery],
  );

  useEffect(() => {
    if (!highlightQuery || highlightPage == null) return;
    const t = window.setTimeout(() => {
      const mark = scrollRef.current?.querySelector(
        ".pdf-search-mark",
      ) as HTMLElement | null;
      mark?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 400);
    return () => window.clearTimeout(t);
  }, [highlightPage, highlightQuery, pageNumber, viewMode, scale]);

  const restoreScrollSoon = useCallback(() => {
    const pending = pendingScrollRef.current;
    if (!pending) return;
    let tries = 0;
    const run = () => {
      const root = scrollRef.current;
      if (!root) {
        if (tries++ < 80) requestAnimationFrame(run);
        return;
      }
      // Not laid out yet (e.g. still becoming visible) — keep pending
      if (root.clientHeight < 40) {
        if (tries++ < 120) requestAnimationFrame(run);
        return;
      }
      const targetPage = restoredPageRef.current;
      if (targetPage != null && targetPage > 1) {
        scrollToPageEl(targetPage, false);
      }
      root.scrollTop = pending.top;
      root.scrollLeft = pending.left;
      if (
        root.scrollHeight <= root.clientHeight + 8 &&
        pending.top > 40 &&
        tries < 80
      ) {
        tries += 1;
        requestAnimationFrame(run);
        return;
      }
      pendingScrollRef.current = null;
    };
    requestAnimationFrame(run);
  }, [scrollToPageEl]);

  const onPageRenderSuccess = useCallback(
    (p: number) => {
      const el = scrollRef.current?.querySelector(
        `[data-page="${p}"]`,
      ) as HTMLElement | null;
      if (el && el.offsetHeight > 40) {
        pageHeightRef.current = el.offsetHeight;
      }
      if (pendingScrollRef.current) {
        restoreScrollSoon();
      }
      // After a jump target finishes painting, snap once more to the live page.
      if (pendingGoPageRef.current === p) {
        jumpScrollToPage(p, false);
      }
    },
    [jumpScrollToPage, restoreScrollSoon],
  );

  const onLoadSuccess = async (pdf: PDFDocumentProxy) => {
    pdfRef.current = pdf;
    setNumPages(pdf.numPages);
    setError(null);
    const keep = Math.min(
      Math.max(1, restoredPageRef.current ?? pageNumber),
      pdf.numPages,
    );
    restoredPageRef.current = keep;
    setPageNumber(keep);
    programmaticScrollRef.current = true;
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
    restoreScrollSoon();
    window.setTimeout(() => {
      scrollToPageEl(keep, false);
      if (visible) {
        programmaticScrollRef.current = false;
        suppressPersistRef.current = false;
      }
    }, 500);
  };

  const patchLinks = () => {
    const root = scrollRef.current;
    if (!root) return;
    root.querySelectorAll(".annotationLayer a").forEach((a) => {
      const el = a as HTMLAnchorElement;
      const href = el.getAttribute("href") || "";
      const isExternal =
        /^https?:\/\//i.test(href) ||
        /^mailto:/i.test(href) ||
        /^ftp:/i.test(href);

      if (isExternal) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
        if (!el.dataset.llmchatPatched) {
          el.dataset.llmchatPatched = "1";
          el.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            window.open(href, "_blank", "noopener,noreferrer");
          });
        }
      }
    });
  };

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

  if (restoring) {
    return (
      <div className="pdf-pane">
        <div className="pdf-empty">正在恢复上次阅读位置…</div>
      </div>
    );
  }

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
          onClick={() => goToPage(pageNumber - pageStep, { smooth: true })}
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
          onClick={() => goToPage(pageNumber + pageStep, { smooth: true })}
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
          <aside className="pdf-outline pdf-search-pane" style={{ width: outlineWidth }}>
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
                        __html: highlightSearchHtml(
                          hit.snippet,
                          searchQuery,
                        ),
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

        <div
          className={`pdf-scroll${handMode ? " hand-mode" : ""}`}
          ref={scrollRef}
          onMouseDown={onScrollPanStart}
          onScroll={onPdfScroll}
          onWheel={(e) => {
            // allow horizontal pan with shift+wheel
            if (!e.shiftKey) return;
            const root = scrollRef.current;
            if (!root) return;
            root.scrollLeft += e.deltaY;
            e.preventDefault();
          }}
        >
          {!file && (
            <div className="pdf-empty">
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
          {file && (
            <Document
              file={file}
              options={PDF_DOCUMENT_OPTIONS}
              loading={<div className="pdf-empty">正在加载 PDF…</div>}
              onLoadSuccess={(pdf) => void onLoadSuccess(pdf)}
              onLoadError={(err) => setError(err.message)}
              externalLinkTarget="_blank"
              externalLinkRel="noopener noreferrer"
              onItemClick={({ pageNumber: p }) => {
                if (typeof p === "number" && p >= 1) goToPage(p);
              }}
            >
              {error && <div className="pdf-empty boot-error">{error}</div>}
              <div
                className={`pdf-canvas-host mode-${viewMode}${
                  scale < SCALE_UI_BASE * 0.95 ? " is-zoomed-out" : ""
                }`}
              >
                {renderedPages.map((pair) => (
                  <div
                    key={pair.join("-")}
                    className={
                      pair.length > 1 ? "pdf-spread" : "pdf-spread single"
                    }
                  >
                    {pair.map((p) => {
                      const live = shouldMountPage(p);
                      return (
                        <div
                          key={p}
                          className={`pdf-page-wrap${live ? "" : " is-placeholder"}`}
                          data-page={p}
                          style={
                            live
                              ? undefined
                              : {
                                  width: pageSlotWidth,
                                  minWidth: pageSlotWidth,
                                  minHeight: placeholderHeight,
                                }
                          }
                        >
                          {live ? (
                            <Page
                              pageNumber={p}
                              scale={scale}
                              devicePixelRatio={devicePixelRatio}
                              canvasBackground="#ffffff"
                              renderTextLayer
                              renderAnnotationLayer={
                                viewMode === "single" ||
                                viewMode === "double" ||
                                Math.abs(p - pageNumber) <= 1
                              }
                              customTextRenderer={
                                highlightQuery && highlightPage === p
                                  ? ({ str }) =>
                                      highlightSearchText(str, highlightQuery)
                                  : undefined
                              }
                              onRenderAnnotationLayerSuccess={patchLinks}
                              onRenderSuccess={() => onPageRenderSuccess(p)}
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </Document>
          )}
        </div>
      </div>
    </div>
  );
}
