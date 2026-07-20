import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { api } from "../api";
import { toFriendlyError } from "../friendlyError";
import { highlightSearchNodes } from "../highlightText";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import { getEngineInfo } from "../translateEngines";

export type OcrBlock = {
  id: string;
  text: string;
  translation: string;
  status: "idle" | "pending" | "done" | "error";
  /** normalized 0–1 relative to image */
  x: number;
  y: number;
  w: number;
  h: number;
};

type Props = {
  ocrLang: string;
  autoTranslate: boolean;
  translateProvider: string;
  translateSource: string;
  translateTarget: string;
  translateMaxLength: number;
  translateAutoChunk: boolean;
  model?: string;
  /** External image to OCR (e.g. from PDF context menu). */
  incomingImage?: { file: File; id: number } | null;
  onIncomingHandled?: () => void;
};

type BBoxLine = {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
  /** height of the last physical line in this box (for merge threshold) */
  lineH: number;
};

function looksLikeCode(text: string): boolean {
  return /[{};()<>[\]=]|::|->|#include|\b(auto|void|int|return|if|else|for|while|class|struct)\b/.test(
    text,
  );
}

function isJunkText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (looksLikeCode(t)) return false;
  if (t.length === 1 && !/[A-Za-z0-9\u4e00-\u9fff]/.test(t)) return true;
  const letters = t.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, "");
  return letters.length === 0 && t.length < 4;
}

function coversPoint(box: BBoxLine, x: number, y: number): boolean {
  const pad = Math.max(2, box.lineH * 0.15);
  return (
    x >= box.x0 - pad &&
    x <= box.x1 + pad &&
    y >= box.y0 - pad &&
    y <= box.y1 + pad
  );
}

/** Keep lines that Tesseract put outside paragraph boxes (common for code). */
function mergeOrphanLines(paras: BBoxLine[], lines: BBoxLine[]): BBoxLine[] {
  if (!lines.length) return paras;
  const out = [...paras];
  for (const ln of lines) {
    const cx = (ln.x0 + ln.x1) / 2;
    const cy = (ln.y0 + ln.y1) / 2;
    if (!out.some((p) => coversPoint(p, cx, cy))) {
      out.push({ ...ln });
    }
  }
  return out.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

function clampRatio(n: number) {
  return Math.min(0.75, Math.max(0.25, n));
}

function cleanLineText(ln: BBoxLine): BBoxLine {
  let t = ln.text.trim().replace(/\s+/g, " ");
  t = t.replace(/[\s·•|/\-–—_]{2,}$/u, "").trim();
  const m = t.match(/^(.*[.!?。！？…])\s+(\S{1,4})$/u);
  if (m && isJunkText(m[2])) {
    t = m[1].trim();
  }
  return { ...ln, text: t };
}

function loadImageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({
        w: img.naturalWidth || img.width || 1,
        h: img.naturalHeight || img.height || 1,
      });
    img.onerror = () => reject(new Error("无法读取图片尺寸"));
    img.src = url;
  });
}

function mergeWordsToLines(words: BBoxLine[]): BBoxLine[] {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines: BBoxLine[] = [];
  for (const w of sorted) {
    const last = lines[lines.length - 1];
    const mid = (w.y0 + w.y1) / 2;
    const sameLine =
      last &&
      Math.abs(mid - (last.y0 + last.y1) / 2) <
        Math.max(10, last.lineH * 0.55);
    const xNear =
      last && w.x0 <= last.x1 + Math.max(40, last.lineH * 2.5);
    if (sameLine && xNear && last) {
      last.text = `${last.text} ${w.text}`.replace(/\s+/g, " ").trim();
      last.x0 = Math.min(last.x0, w.x0);
      last.y0 = Math.min(last.y0, w.y0);
      last.x1 = Math.max(last.x1, w.x1);
      last.y1 = Math.max(last.y1, w.y1);
      last.confidence = Math.min(last.confidence, w.confidence);
      last.lineH = Math.max(last.lineH, w.y1 - w.y0);
    } else {
      lines.push({ ...w, lineH: Math.max(8, w.y1 - w.y0) });
    }
  }
  return lines;
}

