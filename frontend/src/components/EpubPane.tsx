import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ePub from "@likecoin/epub-ts";
import type { Book, Rendition } from "@likecoin/epub-ts";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import {
  detectDocKind,
  loadLocalDoc,
  pickAndLoadDocument,
  type LocalDocFile,
} from "../localDocFile";
import {
  loadEpubSession,
  loadRecentEpub,
  saveEpubSession,
  saveEpubSessionMeta,
  touchRecentEpubAsCurrent,
  type EpubSessionMeta,
} from "../epubSession";
import {
  listRecentDocuments,
  recentKindLabel,
  type LitRecentItem,
} from "../litRecent";
import { getEngineInfo } from "../translateEngines";
import {
  DocOutlineTree,
  findActiveOutlineKeyByHref,
  navItemsToOutline,
  type DocOutlineNode,
} from "./DocOutlineTree";

type FileMeta = {
  filePath: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
};

/** Wait until the viewer host has a real layout box (epub.js blanks at 0×0). */
async function waitForViewerHost(
  getEl: () => HTMLDivElement | null,
  opts?: { timeoutMs?: number; isCancelled?: () => boolean },
): Promise<HTMLDivElement> {
  const timeoutMs = opts?.timeoutMs ?? 10000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (opts?.isCancelled?.()) throw new Error("cancelled");
    const el = getEl();
    if (el && el.clientWidth > 16 && el.clientHeight > 16) return el;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
  const el = getEl();
  if (el) return el;
  throw new Error("阅读器尚未就绪");
}

type Props = {
  onTextSelected: (text: string) => void;
  visible?: boolean;
  translateProvider?: string;
  model?: string;
  toolbarExtra?: ReactNode;
  /** Open a document handed off from LiteratureView / PdfPane. */
  seedDoc?: LocalDocFile | null;
  onSeedConsumed?: () => void;
  /** When user picks a PDF while this pane is active. */
  onOpenOtherKind?: (kind: "pdf", doc: LocalDocFile) => void;
  /** Fired when a different document is opened (not on first load). */
  onDocumentChange?: () => void;
};

