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
import { highlightSearchHtml, highlightSearchNodes } from "../highlightText";
import {
  copyImageBlob,
  saveImageBlob,
  findImageAtPoint,
  syncPageImageHotspots,
  clearPageImageHotspots,
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
  onOpenImageOcr?: (file: File) => void;
  /** Extra controls rendered at the end of the PDF toolbar. */
  toolbarExtra?: ReactNode;
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

function collectOutlineBranchKeys(
  items: OutlineItem[],
  prefix = "",
): string[] {
  const keys: string[] = [];
  items.forEach((it, i) => {
    const key = prefix ? `${prefix}.${i}` : `${i}`;
    if (it.items.length > 0) {
      keys.push(key);
      keys.push(...collectOutlineBranchKeys(it.items, key));
    }
  });
  return keys;
}

function defaultCollapsedKeys(items: OutlineItem[]): Set<string> {
  const initial = new Set<string>();
  for (const key of collectOutlineBranchKeys(items)) {
    if (key.includes(".")) initial.add(key);
  }
  return initial;
}

function outlineAncestorKeys(key: string): string[] {
  const parts = key.split(".");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    out.push(parts.slice(0, i).join("."));
  }
  return out;
}

/** 按 key 找到目录节点；找不到返回 null */
function findOutlineNode(
  items: OutlineItem[],
  key: string,
): OutlineItem | null {
  const parts = key.split(".").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let list = items;
  let node: OutlineItem | null = null;
  for (const idx of parts) {
    node = list[idx] ?? null;
    if (!node) return null;
    list = node.items;
  }
  return node;
}

/**
 * 定位展开：祖先路径 + 当前节点，再沿「每个层级的第一个子标题」递归向下。
 * 同级其余子标题保持折叠。
 */
function outlineRevealExpandKeys(
  items: OutlineItem[],
  activeKey: string,
): string[] {
  const keys = [...outlineAncestorKeys(activeKey)];
  let node = findOutlineNode(items, activeKey);
  let key = activeKey;
  while (node && node.items.length > 0) {
    keys.push(key);
    key = `${key}.0`;
    node = node.items[0] ?? null;
  }
  return keys;
}

/**
 * 当前页对应的最细目录项：文档序中最后一个 page <= currentPage 的条目
 *（同页时子级在父级之后，故自然取最细分）
 */
function findActiveOutlineKey(
  items: OutlineItem[],
  currentPage: number,
): string | null {
  if (!Number.isFinite(currentPage) || currentPage < 1) return null;
  let best: string | null = null;
  const walk = (list: OutlineItem[], prefix: string) => {
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const key = prefix ? `${prefix}.${i}` : `${i}`;
      if (it.pageNumber != null && it.pageNumber <= currentPage) {
        best = key;
      }
      if (it.items.length > 0) walk(it.items, key);
    }
  };
  walk(items, "");
  return best;
}

/** 收集标题匹配节点及其祖先，便于过滤显示 */
function collectOutlineTitleMatches(
  items: OutlineItem[],
  query: string,
  prefix = "",
  matches = new Set<string>(),
  visible = new Set<string>(),
): { matches: Set<string>; visible: Set<string> } {
  const q = query.trim().toLowerCase();
  if (!q) return { matches, visible };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const key = prefix ? `${prefix}.${i}` : `${i}`;
    const selfHit = it.title.toLowerCase().includes(q);
    collectOutlineTitleMatches(it.items, query, key, matches, visible);
    let hasVisibleChild = false;
    for (let j = 0; j < it.items.length; j++) {
      if (visible.has(`${key}.${j}`)) {
        hasVisibleChild = true;
        break;
      }
    }
    if (selfHit) matches.add(key);
    if (selfHit || hasVisibleChild) visible.add(key);
  }
  return { matches, visible };
}