/**
 * Merge adjacent lines into paragraphs.
 * IMPORTANT: use last physical line height for gap threshold — never the
 * accumulated paragraph height (that cascade-merges the whole page).
 */
function mergeLinesToParagraphs(lines: BBoxLine[]): BBoxLine[] {
  if (!lines.length) return [];
  const sorted = [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const paras: BBoxLine[] = [];
  for (const ln of sorted) {
    const lineH = Math.max(8, ln.lineH || ln.y1 - ln.y0);
    const last = paras[paras.length - 1];
    if (!last) {
      paras.push({ ...ln, lineH });
      continue;
    }
    const gap = ln.y0 - last.y1;
    const refH = Math.max(8, last.lineH);
    const overlap =
      Math.min(last.x1, ln.x1) - Math.max(last.x0, ln.x0);
    const minW = Math.min(last.x1 - last.x0, ln.x1 - ln.x0) || 1;
    const leftAligned = Math.abs(ln.x0 - last.x0) < Math.max(20, refH * 1.1);
    const sameColumn = overlap > minW * 0.15 || leftAligned;
    // Same paragraph: gap smaller than ~1 line; larger gap = new paragraph
    const closeVertically = gap < refH * 0.85 && gap > -refH * 0.35;
    if (sameColumn && closeVertically) {
      last.text = `${last.text} ${ln.text}`.replace(/\s+/g, " ").trim();
      last.x0 = Math.min(last.x0, ln.x0);
      last.y0 = Math.min(last.y0, ln.y0);
      last.x1 = Math.max(last.x1, ln.x1);
      last.y1 = Math.max(last.y1, ln.y1);
      last.confidence = Math.min(last.confidence, ln.confidence);
      last.lineH = lineH;
    } else {
      paras.push({ ...ln, lineH });
    }
  }
  return paras.map(cleanLineText);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

async function copyText(text: string) {
  const t = text.trim();
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const el = document.createElement("textarea");
    el.value = t;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  }
}

export function ImageOcrView({
  ocrLang,
  autoTranslate,
  translateProvider,
  translateSource,
  translateTarget,
  translateMaxLength,
  translateAutoChunk,
  model = "",
  incomingImage = null,
  onIncomingHandled,
}: Props) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<OcrBlock[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTranslation, setShowTranslation] = useState(true);
  const [srcQuery, setSrcQuery] = useState("");
  const [dstQuery, setDstQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [srcRatio, setSrcRatio] = useState(() => {
    try {
      const n = Number(localStorage.getItem("llmchat-ocr-src-ratio"));
      return Number.isFinite(n) ? clampRatio(n) : 0.5;
    } catch {
      return 0.5;
    }
  });
  const { width: sideWidth, beginResize: beginSideResize } = usePersistedWidth(
    "llmchat-ocr-side-width",
    420,
    280,
    900,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerLangRef = useRef<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const dualRef = useRef<HTMLDivElement>(null);
  const srcListRef = useRef<HTMLDivElement>(null);
  const dstListRef = useRef<HTMLDivElement>(null);
  const translateGenRef = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem("llmchat-ocr-src-ratio", String(srcRatio));
    } catch {
      // ignore
    }
  }, [srcRatio]);

  const beginDualResize = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = dualRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      if (rect.width <= 0) return;
      setSrcRatio(clampRatio((ev.clientX - rect.left) / rect.width));
    };
    const onUp = () => {
      document.body.classList.remove("col-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      void workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [imageUrl]);

  const engineBadge = useMemo(() => {
    if (translateProvider === "llm") {
      return model ? `模型：${model}` : "模型：大模型";
    }
    const info = getEngineInfo(translateProvider);
    return info ? `引擎：${info.label}` : `引擎：${translateProvider}`;
  }, [model, translateProvider]);

  const ensureWorker = useCallback(async () => {
    if (workerRef.current && workerLangRef.current === ocrLang) {
      return workerRef.current;
    }
    if (workerRef.current) {
      await workerRef.current.terminate();
      workerRef.current = null;
    }
    const worker = await createWorker(ocrLang);
    // AUTO recovers short code lines that SINGLE_COLUMN often drops
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: "1",
    });
    workerRef.current = worker;
    workerLangRef.current = ocrLang;
    return worker;
  }, [ocrLang]);

  const selectBlock = useCallback((id: string) => {
    setSelectedId(id);
    const scrollBoth = () => {
      const srcItem = srcListRef.current?.querySelector(
        `[data-row-id="${id}"]`,
      ) as HTMLElement | null;
      const dstItem = dstListRef.current?.querySelector(
        `[data-row-id="${id}"]`,
      ) as HTMLElement | null;
      srcItem?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      dstItem?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      const box = stageRef.current?.querySelector(
        `[data-block-id="${id}"]`,
      ) as HTMLElement | null;
      box?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    requestAnimationFrame(() => requestAnimationFrame(scrollBoth));
  }, []);

  const translateOpts = useMemo(
    () => ({
      source: translateSource,
      target: translateTarget,
      provider: translateProvider,
      maxLength: translateMaxLength,
      autoChunk: translateAutoChunk,
    }),
    [
      translateAutoChunk,
      translateMaxLength,
      translateProvider,
      translateSource,
      translateTarget,
    ],
  );

  const summarizeTranslateStatus = (list: OcrBlock[]) => {
    const work = list.filter((b) => b.text.trim());
    const ok = work.filter((b) => b.status === "done").length;
    const fail = work.filter((b) => b.status === "error").length;
    if (fail === 0) return `识别 ${list.length} 段 · 翻译完成`;
    if (ok === 0) return `识别 ${list.length} 段 · 翻译全部失败（${fail}）`;
    return `识别 ${list.length} 段 · 成功 ${ok} · 失败 ${fail}`;
  };

  const translateBlocks = useCallback(
    async (
      list: OcrBlock[],
      onProgress?: (done: number, total: number) => void,
    ) => {
      const gen = ++translateGenRef.current;
      const workIdx = list
        .map((b, i) => (b.text.trim() ? i : -1))
        .filter((i) => i >= 0);
      if (!workIdx.length) return list;

      const pending: OcrBlock[] = list.map((b) =>
        b.text.trim()
          ? { ...b, status: "pending", translation: "" }
          : { ...b, status: "done" },
      );
      setBlocks(pending);

      // Batch join only for LLM (free engines choke on size / quota)
      const canBatch =
        translateProvider === "llm" &&
        workIdx.reduce((n, i) => n + list[i].text.length, 0) < 6000;

      if (canBatch) {
        const SEP = "\n¶¶\n";
        try {
          onProgress?.(0, workIdx.length);
          const joined = workIdx.map((i) => list[i].text.trim()).join(SEP);
          const tr = await api.translate(joined, undefined, translateOpts);
          if (gen !== translateGenRef.current) return list;
          const parts = tr.translation
            .split(/\n?\s*¶¶\s*\n?/)
            .map((s) => s.trim());
          if (
            parts.length === workIdx.length ||
            Math.abs(parts.length - workIdx.length) <= 1
          ) {
            onProgress?.(workIdx.length, workIdx.length);
            const next = list.map((b) => ({ ...b }));
            workIdx.forEach((idx, j) => {
              next[idx] = {
                ...next[idx],
                translation: parts[j] || "（无译文）",
                status: "done",
              };
            });
            return next;
          }
        } catch {
          // fall through to per-block
        }
      }

      const next: OcrBlock[] = list.map((b) =>
        b.text.trim()
          ? { ...b, status: "pending", translation: "" }
          : { ...b, status: "done" },
      );
      setBlocks([...next]);
      // Free engines: lower concurrency to avoid rate limits
      const concurrency = translateProvider === "llm" ? 5 : 2;
      let done = 0;
      for (let start = 0; start < workIdx.length; start += concurrency) {
        if (gen !== translateGenRef.current) return next;
        const slice = workIdx.slice(start, start + concurrency);
        await Promise.all(
          slice.map(async (idx) => {
            try {
              const tr = await api.translate(
                next[idx].text,
                undefined,
                translateOpts,
              );
              next[idx] = {
                ...next[idx],
                translation: tr.translation,
                status: "done",
              };
            } catch (e) {
              const msg = toFriendlyError(e);
              next[idx] = {
                ...next[idx],
                translation: `（翻译失败）${msg}`,
                status: "error",
              };
            } finally {
              done += 1;
              onProgress?.(done, workIdx.length);
              if (gen === translateGenRef.current) {
                setBlocks([...next]);
              }
            }
          }),
        );
      }
      return next;
    },
    [translateOpts, translateProvider],
  );

  const runOcr = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      setStatus("正在识别文字…");
      setBlocks([]);
      setSelectedId(null);
      setSrcQuery("");
      setDstQuery("");
      try {
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        const url = URL.createObjectURL(file);
        setImageUrl(url);

        const [{ w: iw, h: ih }, worker] = await Promise.all([
          loadImageSize(url),
          ensureWorker(),
        ]);

        const result = await worker.recognize(file);
        const data = result.data;

        const toBox = (raw: {
          text: string;
          confidence?: number;
          bbox: { x0: number; y0: number; x1: number; y1: number };
        }): BBoxLine | null => {
          const text = (raw.text || "").trim().replace(/\s+/g, " ");
          if (!text || isJunkText(text)) return null;
          const conf = raw.confidence ?? 0;
          // Code / short symbols often score low in Tesseract — keep them
          const minConf = looksLikeCode(text) ? 18 : 30;
          if (conf < minConf) return null;
          return {
            text,
            x0: raw.bbox.x0,
            y0: raw.bbox.y0,
            x1: raw.bbox.x1,
            y1: raw.bbox.y1,
            confidence: conf,
            lineH: Math.max(8, raw.bbox.y1 - raw.bbox.y0),
          };
        };

        const linesRaw = (data.lines ?? [])
          .map((l) => toBox(l))
          .filter((x): x is BBoxLine => !!x);

        let lineBoxes: BBoxLine[] = [];

        // Lines-first: better recall for code / short fragments than paragraphs alone
        if (linesRaw.length) {
          lineBoxes = mergeLinesToParagraphs(linesRaw);
          // Soft-split overlong blobs back toward line groups
          if (lineBoxes.length === 1 && linesRaw.length >= 4) {
            lineBoxes = mergeLinesToParagraphs(linesRaw);
          }
        } else {
          const parasRaw = (data.paragraphs ?? [])
            .map((p) => toBox(p))
            .filter((x): x is BBoxLine => !!x);
          if (parasRaw.length) {
            lineBoxes = parasRaw;
          } else {
            const words = (data.words ?? [])
              .map((w) => toBox(w))
              .filter((x): x is BBoxLine => !!x);
            lineBoxes = mergeLinesToParagraphs(mergeWordsToLines(words));
          }
        }

        // Recover lines that fell outside merged paragraph boxes
        lineBoxes = mergeOrphanLines(lineBoxes, linesRaw);

        const paras = lineBoxes.filter(
          (p) => !isJunkText(p.text) && p.text.trim().length >= 1,
        );

        let list: OcrBlock[] = paras.map((ln, i) => {
          const x = clamp01(ln.x0 / iw);
          const y = clamp01(ln.y0 / ih);
          const w = clamp01((ln.x1 - ln.x0) / iw);
          const h = clamp01((ln.y1 - ln.y0) / ih);
          return {
            id: `b-${i}`,
            text: ln.text,
            translation: "",
            status: "idle" as const,
            x,
            y,
            w: Math.max(w, 0.02),
            h: Math.max(h, 0.012),
          };
        });

        // Drop boxes that escaped image bounds almost entirely
        list = list.filter((b) => b.x < 0.98 && b.y < 0.98 && b.w > 0 && b.h > 0);

        setBlocks(list);
        setStatus(`识别到 ${list.length} 段文字`);
        if (canvasWrapRef.current) {
          canvasWrapRef.current.scrollTop = 0;
          canvasWrapRef.current.scrollLeft = 0;
        }
        if (autoTranslate && list.length > 0) {
          setStatus(`正在翻译 0/${list.length}…`);
          list = await translateBlocks(list, (done, total) => {
            setStatus(`正在翻译 ${done}/${total}…`);
          });
          setBlocks(list);
          setStatus(summarizeTranslateStatus(list));
        }
      } catch (e) {
        setError(toFriendlyError(e, "识别失败，请重试"));
        setStatus(null);
      } finally {
        setBusy(false);
      }
    },
    [autoTranslate, ensureWorker, imageUrl, translateBlocks],
  );

  const handledIncomingIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!incomingImage) return;
    if (handledIncomingIdRef.current === incomingImage.id) return;
    handledIncomingIdRef.current = incomingImage.id;
    void runOcr(incomingImage.file).finally(() => {
      onIncomingHandled?.();
    });
  }, [incomingImage, onIncomingHandled, runOcr]);

  const onRetranslateAll = async () => {
    if (!blocks.length) return;
    setBusy(true);
    setError(null);
    setStatus(`正在重新翻译 0/${blocks.length}…`);
    try {
      const list = await translateBlocks(blocks, (done, total) => {
        setStatus(`正在重新翻译 ${done}/${total}…`);
      });
      setBlocks(list);
      setStatus(summarizeTranslateStatus(list));
    } catch (e) {
      setError(toFriendlyError(e, "翻译失败，请稍后重试"));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async (
    id: string,
    text: string,
    e: { stopPropagation: () => void },
  ) => {
    e.stopPropagation();
    await copyText(text);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1200);
  };

  const srcFiltered = useMemo(() => {
    const q = srcQuery.trim().toLowerCase();
    if (!q) return blocks;
    return blocks.filter((b) => b.text.toLowerCase().includes(q));
  }, [blocks, srcQuery]);

  const dstFiltered = useMemo(() => {
    const q = dstQuery.trim().toLowerCase();
    if (!q) return blocks;
    return blocks.filter(
      (b) =>
        b.translation.toLowerCase().includes(q) ||
        (b.status === "pending" && "正在翻译".includes(q)),
    );
  }, [blocks, dstQuery]);

  const blockIndex = useMemo(() => {
    const m = new Map<string, number>();
    blocks.forEach((b, i) => m.set(b.id, i + 1));
    return m;
  }, [blocks]);

  return (
    <div className="ocr-layout">
      <div className="ocr-main">
        <div className="ocr-toolbar">
          <button
            type="button"
            className="pdf-tool-btn"
            onClick={() => inputRef.current?.click()}
          >
            打开图片
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void runOcr(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="pdf-tool-btn"
            disabled={busy || !blocks.length}
            onClick={() => void onRetranslateAll()}
          >
            重新翻译全部
          </button>
          <label className="ocr-toggle">
            <input
              type="checkbox"
              checked={showTranslation}
              onChange={(e) => setShowTranslation(e.target.checked)}
            />
            显示译文叠字
          </label>
          {status && <span className="hint">{status}</span>}
          <span className="ocr-toolbar-engine" title={engineBadge}>
            {engineBadge}
          </span>
        </div>

        <div className="ocr-canvas-wrap" ref={canvasWrapRef}>
          {!imageUrl && (
            <div className="pdf-empty">
              <p>打开图片后将识别文字，并在对应位置叠字显示译文。</p>
              <button
                type="button"
                className="send-btn"
                onClick={() => inputRef.current?.click()}
              >
                选择图片
              </button>
            </div>
          )}
          {imageUrl && (
            <div
              className={
                selectedId ? "ocr-stage has-selection" : "ocr-stage"
              }
              ref={stageRef}
            >
              <img src={imageUrl} alt="OCR" className="ocr-image" draggable={false} />
              {blocks.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  data-block-id={b.id}
                  className={
                    b.id === selectedId ? "ocr-box active" : "ocr-box"
                  }
                  style={{
                    left: `${b.x * 100}%`,
                    top: `${b.y * 100}%`,
                    width: `${b.w * 100}%`,
                    height: `${b.h * 100}%`,
                  }}
                  onClick={() => selectBlock(b.id)}
                  title={b.text}
                >
                  {showTranslation &&
                  b.status === "done" &&
                  b.translation
                    ? b.translation
                    : ""}
                </button>
              ))}
            </div>
          )}
          {error && <p className="boot-error ocr-error">{error}</p>}
        </div>
      </div>

      <div
        className="col-resizer col-resizer-panel ocr-side-resizer"
        title="拖动调整原文栏宽度"
        onMouseDown={(e) => beginSideResize(e, "grow-left")}
      />
      <aside className="ocr-side" style={{ width: sideWidth }}>
        <div className="ocr-dual" ref={dualRef}>
          <div
            className="ocr-col"
            style={{ flex: `0 0 ${srcRatio * 100}%`, maxWidth: "75%" }}
          >
            <div className="ocr-col-head">
              <h3>原文</h3>
              <input
                className="ocr-col-search"
                placeholder="搜索原文…"
                value={srcQuery}
                onChange={(e) => setSrcQuery(e.target.value)}
              />
            </div>
            <div className="ocr-col-body" ref={srcListRef}>
              {srcFiltered.length === 0 ? (
                <p className="hint ocr-col-empty">暂无原文</p>
              ) : (
                srcFiltered.map((b) => (
                  <div
                    key={b.id}
                    data-row-id={b.id}
                    className={
                      b.id === selectedId
                        ? "ocr-pair-row active"
                        : "ocr-pair-row"
                    }
                    onClick={() => selectBlock(b.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectBlock(b.id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <span className="ocr-block-idx">
                      #{blockIndex.get(b.id) ?? "?"}
                    </span>
                    <span className="ocr-block-text">
                      {highlightSearchNodes(b.text, srcQuery)}
                    </span>
                    <button
                      type="button"
                      className="ocr-copy-btn"
                      title="复制原文"
                      onClick={(e) =>
                        void onCopy(`src-${b.id}`, b.text, e)
                      }
                    >
                      {copiedId === `src-${b.id}` ? "已复制" : "复制"}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
          <div
            className="col-resizer-panel ocr-dual-resizer"
            title="拖动调整原文/译文宽度"
            onMouseDown={beginDualResize}
          />
          <div className="ocr-col" style={{ flex: "1 1 0", minWidth: "25%" }}>
            <div className="ocr-col-head">
              <h3>译文</h3>
              <input
                className="ocr-col-search"
                placeholder="搜索译文…"
                value={dstQuery}
                onChange={(e) => setDstQuery(e.target.value)}
              />
            </div>
            <div className="ocr-col-body" ref={dstListRef}>
              {dstFiltered.length === 0 ? (
                <p className="hint ocr-col-empty">暂无译文</p>
              ) : (
                dstFiltered.map((b) => {
                  const display =
                    b.status === "pending"
                      ? "正在翻译…"
                      : b.translation || "（尚未翻译）";
                  const copyable =
                    b.status !== "pending" && !!b.translation.trim();
                  return (
                    <div
                      key={b.id}
                      data-row-id={b.id}
                      className={
                        b.id === selectedId
                          ? "ocr-pair-row active"
                          : "ocr-pair-row"
                      }
                      onClick={() => selectBlock(b.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          selectBlock(b.id);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <span className="ocr-block-idx">
                        #{blockIndex.get(b.id) ?? "?"}
                      </span>
                      <span
                        className={
                          b.status === "pending"
                            ? "ocr-block-text is-pending"
                            : b.status === "error"
                              ? "ocr-block-text is-error"
                              : "ocr-block-text"
                        }
                      >
                        {b.status === "pending"
                          ? display
                          : highlightSearchNodes(display, dstQuery)}
                      </span>
                      <button
                        type="button"
                        className="ocr-copy-btn"
                        title="复制译文"
                        disabled={!copyable}
                        onClick={(e) =>
                          void onCopy(`dst-${b.id}`, b.translation, e)
                        }
                      >
                        {copiedId === `dst-${b.id}` ? "已复制" : "复制"}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