export function EpubPane({
  onTextSelected,
  visible = true,
  translateProvider = "llm",
  model = "",
  toolbarExtra,
  seedDoc = null,
  onSeedConsumed,
  onOpenOtherKind,
  onDocumentChange,
}: Props) {
  const [fileMeta, setFileMeta] = useState<FileMeta | null>(null);
  const openedDocPathRef = useRef<string | null>(null);
  const [hasBook, setHasBook] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outline, setOutline] = useState<DocOutlineNode[]>([]);
  const [locationHref, setLocationHref] = useState("");
  const [recentList, setRecentList] = useState<LitRecentItem[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);
  const [cfi, setCfi] = useState("");

  const viewerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const openMenuRef = useRef<HTMLDivElement>(null);
  const cfiRef = useRef("");
  const fileMetaRef = useRef<FileMeta | null>(null);
  const outlineOpenRef = useRef(false);
  const suppressPersistRef = useRef(false);
  const metaSaveTimer = useRef<number | null>(null);
  const pendingCfiRef = useRef<string | null>(null);
  const lastEmittedTextRef = useRef("");
  const recentCloseTimer = useRef<number | null>(null);

  const { width: outlineWidth, beginResize: beginOutlineResize } =
    usePersistedWidth("llmchat-epub-outline-width", 220, 140, 480);

  fileMetaRef.current = fileMeta;
  outlineOpenRef.current = outlineOpen;
  cfiRef.current = cfi;

  const engineBadge = useMemo(() => {
    if (translateProvider === "llm") {
      return model ? `模型：${model}` : "模型：大模型";
    }
    const info = getEngineInfo(translateProvider);
    return info ? `引擎：${info.label}` : `引擎：${translateProvider}`;
  }, [model, translateProvider]);

  const refreshRecent = useCallback(async () => {
    setRecentList(await listRecentDocuments());
  }, []);

  const persistMeta = useCallback((opts?: { immediate?: boolean }) => {
    const meta = fileMetaRef.current;
    if (!meta || suppressPersistRef.current) return;
    const payload: EpubSessionMeta = {
      ...meta,
      cfi: cfiRef.current || "",
      outlineOpen: outlineOpenRef.current,
    };
    if (metaSaveTimer.current) window.clearTimeout(metaSaveTimer.current);
    if (opts?.immediate) {
      metaSaveTimer.current = null;
      void saveEpubSessionMeta(payload);
      return;
    }
    metaSaveTimer.current = window.setTimeout(() => {
      void saveEpubSessionMeta(payload);
    }, 350);
  }, []);

  useEffect(() => {
    persistMeta();
  }, [persistMeta, cfi, outlineOpen, fileMeta]);

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

  const destroyBook = useCallback(() => {
    try {
      renditionRef.current?.destroy();
    } catch {
      /* ignore */
    }
    renditionRef.current = null;
    try {
      bookRef.current?.destroy();
    } catch {
      /* ignore */
    }
    bookRef.current = null;
    setHasBook(false);
    setOutline([]);
    setLocationHref("");
  }, []);

  const resolveDisplayTarget = useCallback((href: string): string => {
    const book = bookRef.current;
    const raw = (href || "").trim();
    if (!raw || !book) return raw;
    try {
      const section = book.spine.get(raw);
      if (section?.href) {
        const hash = raw.includes("#") ? raw.slice(raw.indexOf("#")) : "";
        if (hash && !section.href.includes("#")) {
          return `${section.href}${hash}`;
        }
        return section.href;
      }
    } catch {
      /* fall through */
    }
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }, []);

  const refreshRendition = useCallback((preferCfi?: string) => {
    const host = viewerRef.current;
    const rendition = renditionRef.current;
    if (!host || !rendition) return;
    if (host.clientWidth < 16 || host.clientHeight < 16) return;
    const target = (preferCfi || cfiRef.current || "").trim() || undefined;
    try {
      rendition.resize();
    } catch {
      /* ignore */
    }
    void rendition
      .display(target)
      .catch(() => rendition.display())
      .catch(() => {
        /* ignore */
      });
  }, []);

  const mountBook = useCallback(
    async (
      doc: LocalDocFile,
      opts?: { restoreCfi?: string; outlineOpen?: boolean },
    ) => {
      destroyBook();
      setLoading(true);
      setError(null);

      const host = await waitForViewerHost(() => viewerRef.current);
      // Drop leftover iframe/container from a previous blank render.
      host.replaceChildren();

      const book = ePub(doc.bytes.slice(0));
      bookRef.current = book;

      try {
        await book.opened;
      } catch (e) {
        destroyBook();
        throw e instanceof Error
          ? e
          : new Error("无法打开该 EPUB（可能已损坏或受 DRM 保护）");
      }

      const nav = book.navigation;
      const baseOutline = Array.isArray(nav?.toc)
        ? navItemsToOutline(nav.toc)
        : [];
      setOutline(baseOutline);

      const w = Math.max(host.clientWidth, 320);
      const h = Math.max(host.clientHeight, 240);
      const rendition = book.renderTo(host, {
        width: w,
        height: h,
        flow: "scrolled-doc",
        manager: "continuous",
        allowScriptedContent: true,
      });
      renditionRef.current = rendition;

      try {
        rendition.themes.default({
          body: {
            color: "#1a1a1a",
            background: "#ffffff",
            "line-height": "1.65",
          },
          a: { color: "#0b57d0" },
        });
      } catch {
        /* themes optional */
      }

      rendition.on("relocated", (location) => {
        const next = location?.start?.cfi || "";
        const href = location?.start?.href || "";
        if (href) setLocationHref(href);
        if (!next) return;
        setCfi(next);
        cfiRef.current = next;
        if (!suppressPersistRef.current) persistMeta();
      });

      rendition.on("selected", (_cfiRange, contents) => {
        try {
          const text =
            contents?.window?.getSelection()?.toString()?.trim() || "";
          if (!text || text === lastEmittedTextRef.current) return;
          lastEmittedTextRef.current = text;
          onTextSelected(text);
          window.setTimeout(() => {
            if (lastEmittedTextRef.current === text) {
              lastEmittedTextRef.current = "";
            }
          }, 800);
        } catch {
          /* ignore */
        }
      });

      const target = opts?.restoreCfi?.trim() || undefined;
      pendingCfiRef.current = target || null;
      try {
        await rendition.display(target);
      } catch {
        await rendition.display();
      }
      pendingCfiRef.current = null;

      // epub.js can clear views if resize races the first display — paint again.
      refreshRendition(target);

      suppressPersistRef.current = true;
      setFileMeta({
        filePath: doc.filePath,
        fileName: doc.fileName,
        fileSize: doc.fileSize,
        lastModified: doc.lastModified,
      });
      if (typeof opts?.outlineOpen === "boolean") {
        setOutlineOpen(opts.outlineOpen);
      }
      setHasBook(true);
      setLoading(false);
      // Allow persist after short settle
      window.setTimeout(() => {
        suppressPersistRef.current = false;
        refreshRendition(target);
      }, 400);
    },
    [destroyBook, onTextSelected, persistMeta, refreshRendition],
  );

  const applyOpenedDoc = useCallback(
    async (doc: LocalDocFile, opts?: { restoreFromSession?: boolean }) => {
      if (
        openedDocPathRef.current !== null &&
        openedDocPathRef.current !== doc.filePath
      ) {
        onDocumentChange?.();
      }
      openedDocPathRef.current = doc.filePath;

      const session = await loadEpubSession();
      const sameAsSaved =
        !!session &&
        session.filePath === doc.filePath &&
        (opts?.restoreFromSession ||
          (session.fileSize === doc.fileSize &&
            session.lastModified === doc.lastModified));

      if (sameAsSaved && session) {
        await mountBook(doc, {
          restoreCfi: session.cfi,
          outlineOpen: !!session.outlineOpen,
        });
        await saveEpubSession({
          filePath: doc.filePath,
          fileName: doc.fileName,
          fileSize: doc.fileSize,
          lastModified: doc.lastModified,
          cfi: session.cfi || "",
          outlineOpen: !!session.outlineOpen,
        });
        void refreshRecent();
        return;
      }

      await mountBook(doc, { restoreCfi: "", outlineOpen });
      await saveEpubSession({
        filePath: doc.filePath,
        fileName: doc.fileName,
        fileSize: doc.fileSize,
        lastModified: doc.lastModified,
        cfi: "",
        outlineOpen,
      });
      void refreshRecent();
    },
    [mountBook, onDocumentChange, outlineOpen, refreshRecent],
  );

  const openFilePicker = useCallback(async () => {
    try {
      const doc = await pickAndLoadDocument(["pdf", "epub"]);
      if (!doc) return;
      const kind = detectDocKind(doc.filePath);
      if (kind === "pdf") {
        onOpenOtherKind?.("pdf", doc);
        return;
      }
      await applyOpenedDoc(doc);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "打开 EPUB 失败。请确认文件仍在原路径。",
      );
    }
  }, [applyOpenedDoc, onOpenOtherKind]);

  const openRecent = useCallback(
    async (item: LitRecentItem) => {
      if (item.kind === "pdf") {
        try {
          const doc = await loadLocalDoc(item.filePath);
          onOpenOtherKind?.("pdf", doc);
          setRecentOpen(false);
        } catch {
          setError(
            "找不到该 PDF（文件可能已移动或变更）。请重新选择文件；阅读进度仍会保留。",
          );
          setRecentOpen(false);
        }
        return;
      }
      const entry = await loadRecentEpub(item.filePath);
      if (!entry?.filePath) return;
      try {
        const doc = await loadLocalDoc(entry.filePath);
        await applyOpenedDoc(doc, { restoreFromSession: true });
        await touchRecentEpubAsCurrent(
          {
            ...entry,
            filePath: doc.filePath,
            fileName: doc.fileName,
            fileSize: doc.fileSize,
            lastModified: doc.lastModified,
          },
          { cfi: entry.cfi || "" },
          { outlineOpen },
        );
        void refreshRecent();
      } catch {
        setError(
          "找不到该 EPUB（文件可能已移动或变更）。请重新选择文件；阅读进度仍会保留。",
        );
        setRecentOpen(false);
      }
    },
    [applyOpenedDoc, onOpenOtherKind, outlineOpen, refreshRecent],
  );

  // Session restore — only when pane is actually shown with a layout box.
  // Mounting into display:none / 0×0 makes epub.js render a permanent blank page.
  const sessionRestoreStartedRef = useRef(false);
  useEffect(() => {
    if (!visible || sessionRestoreStartedRef.current) return;
    // PDF→EPUB handoff uses seedDoc; skip session restore to avoid racing.
    if (seedDoc) {
      sessionRestoreStartedRef.current = true;
      setRestoring(false);
      return;
    }
    sessionRestoreStartedRef.current = true;
    let cancelled = false;
    (async () => {
      const session = await loadEpubSession();
      if (cancelled) return;
      if (!session?.filePath) {
        setRestoring(false);
        void refreshRecent();
        return;
      }
      try {
        const doc = await loadLocalDoc(session.filePath);
        if (cancelled) return;
        await waitForViewerHost(() => viewerRef.current, {
          isCancelled: () => cancelled,
        });
        if (cancelled) return;
        await mountBook(doc, {
          restoreCfi: session.cfi,
          outlineOpen: !!session.outlineOpen,
        });
      } catch (e) {
        if (!cancelled) {
          if (e instanceof Error && e.message === "cancelled") return;
          setError(
            "找不到上次打开的 EPUB（文件可能已移动或变更）。请重新选择文件；阅读进度仍会保留。",
          );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once when first visible
  }, [visible, seedDoc]);

  // Seed from LiteratureView / PdfPane handoff
  useEffect(() => {
    if (!seedDoc || !visible) return;
    let cancelled = false;
    (async () => {
      try {
        await waitForViewerHost(() => viewerRef.current, {
          isCancelled: () => cancelled,
        });
        if (cancelled) return;
        await applyOpenedDoc(seedDoc);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "打开 EPUB 失败",
          );
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      destroyBook();
      if (metaSaveTimer.current) window.clearTimeout(metaSaveTimer.current);
    };
  }, [destroyBook]);

  // Resize observer — skip 0×0; re-display after resize (epub.js may clear views).
  useEffect(() => {
    const host = viewerRef.current;
    if (!host || !hasBook) return;
    let timer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!visible) return;
        refreshRendition();
      }, 80);
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      if (timer) window.clearTimeout(timer);
    };
  }, [hasBook, visible, refreshRendition]);

  useEffect(() => {
    if (!visible || !hasBook) return;
    const t = window.setTimeout(() => refreshRendition(), 50);
    return () => window.clearTimeout(t);
  }, [visible, hasBook, refreshRendition]);

  const openRecentMenu = useCallback(() => {
    if (recentCloseTimer.current) {
      window.clearTimeout(recentCloseTimer.current);
      recentCloseTimer.current = null;
    }
    setRecentOpen(true);
    void refreshRecent();
  }, [refreshRecent]);

  const scheduleCloseRecentMenu = useCallback(() => {
    if (recentCloseTimer.current) window.clearTimeout(recentCloseTimer.current);
    recentCloseTimer.current = window.setTimeout(() => {
      setRecentOpen(false);
    }, 180);
  }, []);

  const outlineActiveKey = useMemo(
    () => findActiveOutlineKeyByHref(outline, locationHref),
    [outline, locationHref],
  );

  const onOutlineActivate = useCallback(
    (node: DocOutlineNode) => {
      const href = (node.href || "").trim();
      if (!href) return;
      const target = resolveDisplayTarget(href);
      void renditionRef.current?.display(target).catch(() => {
        void renditionRef.current?.display(href);
      });
    },
    [resolveDisplayTarget],
  );

  return (
    <div className="epub-pane" style={{ display: visible ? undefined : "none" }}>
      <div className="epub-toolbar pdf-toolbar">
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
            title="打开 EPUB / PDF"
          >
            打开
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
                    title={item.filePath}
                    onClick={() => void openRecent(item)}
                  >
                    <span className="pdf-recent-kind">
                      {recentKindLabel(item.kind)}
                    </span>
                    <span className="pdf-recent-name">{item.fileName}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        {fileMeta && (
          <span className="pdf-file-name" title={fileMeta.filePath}>
            <span className="pdf-recent-kind">{recentKindLabel("epub")}</span>
            <span className="pdf-file-name-text">{fileMeta.fileName}</span>
          </span>
        )}
        <button
          type="button"
          className={`pdf-tool-btn${outlineOpen ? " active" : ""}`}
          disabled={!hasBook}
          onClick={() => setOutlineOpen((v) => !v)}
          title="目录"
        >
          目录
        </button>
        <span className="pdf-toolbar-engine" title={engineBadge}>
          {engineBadge}
        </span>
        {toolbarExtra}
      </div>

      <div className="epub-main pdf-main">
        {outlineOpen && (
          <aside
            className="pdf-outline"
            style={{ width: outlineWidth }}
          >
            <div className="pdf-outline-body">
              <DocOutlineTree
                items={outline}
                onActivate={onOutlineActivate}
                activeKey={outlineActiveKey}
                emptyHint="当前 EPUB 无目录大纲"
              />
            </div>
            <div
              className="col-resizer pdf-outline-resizer"
              title="拖动调整目录宽度"
              onMouseDown={(e) => beginOutlineResize(e, "grow-right")}
            />
          </aside>
        )}

        <div className="epub-viewer-host">
          <div className="epub-viewer" ref={viewerRef} />
          {!hasBook && !restoring && (
            <div className="pdf-empty pdf-viewer-overlay">
              {error ? (
                <p className="boot-error">{error}</p>
              ) : (
                <>
                  <p>
                    打开 EPUB，在正文中拖选文本即可翻译或查词（与 PDF
                    共用右侧面板）。
                  </p>
                  <p className="hint">
                    只记住本地路径与阅读位置（CFI）。文件被移动后需重新选择；进度仍会保留。
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
          {hasBook && error && (
            <div className="pdf-empty boot-error pdf-viewer-overlay">
              {error}
            </div>
          )}
          {hasBook && loading && (
            <div className="pdf-empty pdf-viewer-loading pdf-viewer-overlay">
              正在加载 EPUB…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