function OutlineBranch({
  items,
  onGo,
  resolvePage,
  depth,
  path,
  collapsed,
  onToggle,
  titleQuery,
  visibleKeys,
  activeKey,
}: {
  items: OutlineItem[];
  onGo: (page: number) => void;
  resolvePage: (
    dest: unknown,
    fallback: number | null,
  ) => Promise<number | null>;
  depth: number;
  path: string;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  titleQuery: string;
  visibleKeys: Set<string> | null;
  activeKey: string | null;
}) {
  const level = Math.min(Math.max(depth, 0), 4);
  const q = titleQuery.trim();
  return (
    <ul className={`pdf-outline-list is-depth-${level}`}>
      {items.map((it, i) => {
        const key = path ? `${path}.${i}` : `${i}`;
        if (visibleKeys && !visibleKeys.has(key)) return null;
        const hasKids =
          it.items.length > 0 &&
          (!visibleKeys ||
            it.items.some((_, j) => visibleKeys.has(`${key}.${j}`)));
        const isCollapsed = hasKids && collapsed.has(key);
        const isActive = activeKey === key;
        return (
          <li key={key} className={isCollapsed ? "is-collapsed" : undefined}>
            <div
              className={`pdf-outline-row is-l${level}${isActive ? " is-active" : ""}`}
              data-outline-key={key}
            >
              {hasKids ? (
                <button
                  type="button"
                  className={`pdf-outline-twist${isCollapsed ? " is-collapsed" : ""}`}
                  aria-expanded={!isCollapsed}
                  aria-label={isCollapsed ? "展开" : "折叠"}
                  title={isCollapsed ? "展开" : "折叠"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(key);
                  }}
                >
                  <span className="pdf-outline-twist-icon" aria-hidden />
                </button>
              ) : (
                <span className="pdf-outline-twist is-leaf" aria-hidden />
              )}
              <button
                type="button"
                className={`pdf-outline-item is-l${level}${isActive ? " is-active" : ""}`}
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
                {q ? highlightSearchNodes(it.title, q) : it.title}
              </button>
            </div>
            {hasKids && !isCollapsed && (
              <OutlineBranch
                items={it.items}
                onGo={onGo}
                resolvePage={resolvePage}
                depth={depth + 1}
                path={key}
                collapsed={collapsed}
                onToggle={onToggle}
                titleQuery={titleQuery}
                visibleKeys={visibleKeys}
                activeKey={activeKey}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function OutlineTree({
  items,
  onGo,
  resolvePage,
  currentPage,
}: {
  items: OutlineItem[];
  onGo: (page: number) => void;
  resolvePage: (
    dest: unknown,
    fallback: number | null,
  ) => Promise<number | null>;
  currentPage: number;
}) {
  const treeRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [titleQuery, setTitleQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const branchKeys = useMemo(
    () => collectOutlineBranchKeys(items),
    [items],
  );
  const { matches, visible } = useMemo(
    () => collectOutlineTitleMatches(items, titleQuery),
    [items, titleQuery],
  );
  const filtering = titleQuery.trim().length > 0;
  const visibleKeys = filtering ? visible : null;

  const activeKey = useMemo(
    () => findActiveOutlineKey(items, currentPage),
    [items, currentPage],
  );

  /** 默认折叠二级及以下；搜索时展开全部以便看到匹配项 */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const next = defaultCollapsedKeys(items);
    const key = findActiveOutlineKey(items, currentPage);
    if (key) {
      for (const a of outlineAncestorKeys(key)) next.delete(a);
    }
    return next;
  });

  useEffect(() => {
    if (filtering) {
      setCollapsed(new Set());
      return;
    }
    const next = defaultCollapsedKeys(items);
    const key = findActiveOutlineKey(items, currentPage);
    if (key) {
      for (const a of outlineAncestorKeys(key)) next.delete(a);
    }
    setCollapsed(next);
    // 仅在目录数据/搜索状态变化时重置折叠；翻页不打断用户手动展开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filtering]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const onToggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setCollapsed(new Set());
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsed(new Set(branchKeys));
  }, [branchKeys]);

  const revealActive = useCallback(() => {
    if (!activeKey) return;
    const expandKeys = outlineRevealExpandKeys(items, activeKey);
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const k of expandKeys) next.delete(k);
      return next;
    });
    // 等展开渲染后再滚动
    window.setTimeout(() => {
      requestAnimationFrame(() => {
        const root = scrollRef.current ?? treeRef.current;
        const el = root?.querySelector(`[data-outline-key="${activeKey}"]`);
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }, 80);
  }, [activeKey, items]);

  const toggleSearch = useCallback(() => {
    setSearchOpen((open) => {
      if (open) setTitleQuery("");
      return !open;
    });
  }, []);

  /** 每次打开目录（组件挂载）自动定位到当前页章节 */
  useEffect(() => {
    revealActive();
    // OutlineTree 仅在目录打开时挂载，故只在打开时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="pdf-outline-tree" ref={treeRef}>
      <div className="pdf-outline-toolbar">
        <div className="pdf-outline-actions">
          <button
            type="button"
            className="pdf-outline-icon-btn"
            onClick={revealActive}
            disabled={!activeKey}
            data-tip="定位到当前章节"
            aria-label="定位到当前章节"
          >
            <svg viewBox="0 0 24 24" aria-hidden>
              <path
                d="M5 4.5h14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
              <rect
                x="4.5"
                y="8"
                width="15"
                height="8"
                rx="1.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
              />
              <path
                d="M5 19.5h14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className={`pdf-outline-icon-btn${searchOpen ? " is-active" : ""}`}
            onClick={toggleSearch}
            data-tip="搜索标题"
            aria-label="搜索标题"
            aria-pressed={searchOpen}
          >
            <svg viewBox="0 0 24 24" aria-hidden>
              <circle
                cx="10.5"
                cy="10.5"
                r="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
              />
              <path
                d="M16 16l5.2 5.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          {branchKeys.length > 0 && (
            <button
              type="button"
              className="pdf-outline-icon-btn"
              onClick={() => {
                if (collapsed.size === 0) collapseAll();
                else expandAll();
              }}
              data-tip={collapsed.size === 0 ? "全部折叠" : "全部展开"}
              aria-label={collapsed.size === 0 ? "全部折叠" : "全部展开"}
            >
              {collapsed.size === 0 ? (
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path
                    d="M5 3.5l7 6.5 7-6.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M5 20.5l7-6.5 7 6.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path
                    d="M5 10L12 3.5 19 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M5 14L12 20.5 19 14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          )}
        </div>
        {searchOpen && (
          <div className="pdf-outline-filter">
            <input
              ref={searchInputRef}
              type="search"
              value={titleQuery}
              placeholder="搜索标题…"
              onChange={(e) => setTitleQuery(e.target.value)}
              aria-label="搜索目录标题"
            />
            {filtering && (
              <span className="pdf-outline-filter-count">
                {matches.size > 0 ? `${matches.size} 条` : "无匹配"}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="pdf-outline-scroll" ref={scrollRef}>
        {filtering && matches.size === 0 ? (
          <p className="hint pdf-outline-filter-empty">未找到匹配的标题</p>
        ) : (
          <OutlineBranch
            items={items}
            onGo={onGo}
            resolvePage={resolvePage}
            depth={0}
            path=""
            collapsed={collapsed}
            onToggle={onToggle}
            titleQuery={titleQuery}
            visibleKeys={visibleKeys}
            activeKey={activeKey}
          />
        )}
      </div>
    </div>
  );
}

export function PdfPane({
  onTextSelected,
  visible = true,
  translateProvider = "google",
  model = "",
  onOpenImageOcr,
  toolbarExtra,
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
  const [imgPreview, setImgPreview] = useState<{
    hit: PdfImageHit;
    zoom: number;
    naturalW: number;
    naturalH: number;
  } | null>(null);
  const [imgBusy, setImgBusy] = useState(false);
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewerDivRef = useRef<HTMLDivElement>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const openMenuRef = useRef<HTMLDivElement>(null);
  const imgCtxMenuRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const pageWidthRef = useRef(0);
  const pendingScrollRef = useRef<{ top: number; left: number } | null>(null);
  /** Last user/session page; may update on scroll. */
  const restoredPageRef = useRef<number | null>(null);
  /** Page to apply on pagesinit; not overwritten by PDF.js interim page=1. */
  const restoreTargetPageRef = useRef<number | null>(null);
  const wasVisibleRef = useRef(visible);
  const suppressPersistRef = useRef(false);
  const metaSaveTimer = useRef<number | null>(null);
  const persistMetaRef = useRef<(opts?: { immediate?: boolean }) => void>(
    () => undefined,
  );
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

  const persistMeta = useCallback((opts?: { immediate?: boolean }) => {
    if (!fileMeta) return;
    if (suppressPersistRef.current) return;
    const root = scrollRef.current;
    const page =
      pdfViewerRef.current?.currentPageNumber ||
      restoredPageRef.current ||
      pageNumber;
    const meta: PdfSessionMeta = {
      ...fileMeta,
      viewMode,
      pageNumber: Math.max(1, page),
      scale,
      scrollTop: root?.scrollTop ?? 0,
      scrollLeft: root?.scrollLeft ?? 0,
      outlineOpen,
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

  const onPdfScroll = useCallback(() => {
    persistMeta();
  }, [persistMeta]);

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
      // During session restore, PDF.js often emits page=1 before we jump.
      // Do not clobber the target page or we land on page 1 permanently.
      if (!suppressPersistRef.current) {
        restoredPageRef.current = p;
      }
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
      const target =
        restoreTargetPageRef.current ?? restoredPageRef.current ?? 1;
      const keep = Math.min(Math.max(1, target), pdfViewer.pagesCount || 1);
      pdfViewer.currentPageNumber = keep;
      restoredPageRef.current = keep;
      restoreTargetPageRef.current = null;
      setPageNumber(keep);
      if (!pageInputFocusedRef.current) {
        setPageInput(String(keep));
      }
      window.setTimeout(() => reapplyPageRotationsRef.current(), 0);
      const pending = pendingScrollRef.current;
      const finishRestore = () => {
        suppressPersistRef.current = false;
        persistMetaRef.current({ immediate: true });
      };
      if (pending) {
        window.setTimeout(() => {
          container.scrollTop = pending.top;
          container.scrollLeft = pending.left;
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
      restoreTargetPageRef.current = keepPage;
      restoredPageRef.current = keepPage;
      setPageNumber(keepPage);
      const savedScale = session.scale || DEFAULT_SCALE;
      setScale(
        Math.min(MAX_SCALE, Math.max(MIN_SCALE, savedScale)),
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
        restoreTargetPageRef.current = keep;
        restoredPageRef.current = keep;
        setPageNumber(keep);
        pendingScrollRef.current = {
          top: session.scrollTop || 0,
          left: session.scrollLeft || 0,
        };
        void refreshRecent();
        return;
      }

      restoreTargetPageRef.current = 1;
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
      restoreTargetPageRef.current = keep;
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

    /** Skip PDF footer/header printed page numbers in the text layer. */
    const isPrintedPageNumber = (textNode: Node): boolean => {
      const el =
        textNode.nodeType === Node.ELEMENT_NODE
          ? (textNode as HTMLElement)
          : textNode.parentElement;
      if (!el) return false;
      const span = el.closest(".textLayer span") as HTMLElement | null;
      if (!span) return false;
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
      // Lone short number sitting in the margin/footer.
      return raw.length <= 3;
    };

    const chunks: string[] = [];
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
          if (isPrintedPageNumber(node)) {
            node = walker.nextNode();
            continue;
          }
          const full = node.textContent || "";
          let start = 0;
          let end = full.length;
          if (node === range.startContainer) start = range.startOffset;
          if (node === range.endContainer) end = range.endOffset;
          if (end > start) chunks.push(full.slice(start, end));
          node = walker.nextNode();
        }
      }
    } catch {
      chunks.length = 0;
    }

    const raw = chunks.length > 0 ? chunks.join("") : sel.toString();
    const text = raw
      .replace(/\u00a0/g, " ")
      .replace(/-\s*[\r\n]+/g, "")
      .replace(/[\r\n]+/g, " ")
      .replace(/[ \t\f\v]+/g, " ")
      // Cross-page leftovers: "…word 12 Next…" where 12 is a page number.
      .replace(/(\p{L})\s+\d{1,4}\s+(?=\p{L})/gu, "$1 ")
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
            title="自定义缩放百分比"
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
        {toolbarExtra}
      </div>

      <div className="pdf-main">
        {outlineOpen && (
          <aside className="pdf-outline" style={{ width: outlineWidth }}>
            <div className="pdf-outline-body">
              {outline.length === 0 ? (
                <p className="hint">当前 PDF 无目录大纲</p>
              ) : (
                <OutlineTree
                  items={outline}
                  onGo={goToPage}
                  resolvePage={resolveOutlinePage}
                  currentPage={pageNumber}
                />
              )}
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
