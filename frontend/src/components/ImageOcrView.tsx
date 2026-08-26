import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { api, type OcrMode, type OcrModelStatus } from "../api";
import { copyText } from "../clipboard";
import { toFriendlyError } from "../friendlyError";
import { highlightSearchNodes } from "../highlightText";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import {
  LocalPaddleOcr,
  OCR_MODE_LABELS,
  normalizeOcrMode,
  type PaddleOcrLine,
} from "../ocr/paddleOcr";
import { getEngineInfo } from "../translateEngines";
import { LangCombobox } from "./LangCombobox";

export type OcrBlock = {
  id: string;
  pageId: string;
  text: string;
  translation: string;
  status: "idle" | "pending" | "done" | "error";
  /** normalized 0–1 relative to image */
  x: number;
  y: number;
  w: number;
  h: number;
};

type OcrPage = {
  id: string;
  imageUrl: string;
  label: string;
  /** Kept so a stuck "queued" page can be re-enqueued after a race. */
  file: File;
  blocks: OcrBlock[];
  statusText: string | null;
  error: string | null;
  busy: boolean;
};

type Props = {
  ocrLang: string;
  ocrMode: string;
  autoTranslate: boolean;
  translateProvider: string;
  translateSource: string;
  translateTarget: string;
  translateMaxLength: number;
  translateAutoChunk: boolean;
  model?: string;
  apiUrl?: string;
  apiKey?: string;
  /** External image to OCR (e.g. from PDF context menu). */
  incomingImage?: { file: File; id: number } | null;
  onIncomingHandled?: () => void;
  /** When false, ignore Ctrl+V / paste (view stays mounted while hidden). */
  active?: boolean;
  onOcrModeChange?: (mode: OcrMode) => void | Promise<void>;
  onTranslateSourceChange?: (source: string) => void | Promise<void>;
  onTranslateTargetChange?: (target: string) => void | Promise<void>;
};

const IMAGE_OCR_MODES: Array<{
  id: OcrMode;
  description: string;
  warning?: string;
}> = [
  {
    id: "fast",
    description: "日常中英日图片，以及流程图、架构图和稀疏标签图",
  },
  {
    id: "precise",
    description: "密集排版、小字、复杂表格和低质量扫描件",
    warning: "并不是越“精确”越好；流程图和稀疏标签图可能不如快速模式",
  },
  {
    id: "english",
    description: "英文论文、技术文档、代码说明和英文缩写",
  },
];

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

type OcrSelectionField = "source" | "translation";
type OcrResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

function looksLikeCode(text: string): boolean {
  return /[{};()<>[\]=]|::|->|#include|\b(auto|void|int|return|if|else|for|while|class|struct)\b/.test(
    text,
  );
}

function isJunkText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // Screenshot viewers can paint this transient hint over the image itself.
  // It is UI chrome rather than source content and may also obscure real text.
  if (/^双击查看图片[。.!！]?$/u.test(t)) return true;
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
    const host = out.find((p) => coversPoint(p, cx, cy));
    if (!host) {
      out.push({ ...ln });
      continue;
    }
    // Short diagram labels (Client/Server) often sit inside a large colored
    // region whose paragraph text never includes them — keep as own box.
    const short =
      ln.text.length <= 16 && /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(ln.text);
    const missing = !host.text.toLowerCase().includes(ln.text.toLowerCase());
    if (short && missing) {
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

function imageExtFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("bmp")) return "bmp";
  if (m.includes("png")) return "png";
  return "png";
}

function looksLikeImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|tiff?|ico)$/i.test(file.name || "");
}

function fileFromClipboardData(data: DataTransfer | null | undefined): File | null {
  if (!data) return null;
  if (data.items?.length) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file && looksLikeImageFile(file)) return file;
    }
  }
  if (data.files?.length) {
    for (const file of Array.from(data.files)) {
      if (looksLikeImageFile(file)) return file;
    }
  }
  return null;
}

function filesFromDataTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  const seen = new Set<string>();
  const push = (file: File | null) => {
    if (!file || !looksLikeImageFile(file)) return;
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(file);
  };
  if (data.files?.length) {
    for (const file of Array.from(data.files)) push(file);
  }
  if (!out.length && data.items?.length) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== "file") continue;
      push(item.getAsFile());
    }
  }
  return out;
}

async function rgbaToPngFile(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<File | null> {
  if (width <= 0 || height <= 0 || rgba.byteLength < width * height * 4) {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const copy = new Uint8ClampedArray(rgba.byteLength);
  copy.set(rgba);
  ctx.putImageData(new ImageData(copy, width, height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) return null;
  return new File([blob], "clipboard.png", { type: "image/png" });
}

type ClipboardPick = { file: File | null; error?: string };

async function fileFromNativeClipboardCommand(): Promise<ClipboardPick> {
  try {
    const bytes = await invoke<number[] | Uint8Array>("clipboard_read_image_png");
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!u8.byteLength) return { file: null, error: "剪贴板图片为空" };
    const isJpeg = u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8;
    const mime = isJpeg ? "image/jpeg" : "image/png";
    const ext = isJpeg ? "jpg" : "png";
    return { file: new File([u8], `clipboard.${ext}`, { type: mime }) };
  } catch (e) {
    return { file: null, error: toFriendlyError(e, "读取系统剪贴板失败") };
  }
}

async function fileFromTauriClipboardPlugin(): Promise<ClipboardPick> {
  try {
    const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
    const image = await readImage();
    try {
      const [{ width, height }, rgba] = await Promise.all([
        image.size(),
        image.rgba(),
      ]);
      const file = await rgbaToPngFile(rgba, width, height);
      return file
        ? { file }
        : { file: null, error: "无法将剪贴板图像转换为 PNG" };
    } finally {
      await image.close().catch(() => undefined);
    }
  } catch (e) {
    return { file: null, error: toFriendlyError(e, "剪贴板插件读取失败") };
  }
}

async function fileFromBrowserClipboard(): Promise<ClipboardPick> {
  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.read !== "function") {
    return { file: null };
  }
  try {
    const items = await clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      return {
        file: new File([blob], `clipboard.${imageExtFromMime(type)}`, {
          type,
        }),
      };
    }
  } catch (e) {
    return { file: null, error: toFriendlyError(e, "浏览器剪贴板读取失败") };
  }
  return { file: null };
}

async function fileFromAnyClipboard(): Promise<ClipboardPick> {
  const native = await fileFromNativeClipboardCommand();
  if (native.file) return native;
  const plugin = await fileFromTauriClipboardPlugin();
  if (plugin.file) return plugin;
  const browser = await fileFromBrowserClipboard();
  if (browser.file) return browser;
  return {
    file: null,
    error:
      native.error ||
      plugin.error ||
      browser.error ||
      "剪贴板中没有图片。请先用 Win+Shift+S 截图，或复制图片后再粘贴。",
  };
}

function isEditablePasteTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.closest("input, textarea, select, [contenteditable='true']")) {
    return true;
  }
  return false;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(message));
    }, ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
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

/** Grayscale / binarize colored fills so black labels on blue/green stay crisp. */
async function preprocessImageForOcr(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("无法预处理图片"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, img.naturalWidth || img.width);
    canvas.height = Math.max(1, img.naturalHeight || img.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      let y = 0.299 * r + 0.587 * g + 0.114 * b;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma > 30) {
        // Saturated fill (blue/green blocks): hard threshold keeps dark glyphs
        y = y < 155 ? 0 : 255;
      } else {
        y = Math.max(0, Math.min(255, (y - 128) * 1.2 + 128));
      }
      d[i] = d[i + 1] = d[i + 2] = y;
    }
    ctx.putImageData(imageData, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    return blob ?? file;
  } finally {
    URL.revokeObjectURL(url);
  }
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

/**
 * Paddle already returns physical text lines. Only repair fragments that are
 * clearly part of the same line: OCR subscripts and wrapped prose continuations.
 * This deliberately avoids the broad paragraph merge used by Tesseract.
 */
function repairPaddleLines(lines: BBoxLine[]): BBoxLine[] {
  const source = lines
    .filter((line) => !isJunkText(line.text))
    .map((line) => ({
      ...line,
      text: line.text.replace(/^T\{(\d)$/, "T$1"),
    }));
  const consumed = new Set<number>();

  source.forEach((fragment, fragmentIndex) => {
    const digit = fragment.text.match(/^([0-9])$/)?.[1];
    if (!digit) return;
    const fragmentH = Math.max(1, fragment.y1 - fragment.y0);
    const fragmentCy = (fragment.y0 + fragment.y1) / 2;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    source.forEach((candidate, candidateIndex) => {
      if (candidateIndex === fragmentIndex || !/^T(?:\d)?(?::|$)/.test(candidate.text)) {
        return;
      }
      const candidateH = Math.max(1, candidate.y1 - candidate.y0);
      const candidateCy = (candidate.y0 + candidate.y1) / 2;
      const nearPrefix =
        fragment.x0 >= candidate.x0 - candidateH * 0.15 &&
        fragment.x1 <= candidate.x0 + candidateH * 2.2;
      const sameBand =
        Math.abs(fragmentCy - candidateCy) <= Math.max(candidateH, fragmentH) * 0.7;
      if (!nearPrefix || !sameBand || fragmentH > candidateH * 0.85) return;
      const distance = Math.abs(fragmentCy - candidateCy) + Math.abs(fragment.x0 - candidate.x0);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = candidateIndex;
      }
    });

    if (bestIndex < 0) return;
    const candidate = source[bestIndex];
    if (!new RegExp(`^T${digit}(?::|$)`).test(candidate.text)) {
      candidate.text = candidate.text.replace(/^T(?=:|$)/, `T${digit}`);
    }
    candidate.x0 = Math.min(candidate.x0, fragment.x0);
    candidate.y0 = Math.min(candidate.y0, fragment.y0);
    candidate.x1 = Math.max(candidate.x1, fragment.x1);
    candidate.y1 = Math.max(candidate.y1, fragment.y1);
    consumed.add(fragmentIndex);
  });

  // A low detection threshold helps recover T₂/T₃, but may also expose a tiny
  // duplicate digit from a packet/icon. Once the same digit is already part of
  // a T-label, discard only the much smaller isolated duplicate.
  const medianHeight = [...source]
    .map((line) => Math.max(1, line.y1 - line.y0))
    .sort((a, b) => a - b)[Math.floor(source.length / 2)] || 1;
  source.forEach((fragment, index) => {
    if (consumed.has(index) || !/^\d$/.test(fragment.text)) return;
    const hasMatchingLabel = source.some(
      (candidate, candidateIndex) =>
        candidateIndex !== index &&
        new RegExp(`^T${fragment.text}(?::|$)`).test(candidate.text),
    );
    const fragmentH = Math.max(1, fragment.y1 - fragment.y0);
    if (hasMatchingLabel && fragmentH < medianHeight * 0.75) {
      consumed.add(index);
    }
  });

  const sorted = source
    .filter((_, index) => !consumed.has(index))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const repaired: BBoxLine[] = [];
  // The detection result is sorted by rows, so a multi-column layout arrives
  // as A1, B1, C1, A2, B2, C2. Track the last physical line of every group
  // and find the nearest compatible group in 2D instead of considering only
  // the previous array item.
  const groupTails: BBoxLine[] = [];
  for (const line of sorted) {
    const lineH = Math.max(8, line.lineH || line.y1 - line.y0);
    const technicalToken = /^(?:\d+|T\d*|[A-Z])$/.test(line.text);
    const startsNewEntry = /^T(?:\d+)?\s*[:：]/.test(line.text);
    let bestGroup = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    if (!technicalToken && !startsNewEntry) {
      repaired.forEach((group, groupIndex) => {
        const tail = groupTails[groupIndex];
        const tailH = Math.max(8, tail.lineH || tail.y1 - tail.y0);
        const refH = Math.max(tailH, lineH);
        const heightRatio = lineH / tailH;
        const comparableLineHeight = heightRatio >= 0.55 && heightRatio <= 1.8;
        const groupCanContinue =
          /[A-Za-z\u3040-\u30ff\u3400-\u9fff]/u.test(group.text) &&
          !/^(?:\d+|T\d*)$/.test(group.text.trim());
        if (!groupCanContinue) return;

        const tailCy = (tail.y0 + tail.y1) / 2;
        const lineCy = (line.y0 + line.y1) / 2;
        const horizontalGap = line.x0 - tail.x1;
        const samePhysicalLine =
          comparableLineHeight &&
          Math.abs(lineCy - tailCy) < refH * 0.55 &&
          horizontalGap >= -lineH &&
          horizontalGap < tailH * 1.6;

        const verticalGap = line.y0 - tail.y1;
        const overlap =
          Math.min(tail.x1, line.x1) - Math.max(tail.x0, line.x0);
        const minWidth = Math.max(
          1,
          Math.min(tail.x1 - tail.x0, line.x1 - line.x0),
        );
        const tailCx = (tail.x0 + tail.x1) / 2;
        const lineCx = (line.x0 + line.x1) / 2;
        const sameColumn =
          overlap >= minWidth * 0.3 ||
          Math.abs(lineCx - tailCx) <= refH * 1.25 ||
          Math.abs(line.x0 - tail.x0) <= refH * 0.8;
        const wrappedLine =
          comparableLineHeight &&
          verticalGap >= -tailH * 0.2 &&
          verticalGap < refH * 1.05 &&
          sameColumn;
        if (!samePhysicalLine && !wrappedLine) return;

        const score = samePhysicalLine
          ? Math.abs(lineCy - tailCy) + Math.max(0, horizontalGap) * 0.2
          : Math.max(0, verticalGap) + Math.abs(lineCx - tailCx) * 0.18;
        if (score < bestScore) {
          bestScore = score;
          bestGroup = groupIndex;
        }
      });
    }

    if (bestGroup >= 0) {
      const previous = repaired[bestGroup];
      previous.text = `${previous.text} ${line.text}`.replace(/\s+/g, " ").trim();
      previous.x0 = Math.min(previous.x0, line.x0);
      previous.y0 = Math.min(previous.y0, line.y0);
      previous.x1 = Math.max(previous.x1, line.x1);
      previous.y1 = Math.max(previous.y1, line.y1);
      previous.confidence = Math.min(previous.confidence, line.confidence);
      previous.lineH = lineH;
      groupTails[bestGroup] = { ...line, lineH };
    } else {
      repaired.push({ ...line });
      groupTails.push({ ...line, lineH });
    }
  }
  // Recover a missing subscript only when the surrounding OCR entries prove a
  // simple numbered sequence (for example T:, T2:, T3:, T: -> T1..T4).
  const entries = repaired
    .map((line, index) => {
      const match = line.text.match(/^T(\d)?\s*[:：]/);
      return match ? { index, digit: match[1] ? Number(match[1]) : null } : null;
    })
    .filter((entry): entry is { index: number; digit: number | null } => entry !== null);
  if (entries.filter((entry) => entry.digit !== null).length >= 2) {
    entries.forEach((entry, position) => {
      if (entry.digit !== null) return;
      const previous = [...entries.slice(0, position)]
        .reverse()
        .find((candidate) => candidate.digit !== null)?.digit ?? undefined;
      const next = entries
        .slice(position + 1)
        .find((candidate) => candidate.digit !== null)?.digit ?? undefined;
      const inferred =
        next !== undefined && next > 1
          ? next - 1
          : previous !== undefined && previous < 9
            ? previous + 1
            : null;
      if (inferred !== null) {
        repaired[entry.index].text = repaired[entry.index].text.replace(
          /^T(?=\s*[:：])/,
          `T${inferred}`,
        );
      }
    });
  }
  return repaired;
}

function isLiteralOcrToken(text: string): boolean {
  return /^(?:\d+|T(?:\d+)?|[A-Z])$/.test(text.trim());
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Insert line breaks after sentences when the box is tall (paragraph region). */
function formatOverlayText(text: string, boxWpx: number, boxHpx: number): string {
  const t = text.trim();
  if (!t) return t;
  if (boxHpx < boxWpx * 0.4) return t;
  return t
    .replace(/\s*([。；;！？!?])\s*/g, "$1\n")
    .replace(/\n+/g, "\n")
    .trim();
}

/** Largest font size that fits wrapped text into the OCR box (multi-line aware). */
function overlayFontSize(boxWpx: number, boxHpx: number, text: string): number {
  if (boxWpx <= 0 || boxHpx <= 0) return 10;
  const lineHeight = 1.2;
  const charEm = 0.95;
  // Match the overlay's border and horizontal padding so calculated wrapping
  // is the same as the text that is actually painted on the image.
  const availW = Math.max(8, boxWpx - 8);
  const availH = Math.max(8, boxHpx - 2);
  const segments = text
    .split(/\n/)
    .map((s) => s.replace(/\s+/g, ""))
    .filter(Boolean);
  const parts = segments.length ? segments : [""];

  const fits = (fontPx: number) => {
    let lines = 0;
    for (const seg of parts) {
      const chars = Math.max(1, Array.from(seg).length);
      const charsPerLine = Math.max(1, Math.floor(availW / (fontPx * charEm)));
      lines += Math.ceil(chars / charsPerLine);
    }
    return lines * fontPx * lineHeight <= availH;
  };

  let lo = 7;
  // Paragraph translations become visually dominant if a two-line OCR box is
  // treated as one very tall line. Short labels may remain large; prose is
  // capped to the surrounding document's typical reading size.
  const proseCap = Array.from(text.replace(/\s+/g, "")).length >= 12 ? 26 : 56;
  let hi = Math.min(availH * 0.9, proseCap);
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return Math.max(7, +lo.toFixed(1));
}

function newPageId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function OcrPageCard({
  page,
  index,
  selected,
  selectedBlockId,
  selectedField,
  showTranslation,
  onSelectPage,
  onSelectBlock,
  onRerun,
  onContextMenu,
}: {
  page: OcrPage;
  index: number;
  selected: boolean;
  selectedBlockId: string | null;
  selectedField: OcrSelectionField | null;
  showTranslation: boolean;
  onSelectPage: () => void;
  onSelectBlock: (id: string, field: OcrSelectionField) => void;
  onRerun: () => void;
  onContextMenu: (e: ReactMouseEvent, pageId: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [baseImageWidth, setBaseImageWidth] = useState<number | null>(null);
  const [imageScale, setImageScale] = useState(1);
  const [imageResizing, setImageResizing] = useState(false);
  const [draggedOverlay, setDraggedOverlay] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const initializedImageRef = useRef<string | null>(null);

  const beginOverlayDrag = useCallback(
    (
      e: ReactPointerEvent<HTMLButtonElement>,
      id: string,
      field: OcrSelectionField,
    ) => {
      if (field !== "translation" || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      onSelectBlock(id, field);
      const startX = e.clientX;
      const startY = e.clientY;
      setDraggedOverlay({ id, x: 0, y: 0 });

      const onMove = (event: PointerEvent) => {
        setDraggedOverlay({
          id,
          x: event.clientX - startX,
          y: event.clientY - startY,
        });
      };
      const onUp = () => {
        setDraggedOverlay(null);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [onSelectBlock],
  );

  useEffect(() => {
    initializedImageRef.current = null;
    setBaseImageWidth(null);
    setImageScale(1);
  }, [page.imageUrl]);

  const beginImageResize = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>, direction: OcrResizeDirection) => {
      e.preventDefault();
      e.stopPropagation();
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      const startScale = imageScale;
      const aspect = rect.width / rect.height;
      const horizontalSign = direction.includes("e")
        ? 1
        : direction.includes("w")
          ? -1
          : 0;
      const verticalSign = direction.includes("s")
        ? 1
        : direction.includes("n")
          ? -1
          : 0;
      setImageResizing(true);
      e.currentTarget.setPointerCapture(pointerId);

      const onMove = (event: PointerEvent) => {
        let widthDelta = horizontalSign * (event.clientX - startX);
        const verticalWidthDelta =
          verticalSign * (event.clientY - startY) * aspect;
        if (!horizontalSign) widthDelta = verticalWidthDelta;
        else if (verticalSign && Math.abs(verticalWidthDelta) > Math.abs(widthDelta)) {
          widthDelta = verticalWidthDelta;
        }
        const nextScale = startScale * ((rect.width + widthDelta) / rect.width);
        setImageScale(Math.min(2, Math.max(0.05, nextScale)));
      };
      const onUp = () => {
        setImageResizing(false);
        document.body.classList.remove("ocr-image-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      document.body.classList.add("ocr-image-resizing");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [imageScale],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      setStageSize({ w: 0, h: 0 });
      return;
    }
    const measure = () => {
      const img = stage.querySelector(".ocr-image") as HTMLImageElement | null;
      if (
        img?.complete &&
        img.naturalWidth > 0 &&
        initializedImageRef.current !== page.imageUrl
      ) {
        const card = stage.closest(".ocr-page") as HTMLElement | null;
        const wrap = stage.closest(".ocr-canvas-wrap") as HTMLElement | null;
        const header = card?.querySelector(".ocr-page-head") as HTMLElement | null;
        const availableWidth = Math.max(
          1,
          (card?.clientWidth || stage.parentElement?.clientWidth || img.naturalWidth) - 24,
        );
        const fittedWidth = Math.min(img.naturalWidth, availableWidth);
        const fittedHeight = fittedWidth * (img.naturalHeight / img.naturalWidth);
        const availableHeight = Math.max(
          1,
          (wrap?.clientHeight || fittedHeight) - (header?.offsetHeight || 0) - 36,
        );
        const fitScale = Math.min(1, availableHeight / Math.max(1, fittedHeight));
        initializedImageRef.current = page.imageUrl;
        setBaseImageWidth(fittedWidth);
        setImageScale(Math.max(0.02, fitScale));
      }
      const w = img?.clientWidth || stage.clientWidth;
      const h = img?.clientHeight || stage.clientHeight;
      setStageSize((prev) =>
        prev.w === w && prev.h === h ? prev : { w, h },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    const img = stage.querySelector(".ocr-image") as HTMLImageElement | null;
    if (img) {
      ro.observe(img);
      if (!img.complete) img.addEventListener("load", measure);
    }
    return () => {
      ro.disconnect();
      img?.removeEventListener("load", measure);
    };
  }, [page.imageUrl, page.blocks.length]);

  // Character-count estimates are only a starting point. Mixed CJK/Latin
  // fonts and browser word wrapping can need more rows than the estimate, so
  // measure the actual rendered box and reduce its font until nothing clips.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || stageSize.w <= 0 || stageSize.h <= 0) return;
    const boxes = Array.from(stage.querySelectorAll(".ocr-box")) as HTMLElement[];
    boxes.forEach((box) => {
      const maximum = Number(box.dataset.fontMax || 0);
      if (!Number.isFinite(maximum) || maximum <= 0) return;
      const fits = () =>
        box.scrollHeight <= box.clientHeight + 1 &&
        box.scrollWidth <= box.clientWidth + 1;
      box.style.fontSize = `${maximum}px`;
      if (fits()) return;

      let low = 5;
      let high = maximum;
      box.style.fontSize = `${low}px`;
      if (!fits()) return;
      for (let i = 0; i < 12; i += 1) {
        const mid = (low + high) / 2;
        box.style.fontSize = `${mid}px`;
        if (fits()) low = mid;
        else high = mid;
      }
      box.style.fontSize = `${Math.max(5, low - 0.2).toFixed(1)}px`;
    });
  }, [
    page.blocks,
    selectedBlockId,
    selectedField,
    showTranslation,
    stageSize.h,
    stageSize.w,
  ]);

  return (
    <article
      className={
        "ocr-page" +
        (selected ? " is-selected" : "") +
        (page.busy ? " is-busy" : "")
      }
      data-page-id={page.id}
      onClick={onSelectPage}
      onContextMenu={(e) => onContextMenu(e, page.id)}
    >
      <header className="ocr-page-head">
        <span className="ocr-page-title">
          图 {index + 1}
          {page.label ? ` · ${page.label}` : ""}
        </span>
        <span className="ocr-page-meta">
          <button
            type="button"
            className="ocr-copy-btn ocr-rerun-btn"
            disabled={page.busy}
            title="使用当前识别模式重新识别此图片"
            onClick={(e) => {
              e.stopPropagation();
              onRerun();
            }}
          >
            重新识别
          </button>{" "}
          <span className="ocr-image-scale" title="拖拽图片边缘可等比例缩放；双击边缘恢复大小">
            {Math.round(imageScale * 100)}%
          </span>
          {page.busy
            ? page.statusText || "处理中…"
            : page.error
              ? page.error
              : page.statusText ||
                (page.blocks.length
                  ? `${page.blocks.length} 段`
                  : "等待识别")}
        </span>
      </header>
      <div
        className={
          selectedBlockId && page.blocks.some((b) => b.id === selectedBlockId)
            ? `ocr-stage has-selection${imageResizing ? " is-resizing" : ""}`
            : `ocr-stage${imageResizing ? " is-resizing" : ""}`
        }
        ref={stageRef}
        style={{
          width: baseImageWidth
            ? `${baseImageWidth * imageScale}px`
            : `${imageScale * 100}%`,
        }}
      >
        <img
          src={page.imageUrl}
          alt={page.label || `OCR ${index + 1}`}
          className="ocr-image"
          draggable={false}
        />
        {page.blocks.map((b) => {
          const blockSelected = b.id === selectedBlockId;
          const displayTranslation = blockSelected
            ? selectedField === "translation"
            : showTranslation;
          const hasTranslation = b.status === "done" && b.translation.trim();
          const displayedField: OcrSelectionField =
            displayTranslation && hasTranslation ? "translation" : "source";
          const rawLabel = displayedField === "translation" ? b.translation : b.text;
          const boxW = b.w * stageSize.w;
          const boxH = b.h * stageSize.h;
          const label = rawLabel
            ? formatOverlayText(rawLabel, boxW, boxH)
            : "";
          const fontSize = label
            ? overlayFontSize(boxW, boxH, label)
            : Math.max(8, boxH * 0.75);
          const dragOffset = draggedOverlay?.id === b.id ? draggedOverlay : null;
          return (
            <button
              key={b.id}
              type="button"
              data-block-id={b.id}
              data-field={displayedField}
              data-font-max={fontSize.toFixed(1)}
              className={
                blockSelected
                  ? `ocr-box active${dragOffset ? " is-dragging" : ""}`
                  : selected && !selectedBlockId
                    ? "ocr-box page-active"
                    : "ocr-box"
              }
              style={{
                left: `${b.x * 100}%`,
                top: `${b.y * 100}%`,
                width: `${b.w * 100}%`,
                height: `${b.h * 100}%`,
                fontSize: `${fontSize.toFixed(1)}px`,
                lineHeight: 1.2,
                whiteSpace: label.includes("\n") ? "pre-wrap" : "normal",
                transform: dragOffset
                  ? `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0)`
                  : undefined,
              }}
              onPointerDown={(e) => beginOverlayDrag(e, b.id, displayedField)}
              onClick={(e) => {
                e.stopPropagation();
                onSelectBlock(b.id, displayedField);
              }}
              title={b.text}
            >
              {label}
            </button>
          );
        })}
        {(["n", "ne", "e", "se", "s", "sw", "w", "nw"] as OcrResizeDirection[]).map(
          (direction) => (
            <button
              key={direction}
              type="button"
              className={`ocr-image-resize-handle is-${direction}`}
              aria-label="等比例缩放图片"
              title="拖动以等比例缩放；双击恢复为 100%"
              onPointerDown={(e) => beginImageResize(e, direction)}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setImageScale(1);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ),
        )}
      </div>
      {page.error && <p className="boot-error ocr-error">{page.error}</p>}
    </article>
  );
}

export function ImageOcrView({
  ocrLang,
  ocrMode,
  autoTranslate,
  translateProvider,
  translateSource,
  translateTarget,
  translateMaxLength,
  translateAutoChunk,
  model = "",
  apiUrl = "",
  apiKey = "",
  incomingImage = null,
  onIncomingHandled,
  active = true,
  onOcrModeChange,
  onTranslateSourceChange,
  onTranslateTargetChange,
}: Props) {
  const [pages, setPages] = useState<OcrPage[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [selectedField, setSelectedField] = useState<OcrSelectionField | null>(null);
  const [selectionPulse, setSelectionPulse] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; ok: boolean } | null>(
    null,
  );
  const toastTimerRef = useRef<number | null>(null);
  const [showTranslation, setShowTranslation] = useState(true);
  const [ocrModeMenuOpen, setOcrModeMenuOpen] = useState(false);
  const [ocrModelStatus, setOcrModelStatus] = useState<OcrModelStatus | null>(null);
  const [ocrModeBusy, setOcrModeBusy] = useState<OcrMode | null>(null);
  const [ocrModeError, setOcrModeError] = useState<string | null>(null);
  const [srcQuery, setSrcQuery] = useState("");
  const [dstQuery, setDstQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    pageId: string | null;
  } | null>(null);
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
  const ocrModeMenuRef = useRef<HTMLDivElement>(null);
  const ocrProgressPollRef = useRef<number | null>(null);
  const paddleOcrRef = useRef<LocalPaddleOcr | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerLangRef = useRef<string | null>(null);
  const workerCreateGenRef = useRef(0);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const dualRef = useRef<HTMLDivElement>(null);
  const srcListRef = useRef<HTMLDivElement>(null);
  const dstListRef = useRef<HTMLDivElement>(null);
  const translateGenRef = useRef(0);
  const sessionGenRef = useRef(0);
  const pasteLockRef = useRef(0);
  const pagesRef = useRef<OcrPage[]>([]);
  const queueRef = useRef<{ pageId: string; file: File }[]>([]);
  const drainingRef = useRef(false);
  const autoTranslateRef = useRef(autoTranslate);
  const normalizedOcrMode = normalizeOcrMode(ocrMode);

  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  useEffect(() => {
    autoTranslateRef.current = autoTranslate;
  }, [autoTranslate]);

  useEffect(() => {
    if (!active) return;
    void api.getOcrModelStatus().then(setOcrModelStatus).catch(() => undefined);
  }, [active]);

  useEffect(() => {
    if (!ocrModeMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!ocrModeMenuRef.current?.contains(event.target as Node)) {
        setOcrModeMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOcrModeMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [ocrModeMenuOpen]);

  useEffect(() => () => {
    if (ocrProgressPollRef.current !== null) {
      window.clearInterval(ocrProgressPollRef.current);
    }
  }, []);

  useEffect(() => {
    const previous = paddleOcrRef.current;
    paddleOcrRef.current = null;
    void previous?.dispose();
  }, [normalizedOcrMode]);

  useEffect(() => {
    try {
      localStorage.setItem("llmchat-ocr-src-ratio", String(srcRatio));
    } catch {
      // ignore
    }
  }, [srcRatio]);

  useEffect(() => {
    return () => {
      for (const p of pagesRef.current) {
        URL.revokeObjectURL(p.imageUrl);
      }
      void paddleOcrRef.current?.dispose();
      paddleOcrRef.current = null;
      void workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

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

  const engineBadge = useMemo(() => {
    if (translateProvider === "llm") {
      return model ? `模型：${model}` : "模型：大模型";
    }
    const info = getEngineInfo(translateProvider);
    return info ? `引擎：${info.label}` : `引擎：${translateProvider}`;
  }, [model, translateProvider]);

  const ocrLangLabel = useMemo(() => {
    const map: Record<string, string> = {
      eng: "英语",
      chi_sim: "简体中文",
      chi_tra: "繁体中文",
      "eng+chi_sim": "英语+简体中文",
      jpn: "日语",
      kor: "韩语",
    };
    return map[ocrLang] || ocrLang;
  }, [ocrLang]);

  const chooseImageOcrMode = useCallback(async (mode: OcrMode) => {
    if (ocrModeBusy) return;
    setOcrModeError(null);
    try {
      let modelStatus = ocrModelStatus;
      if (!modelStatus) {
        modelStatus = await api.getOcrModelStatus();
        setOcrModelStatus(modelStatus);
      }
      const installed =
        mode === "fast" || modelStatus.modes.find((item) => item.id === mode)?.installed;
      if (!installed) {
        setOcrModeBusy(mode);
        const poll = async () => {
          try {
            setOcrModelStatus(await api.getOcrModelStatus());
          } catch {
            /* The download request remains authoritative. */
          }
        };
        void poll();
        ocrProgressPollRef.current = window.setInterval(() => void poll(), 350);
        setOcrModelStatus(await api.ensureOcrMode(mode));
      }
      await onOcrModeChange?.(mode);
      setOcrModeMenuOpen(false);
    } catch (modeError) {
      setOcrModeError(toFriendlyError(modeError, "识别模式切换失败"));
    } finally {
      if (ocrProgressPollRef.current !== null) {
        window.clearInterval(ocrProgressPollRef.current);
        ocrProgressPollRef.current = null;
      }
      setOcrModeBusy(null);
      void api.getOcrModelStatus().then(setOcrModelStatus).catch(() => undefined);
    }
  }, [ocrModeBusy, ocrModelStatus, onOcrModeChange]);

  const ocrDownload = ocrModelStatus?.download;
  const ocrDownloadTotal = Math.max(0, ocrDownload?.totalBytes ?? 0);
  const ocrDownloadDone = Math.max(0, ocrDownload?.downloadedBytes ?? 0);
  const ocrDownloadPercent = ocrDownloadTotal
    ? Math.min(100, Math.round((ocrDownloadDone / ocrDownloadTotal) * 100))
    : 0;

  const ocrModeMenu = (
    <div className="literature-ocr-menu" ref={ocrModeMenuRef}>
      <button
        type="button"
        className={`pdf-tool-btn literature-ocr-trigger${ocrModeMenuOpen ? " is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={ocrModeMenuOpen}
        onClick={() => setOcrModeMenuOpen((open) => !open)}
      >
        识别模式 · {OCR_MODE_LABELS[normalizedOcrMode]}
        <svg className="literature-ocr-trigger-arrow" viewBox="0 0 20 20" aria-hidden>
          <path d="M4 7l6 6 6-6" />
        </svg>
      </button>
      {ocrModeMenuOpen ? (
        <div className="literature-ocr-dropdown" role="menu">
          <div className="literature-ocr-dropdown-head">
            <strong>图片识别模式</strong>
            <span>本地 OCR</span>
          </div>
          <div className="literature-ocr-options">
            {IMAGE_OCR_MODES.map((option) => {
              const selected = normalizedOcrMode === option.id;
              const statusItem = ocrModelStatus?.modes.find((item) => item.id === option.id);
              const downloading =
                ocrModeBusy === option.id ||
                (ocrDownload?.active === true && ocrDownload.mode === option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`literature-ocr-option${selected ? " is-selected" : ""}`}
                  disabled={ocrModeBusy !== null || ocrDownload?.active === true}
                  onClick={() => void chooseImageOcrMode(option.id)}
                >
                  <span className="literature-ocr-option-mark" aria-hidden>
                    {selected ? "✓" : ""}
                  </span>
                  <span className="literature-ocr-option-copy">
                    <strong>{OCR_MODE_LABELS[option.id]}</strong>
                    <small>
                      {option.description}
                      {option.warning ? (
                        <>
                          <br />
                          <strong>{option.warning}</strong>
                        </>
                      ) : null}
                    </small>
                  </span>
                  <span className="literature-ocr-option-state">
                    {option.id === "fast"
                      ? "内置"
                      : downloading
                        ? `${ocrDownloadPercent}%`
                        : statusItem?.installed
                          ? "已下载"
                          : "需下载"}
                  </span>
                </button>
              );
            })}
          </div>
          {ocrModeBusy ? (
            <div className="literature-ocr-progress" aria-live="polite">
              <div>
                <span>{ocrDownload?.model || "正在建立下载连接"}</span>
                <strong>{ocrDownloadPercent}%</strong>
              </div>
              <span className="ocr-download-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ocrDownloadPercent}>
                <span className="ocr-download-progress-fill" style={{ width: `${ocrDownloadPercent}%` }} />
              </span>
            </div>
          ) : null}
          {ocrModeError ? <p className="literature-ocr-error">{ocrModeError}</p> : null}
        </div>
      ) : null}
    </div>
  );

  const allBlocks = useMemo(
    () => pages.flatMap((p) => p.blocks),
    [pages],
  );

  const patchPage = useCallback(
    (pageId: string, patch: Partial<OcrPage> | ((p: OcrPage) => OcrPage)) => {
      setPages((prev) => {
        const next = prev.map((p) => {
          if (p.id !== pageId) return p;
          return typeof patch === "function" ? patch(p) : { ...p, ...patch };
        });
        pagesRef.current = next;
        return next;
      });
    },
    [],
  );

  const ensureTesseractWorker = useCallback(async () => {
    if (workerRef.current && workerLangRef.current === ocrLang) {
      return workerRef.current;
    }
    const createId = ++workerCreateGenRef.current;
    if (workerRef.current) {
      try {
        await workerRef.current.terminate();
      } catch {
        /* ignore */
      }
      workerRef.current = null;
      workerLangRef.current = null;
    }
    const worker = await withTimeout(
      createWorker(ocrLang),
      120_000,
      `加载「${ocrLang}」识别模型超时（首次需联网下载）。请检查网络后重试，或到设置改回英语再试。`,
    );
    if (createId !== workerCreateGenRef.current) {
      try {
        await worker.terminate();
      } catch {
        /* ignore */
      }
      throw new Error("识别已取消");
    }
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: "1",
    });
    workerRef.current = worker;
    workerLangRef.current = ocrLang;
    return worker;
  }, [ocrLang]);

  useEffect(() => {
    if (workerRef.current && workerLangRef.current !== ocrLang) {
      workerCreateGenRef.current += 1;
      void workerRef.current.terminate();
      workerRef.current = null;
      workerLangRef.current = null;
    }
  }, [ocrLang]);

  const selectBlock = useCallback(
    (id: string, field: OcrSelectionField) => {
      const page = pagesRef.current.find((p) =>
        p.blocks.some((b) => b.id === id),
      );
      setSelectedBlockId(id);
      setSelectedField(field);
      setSelectionPulse((value) => value + 1);
      if (page) setSelectedPageId(page.id);
    },
    [],
  );

  const selectPage = useCallback((pageId: string) => {
    setSelectedPageId(pageId);
    setSelectedBlockId(null);
    setSelectedField(null);
  }, []);

  useEffect(() => {
    if (!selectedPageId && !selectedBlockId) return;
    const scrollBoth = () => {
      if (selectedBlockId) {
        const id = selectedBlockId;
        const srcItem = srcListRef.current?.querySelector(
          `[data-row-id="${id}"]`,
        ) as HTMLElement | null;
        const dstItem = dstListRef.current?.querySelector(
          `[data-row-id="${id}"]`,
        ) as HTMLElement | null;
        srcItem?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        dstItem?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        const box = canvasWrapRef.current?.querySelector(
          `[data-block-id="${id}"]`,
        ) as HTMLElement | null;
        box?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }
      if (selectedPageId) {
        const first = pagesRef.current.find((p) => p.id === selectedPageId)
          ?.blocks[0];
        if (first) {
          const srcItem = srcListRef.current?.querySelector(
            `[data-row-id="${first.id}"]`,
          ) as HTMLElement | null;
          const dstItem = dstListRef.current?.querySelector(
            `[data-row-id="${first.id}"]`,
          ) as HTMLElement | null;
          srcItem?.scrollIntoView({ block: "nearest", behavior: "smooth" });
          dstItem?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
        const card = canvasWrapRef.current?.querySelector(
          `[data-page-id="${selectedPageId}"]`,
        ) as HTMLElement | null;
        card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(scrollBoth));
  }, [selectedBlockId, selectedPageId]);

  useEffect(() => {
    if (!selectedBlockId || !selectedField || selectionPulse === 0) return;
    const escapedId = CSS.escape(selectedBlockId);
    const targets = [
      canvasWrapRef.current?.querySelector(
        `[data-block-id="${escapedId}"]`,
      ) as HTMLElement | null,
      srcListRef.current?.querySelector(
        `[data-row-id="${escapedId}"][data-field="source"]`,
      ) as HTMLElement | null,
      dstListRef.current?.querySelector(
        `[data-row-id="${escapedId}"][data-field="translation"]`,
      ) as HTMLElement | null,
    ].filter((element): element is HTMLElement => element !== null);
    // Let smooth scrolling reveal both paired rows before the stronger pulse.
    const startTimer = window.setTimeout(() => {
      targets.forEach((element) => {
        element.classList.remove("is-flashing");
        void element.offsetWidth;
        element.classList.add("is-flashing");
      });
    }, 260);
    const endTimer = window.setTimeout(() => {
      targets.forEach((element) => element.classList.remove("is-flashing"));
    }, 1660);
    return () => {
      window.clearTimeout(startTimer);
      window.clearTimeout(endTimer);
    };
  }, [selectedBlockId, selectedField, selectionPulse]);

  const translateOpts = useMemo(
    () => ({
      source: translateSource || "auto",
      target: translateTarget,
      provider: translateProvider,
      maxLength: translateMaxLength,
      autoChunk: translateAutoChunk,
      feature: "ocr" as const,
      ...(translateProvider === "llm" ? { apiUrl, apiKey, model } : {}),
    }),
    [
      apiKey,
      apiUrl,
      model,
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
      pageId: string,
      list: OcrBlock[],
      onProgress?: (done: number, total: number) => void,
    ) => {
      const gen = ++translateGenRef.current;
      const workIdx = list
        .map((b, i) => (b.text.trim() && !isLiteralOcrToken(b.text) ? i : -1))
        .filter((i) => i >= 0);
      if (!workIdx.length) {
        return list.map((block) => ({
          ...block,
          translation: block.text.trim(),
          status: "done" as const,
        }));
      }

      const pending: OcrBlock[] = list.map((b) =>
        b.text.trim() && !isLiteralOcrToken(b.text)
          ? { ...b, status: "pending", translation: "" }
          : { ...b, status: "done", translation: b.text.trim() },
      );
      patchPage(pageId, { blocks: pending });

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
          if (!pagesRef.current.some((p) => p.id === pageId)) return list;
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
        b.text.trim() && !isLiteralOcrToken(b.text)
          ? { ...b, status: "pending", translation: "" }
          : { ...b, status: "done", translation: b.text.trim() },
      );
      patchPage(pageId, { blocks: [...next] });
      const concurrency = translateProvider === "llm" ? 5 : 2;
      let done = 0;
      for (let start = 0; start < workIdx.length; start += concurrency) {
        if (gen !== translateGenRef.current) return next;
        if (!pagesRef.current.some((p) => p.id === pageId)) return next;
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
              if (
                gen === translateGenRef.current &&
                pagesRef.current.some((p) => p.id === pageId)
              ) {
                patchPage(pageId, { blocks: [...next] });
              }
            }
          }),
        );
      }
      return next;
    },
    [patchPage, translateOpts, translateProvider],
  );

  const runOcrForPage = useCallback(
    async (pageId: string, file: File) => {
      if (!pagesRef.current.some((p) => p.id === pageId)) return;
      patchPage(pageId, {
        busy: true,
        error: null,
        statusText: "正在加载本地 PaddleOCR 识别模型…",
      });
      setStatus("正在加载本地 PaddleOCR 识别模型…");
      setError(null);
      try {
        const page = pagesRef.current.find((p) => p.id === pageId);
        if (!page) return;
        const { w: iw, h: ih } = await loadImageSize(page.imageUrl);
        if (!pagesRef.current.some((p) => p.id === pageId)) return;

        const toBox = (raw: {
          text: string;
          confidence?: number;
          bbox: { x0: number; y0: number; x1: number; y1: number };
        }): BBoxLine | null => {
          const text = (raw.text || "").trim().replace(/\s+/g, " ");
          if (!text || isJunkText(text)) return null;
          const conf = raw.confidence ?? 0;
          const shortLabel =
            text.length <= 16 && /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(text);
          const minConf = looksLikeCode(text) ? 18 : shortLabel ? 0 : 28;
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

        const boxesFromPage = (data: {
          lines?: Array<{
            text: string;
            confidence?: number;
            bbox: { x0: number; y0: number; x1: number; y1: number };
          }>;
          paragraphs?: Array<{
            text: string;
            confidence?: number;
            bbox: { x0: number; y0: number; x1: number; y1: number };
          }>;
          words?: Array<{
            text: string;
            confidence?: number;
            bbox: { x0: number; y0: number; x1: number; y1: number };
          }>;
        }): BBoxLine[] => {
          const linesRaw = (data.lines ?? [])
            .map((l) => toBox(l))
            .filter((x): x is BBoxLine => !!x);
          const wordsRaw = (data.words ?? [])
            .map((w) => toBox(w))
            .filter((x): x is BBoxLine => !!x);
          let boxes: BBoxLine[] = [];
          if (linesRaw.length) {
            boxes = mergeLinesToParagraphs(linesRaw);
          } else {
            const parasRaw = (data.paragraphs ?? [])
              .map((p) => toBox(p))
              .filter((x): x is BBoxLine => !!x);
            boxes = parasRaw.length
              ? parasRaw
              : mergeLinesToParagraphs(mergeWordsToLines(wordsRaw));
          }
          boxes = mergeOrphanLines(boxes, linesRaw);
          boxes = mergeOrphanLines(boxes, wordsRaw);
          return boxes;
        };

        let lineBoxes: BBoxLine[];
        let recognitionEngine = `PaddleOCR ${OCR_MODE_LABELS[normalizedOcrMode]}`;
        try {
          const loadingText =
            normalizedOcrMode === "fast"
              ? "正在加载本地 PP-OCRv6 快速模型…"
              : `正在准备 PaddleOCR ${OCR_MODE_LABELS[normalizedOcrMode]}模型（首次使用会下载并缓存）…`;
          patchPage(pageId, {
            statusText: loadingText,
          });
          setStatus(loadingText);
          const paddle =
            paddleOcrRef.current ??
            (paddleOcrRef.current = new LocalPaddleOcr(normalizedOcrMode));
          const result = await withTimeout(
            paddle.recognize(file),
            240_000,
            "PaddleOCR 识别超时，正在准备兼容引擎…",
          );
          if (!pagesRef.current.some((p) => p.id === pageId)) return;
          const rawLines = result.lines
            .map((line: PaddleOcrLine): BBoxLine | null => {
              const text = line.text.trim().replace(/\s+/g, " ");
              if (!text) return null;
              return {
                text,
                x0: line.x0,
                y0: line.y0,
                x1: line.x1,
                y1: line.y1,
                confidence: line.confidence,
                lineH: Math.max(8, line.y1 - line.y0),
              };
            })
            .filter((line): line is BBoxLine => line !== null);
          // PaddleOCR already returns one item per detected text line. Merging
          // again here joined labels (T1/T2) to nearby prose and could cascade
          // several diagram captions into one oversized translation overlay.
          lineBoxes = repairPaddleLines(rawLines);
        } catch (paddleError) {
          console.warn("[OCR] PaddleOCR unavailable; using Tesseract fallback", paddleError);
          recognitionEngine = `兼容引擎（PaddleOCR 不可用：${toFriendlyError(
            paddleError,
            "初始化失败",
          )}）`;
          const fallbackStatus = `PaddleOCR 暂不可用，正在使用${ocrLangLabel}兼容识别…`;
          patchPage(pageId, { statusText: fallbackStatus });
          setStatus(fallbackStatus);
          const worker = await ensureTesseractWorker();
          const result = await withTimeout(
            worker.recognize(file),
            180_000,
            `兼容识别超时（${ocrLangLabel}）。可删除该图后重试，或改用更小图片。`,
          );
          if (!pagesRef.current.some((p) => p.id === pageId)) return;
          lineBoxes = boxesFromPage(result.data);

          try {
            const enhanced = await preprocessImageForOcr(file);
            if (!pagesRef.current.some((p) => p.id === pageId)) return;
            await worker.setParameters({
              tessedit_pageseg_mode: PSM.SPARSE_TEXT,
              preserve_interword_spaces: "1",
            });
            const sparse = await withTimeout(
              worker.recognize(enhanced),
              120_000,
              "补充识别超时",
            );
            if (!pagesRef.current.some((p) => p.id === pageId)) return;
            lineBoxes = mergeOrphanLines(lineBoxes, boxesFromPage(sparse.data));
            const sparseWords = (sparse.data.words ?? [])
              .map((w) => toBox(w))
              .filter((x): x is BBoxLine => !!x);
            lineBoxes = mergeOrphanLines(lineBoxes, sparseWords);
          } catch {
            // ignore supplemental pass
          } finally {
            try {
              await worker.setParameters({
                tessedit_pageseg_mode: PSM.AUTO,
                preserve_interword_spaces: "1",
              });
            } catch {
              // ignore
            }
          }
        }

        if (!pagesRef.current.some((p) => p.id === pageId)) return;

        const paras = lineBoxes.filter(
          (p) => !isJunkText(p.text) && p.text.trim().length >= 1,
        );

        let list: OcrBlock[] = paras.map((ln, i) => {
          const x = clamp01(ln.x0 / iw);
          const y = clamp01(ln.y0 / ih);
          const w = clamp01((ln.x1 - ln.x0) / iw);
          const h = clamp01((ln.y1 - ln.y0) / ih);
          return {
            id: `${pageId}-b${i}`,
            pageId,
            text: ln.text,
            translation: "",
            status: "idle" as const,
            x,
            y,
            w: Math.max(w, 0.02),
            h: Math.max(h, 0.012),
          };
        });

        list = list.filter((b) => b.x < 0.98 && b.y < 0.98 && b.w > 0 && b.h > 0);

        patchPage(pageId, {
          blocks: list,
          statusText: `${recognitionEngine} 识别到 ${list.length} 段文字`,
          error: null,
        });
        setStatus(`${recognitionEngine} 识别到 ${list.length} 段文字`);

        if (autoTranslateRef.current && list.length > 0) {
          patchPage(pageId, {
            statusText: `正在翻译 0/${list.length}…`,
          });
          setStatus(`正在翻译 0/${list.length}…`);
          list = await translateBlocks(pageId, list, (done, total) => {
            const msg = `正在翻译 ${done}/${total}…`;
            patchPage(pageId, { statusText: msg });
            setStatus(msg);
          });
          if (!pagesRef.current.some((p) => p.id === pageId)) return;
          const doneMsg = summarizeTranslateStatus(list);
          patchPage(pageId, {
            blocks: list,
            statusText: doneMsg,
            busy: false,
          });
          setStatus(doneMsg);
        } else {
          patchPage(pageId, { busy: false });
        }
      } catch (e) {
        if (!pagesRef.current.some((p) => p.id === pageId)) return;
        const msg = toFriendlyError(e, "识别失败，请重试");
        if (!/识别已取消/.test(msg)) {
          patchPage(pageId, {
            error: msg,
            statusText: null,
            busy: false,
          });
          setError(msg);
          workerCreateGenRef.current += 1;
          try {
            await workerRef.current?.terminate();
          } catch {
            /* ignore */
          }
          workerRef.current = null;
          workerLangRef.current = null;
        } else {
          patchPage(pageId, { busy: false, statusText: null });
        }
        setStatus(null);
      }
    },
    [ensureTesseractWorker, normalizedOcrMode, ocrLangLabel, patchPage, translateBlocks],
  );

  const drainQueue = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    setBusy(true);
    try {
      while (queueRef.current.length) {
        const job = queueRef.current.shift();
        if (!job) break;
        // Prefer pagesRef, but also accept jobs whose page was just enqueued
        // (pagesRef is synced in addImageFiles / patchPage / removePage).
        if (!pagesRef.current.some((p) => p.id === job.pageId)) {
          // Page was deleted while queued — drop.
          continue;
        }
        await runOcrForPage(job.pageId, job.file);
      }
    } catch (e) {
      setError(toFriendlyError(e, "识别队列异常，请重试"));
      setStatus(null);
    } finally {
      drainingRef.current = false;
      const remaining = queueRef.current.length > 0;
      if (remaining) {
        // New jobs arrived while we were finishing — keep draining.
        void drainQueue();
        return;
      }
      const stillBusy = pagesRef.current.some((p) => p.busy);
      setBusy(stillBusy);
      if (!stillBusy) setStatus(null);
    }
  }, [runOcrForPage]);

  const rerunPage = useCallback(
    (pageId: string) => {
      const page = pagesRef.current.find((item) => item.id === pageId);
      if (!page || page.busy) return;

      queueRef.current = queueRef.current.filter((job) => job.pageId !== pageId);
      queueRef.current.push({ pageId, file: page.file });
      patchPage(pageId, {
        blocks: [],
        error: null,
        statusText: "排队等待重新识别…",
        busy: true,
      });
      setSelectedPageId(pageId);
      setSelectedBlockId(null);
      setSelectedField(null);
      setError(null);
      setStatus(`图 ${pagesRef.current.findIndex((item) => item.id === pageId) + 1} 正在重新识别…`);
      setBusy(true);
      void drainQueue();
    },
    [drainQueue, patchPage],
  );

  const addImageFiles = useCallback(
    (files: File[]) => {
      const images = files.filter(looksLikeImageFile);
      if (!images.length) {
        setError("未找到可识别的图片文件");
        return;
      }
      setError(null);
      const created: OcrPage[] = [];
      for (const file of images) {
        const id = newPageId();
        const url = URL.createObjectURL(file);
        const label =
          file.name && !/^clipboard\./i.test(file.name)
            ? file.name
            : "剪贴板图片";
        created.push({
          id,
          imageUrl: url,
          label,
          file,
          blocks: [],
          statusText: "排队等待识别…",
          error: null,
          busy: true,
        });
        queueRef.current.push({ pageId: id, file });
      }
      // Sync pagesRef immediately so drainQueue does not skip brand-new jobs
      // before React commits setPages / the useEffect mirror.
      setPages((prev) => {
        const next = [...prev, ...created];
        pagesRef.current = next;
        return next;
      });
      const last = created[created.length - 1];
      if (last) {
        setSelectedPageId(last.id);
        setSelectedBlockId(null);
        setSelectedField(null);
      }
      window.setTimeout(() => {
        const el = canvasWrapRef.current?.querySelector(
          `[data-page-id="${last?.id}"]`,
        ) as HTMLElement | null;
        el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }, 50);
      void drainQueue();
    },
    [drainQueue],
  );

  // Recover pages stuck on "排队等待识别…" (e.g. older race emptied the queue).
  useEffect(() => {
    let requeued = false;
    for (const p of pages) {
      if (!p.busy) continue;
      if (p.statusText !== "排队等待识别…") continue;
      if (queueRef.current.some((j) => j.pageId === p.id)) continue;
      queueRef.current.push({ pageId: p.id, file: p.file });
      requeued = true;
    }
    if (requeued || (queueRef.current.length > 0 && !drainingRef.current)) {
      void drainQueue();
    }
  }, [pages, drainQueue]);

  const handledIncomingIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!incomingImage) return;
    if (handledIncomingIdRef.current === incomingImage.id) return;
    handledIncomingIdRef.current = incomingImage.id;
    addImageFiles([incomingImage.file]);
    onIncomingHandled?.();
  }, [addImageFiles, incomingImage, onIncomingHandled]);

  const showToast = useCallback((message: string, ok = false) => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast({ message, ok });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3200);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const pasteImageFile = useCallback(
    async (file: File | null, emptyMsg = "剪贴板中没有图片") => {
      if (!file) {
        setError(emptyMsg);
        showToast(emptyMsg, false);
        return false;
      }
      const now = Date.now();
      if (now - pasteLockRef.current < 600) return true;
      pasteLockRef.current = now;
      setCtxMenu(null);
      setError(null);
      addImageFiles([file]);
      return true;
    },
    [addImageFiles, showToast],
  );

  const pasteFromClipboard = useCallback(async () => {
    setStatus("正在读取剪贴板图片…");
    try {
      const picked = await fileFromAnyClipboard();
      const emptyMsg =
        picked.error ||
        "剪贴板中没有图片。请先用 Win+Shift+S 截图，或复制图片后再粘贴。";
      const ok = await pasteImageFile(picked.file, emptyMsg);
      // OCR queue will set its own status; clear the "reading clipboard" hint.
      if (!ok) setStatus(null);
      else setStatus((prev) =>
        prev === "正在读取剪贴板图片…" ? null : prev,
      );
    } catch (e) {
      setError(toFriendlyError(e, "读取剪贴板失败"));
      setStatus(null);
    }
  }, [pasteImageFile]);

  const handleCanvasPaste = useCallback(
    (e: ClipboardEvent | ReactClipboardEvent) => {
      if (!active) return;
      if (isEditablePasteTarget(e.target)) return;
      const fromEvent = fileFromClipboardData(
        "clipboardData" in e ? e.clipboardData : null,
      );
      e.preventDefault();
      e.stopPropagation();
      if (fromEvent) {
        void pasteImageFile(fromEvent);
        return;
      }
      void pasteFromClipboard();
    },
    [active, pasteFromClipboard, pasteImageFile],
  );

  const onPageContextMenu = useCallback(
    (e: ReactMouseEvent, pageId: string) => {
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({ x: e.clientX, y: e.clientY, pageId });
      setSelectedPageId(pageId);
    },
    [],
  );

  useEffect(() => {
    if (!active) return;
    const onContextMenu = (e: MouseEvent) => {
      const wrap = canvasWrapRef.current;
      const t = e.target as Node | null;
      if (!wrap || !t || !wrap.contains(t)) return;
      const el = t as HTMLElement;
      if (el.closest(".ocr-page")) return;
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({ x: e.clientX, y: e.clientY, pageId: null });
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu, true);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onPaste = (e: ClipboardEvent) => handleCanvasPaste(e);
    const onKeyDown = (e: KeyboardEvent) => {
      const isPaste =
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        (e.key.toLowerCase() === "v" || e.code === "KeyV");
      if (!isPaste) return;
      if (isEditablePasteTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      void pasteFromClipboard();
    };
    window.addEventListener("paste", onPaste, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("paste", onPaste, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [active, handleCanvasPaste, pasteFromClipboard]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest(".pdf-ctx-menu")) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const timer = window.setTimeout(() => {
      window.addEventListener("mousedown", onMouseDown, true);
      window.addEventListener("keydown", onKey, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ctxMenu]);

  const removePage = useCallback((pageId: string) => {
    queueRef.current = queueRef.current.filter((j) => j.pageId !== pageId);
    setPages((prev) => {
      const target = prev.find((p) => p.id === pageId);
      if (target) URL.revokeObjectURL(target.imageUrl);
      const next = prev.filter((p) => p.id !== pageId);
      pagesRef.current = next;
      return next;
    });
    setSelectedPageId((cur) => (cur === pageId ? null : cur));
    setSelectedBlockId((cur) => {
      if (!cur) return cur;
      return cur.startsWith(`${pageId}-`) ? null : cur;
    });
    if (selectedBlockId?.startsWith(`${pageId}-`)) setSelectedField(null);
    setCtxMenu(null);
  }, [selectedBlockId]);

  const onRetranslateAll = async () => {
    const targets = pages.filter((p) => p.blocks.length > 0);
    if (!targets.length) return;
    setBusy(true);
    setError(null);
    let donePages = 0;
    try {
      for (const page of targets) {
        setStatus(
          `正在重新翻译 图${pages.findIndex((p) => p.id === page.id) + 1}（${donePages + 1}/${targets.length}）…`,
        );
        patchPage(page.id, { busy: true });
        const list = await translateBlocks(
          page.id,
          page.blocks,
          (done, total) => {
            setStatus(
              `正在重新翻译 图${pages.findIndex((p) => p.id === page.id) + 1} ${done}/${total}…`,
            );
            patchPage(page.id, {
              statusText: `正在翻译 ${done}/${total}…`,
            });
          },
        );
        patchPage(page.id, {
          blocks: list,
          statusText: summarizeTranslateStatus(list),
          busy: false,
        });
        donePages += 1;
      }
      setStatus(`已重新翻译 ${targets.length} 张图片`);
    } catch (e) {
      setError(toFriendlyError(e, "翻译失败，请稍后重试"));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const clearAll = useCallback(() => {
    const hasContent =
      pages.length > 0 ||
      !!error ||
      !!status ||
      busy ||
      !!srcQuery ||
      !!dstQuery;
    if (!hasContent) return;
    if (
      !window.confirm("清除全部图片、识别结果与译文？此操作不可撤销。")
    ) {
      return;
    }
    sessionGenRef.current += 1;
    translateGenRef.current += 1;
    workerCreateGenRef.current += 1;
    pasteLockRef.current = 0;
    queueRef.current = [];
    drainingRef.current = false;
    void paddleOcrRef.current?.dispose();
    paddleOcrRef.current = null;
    void workerRef.current?.terminate();
    workerRef.current = null;
    workerLangRef.current = null;
    if (inputRef.current) inputRef.current.value = "";
    for (const p of pagesRef.current) {
      URL.revokeObjectURL(p.imageUrl);
    }
    pagesRef.current = [];
    setPages([]);
    setSelectedPageId(null);
    setSelectedBlockId(null);
    setSelectedField(null);
    setBusy(false);
    setStatus(null);
    setError(null);
    setSrcQuery("");
    setDstQuery("");
    setCopiedId(null);
    setCtxMenu(null);
    setToast(null);
    onIncomingHandled?.();
  }, [busy, dstQuery, error, onIncomingHandled, pages.length, srcQuery, status]);

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
    if (!q) return allBlocks;
    return allBlocks.filter((b) => b.text.toLowerCase().includes(q));
  }, [allBlocks, srcQuery]);

  const dstFiltered = useMemo(() => {
    const q = dstQuery.trim().toLowerCase();
    if (!q) return allBlocks;
    return allBlocks.filter(
      (b) =>
        b.translation.toLowerCase().includes(q) ||
        (b.status === "pending" && "正在翻译".includes(q)),
    );
  }, [allBlocks, dstQuery]);

  const blockIndex = useMemo(() => {
    const m = new Map<string, number>();
    allBlocks.forEach((b, i) => m.set(b.id, i + 1));
    return m;
  }, [allBlocks]);

  const pageIndex = useMemo(() => {
    const m = new Map<string, number>();
    pages.forEach((p, i) => m.set(p.id, i + 1));
    return m;
  }, [pages]);

  const rowClass = (b: OcrBlock, field: OcrSelectionField) => {
    const isBlock = b.id === selectedBlockId;
    const isPage =
      !selectedBlockId && !!selectedPageId && b.pageId === selectedPageId;
    if (isBlock) {
      return `ocr-pair-row active${selectedField === field ? " primary" : " paired"}`;
    }
    if (isPage) return "ocr-pair-row page-active";
    return "ocr-pair-row";
  };

  return (
    <div className="ocr-layout">
      {toast && (
        <div
          className={
            "settings-toast ocr-toast" + (toast.ok ? " is-ok" : " is-fail")
          }
          role="status"
        >
          {toast.message}
        </div>
      )}
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
            multiple
            hidden
            onChange={(e) => {
              const list = e.target.files ? Array.from(e.target.files) : [];
              if (list.length) addImageFiles(list);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="pdf-tool-btn"
            disabled={busy || !allBlocks.length}
            onClick={() => void onRetranslateAll()}
          >
            重新翻译全部
          </button>
          <button
            type="button"
            className="pdf-tool-btn"
            disabled={
              !pages.length &&
              !error &&
              !status &&
              !busy &&
              !srcQuery &&
              !dstQuery
            }
            title="清除全部图片与识别/翻译结果"
            onClick={() => clearAll()}
          >
            清除全部
          </button>
          <label className="ocr-toggle">
            <input
              type="checkbox"
              checked={showTranslation}
              onChange={(e) => setShowTranslation(e.target.checked)}
            />
            显示译文叠字
          </label>
          <div className="toolbar-language-pair" aria-label="图片翻译语言">
            <LangCombobox
              label="源语言"
              value={translateSource}
              onChange={(code) => onTranslateSourceChange?.(code)}
              onSaved={() => showToast("保存成功", true)}
              compact
            />
            <span className="toolbar-language-arrow" aria-hidden>
              →
            </span>
            <LangCombobox
              label="目标语言"
              value={translateTarget}
              onChange={(code) => onTranslateTargetChange?.(code)}
              onSaved={() => showToast("保存成功", true)}
              allowAuto={false}
              compact
            />
          </div>
          {status && <span className="hint">{status}</span>}
          <span className="ocr-toolbar-engine" title={engineBadge}>
            {engineBadge}
          </span>
          {ocrModeMenu}
        </div>

        <div
          className={
            "ocr-canvas-wrap" + (dragOver ? " is-dragover" : "")
          }
          ref={canvasWrapRef}
          tabIndex={0}
          onMouseDown={() => {
            canvasWrapRef.current?.focus();
          }}
          onPaste={handleCanvasPaste}
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            if (e.currentTarget === e.target) setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOver(false);
            const files = filesFromDataTransfer(e.dataTransfer);
            if (files.length) addImageFiles(files);
            else {
              setError("拖入的内容不是图片");
              showToast("拖入的内容不是图片", false);
            }
          }}
        >
          {pages.length === 0 ? (
            <div className="pdf-empty ocr-empty">
              <p>
                打开、粘贴或拖入图片后将追加到下方列表并识别，叠字显示译文。
              </p>
              <p className="hint">
                可在此灰色背景处按 Ctrl+V，拖拽图片，或右键选择「从剪贴板粘贴图片」。
              </p>
              <div className="ocr-empty-actions">
                <button
                  type="button"
                  className="send-btn"
                  onClick={() => inputRef.current?.click()}
                >
                  选择图片
                </button>
                <button
                  type="button"
                  className="send-btn ocr-paste-btn"
                  onClick={() => void pasteFromClipboard()}
                >
                  从剪贴板粘贴图片
                </button>
              </div>
            </div>
          ) : (
            <div className="ocr-pages">
              {pages.map((page, index) => (
                <OcrPageCard
                  key={page.id}
                  page={page}
                  index={index}
                  selected={selectedPageId === page.id}
                  selectedBlockId={selectedBlockId}
                  selectedField={selectedField}
                  showTranslation={showTranslation}
                  onSelectPage={() => selectPage(page.id)}
                  onSelectBlock={selectBlock}
                  onRerun={() => rerunPage(page.id)}
                  onContextMenu={onPageContextMenu}
                />
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
                    data-field="source"
                    className={rowClass(b, "source")}
                    onClick={() => selectBlock(b.id, "source")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectBlock(b.id, "source");
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <span className="ocr-block-idx">
                      图{pageIndex.get(b.pageId) ?? "?"} #{blockIndex.get(b.id) ?? "?"}
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
                      data-field="translation"
                      className={rowClass(b, "translation")}
                      onClick={() => selectBlock(b.id, "translation")}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          selectBlock(b.id, "translation");
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <span className="ocr-block-idx">
                        图{pageIndex.get(b.pageId) ?? "?"} #{blockIndex.get(b.id) ?? "?"}
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

      {ctxMenu &&
        createPortal(
          <div
            className="pdf-ctx-menu ocr-ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            role="menu"
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {ctxMenu.pageId && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const id = ctxMenu.pageId;
                  setCtxMenu(null);
                  if (id) removePage(id);
                }}
              >
                删除当前图片
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setCtxMenu(null);
                void pasteFromClipboard();
              }}
            >
              从剪贴板粘贴图片
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setCtxMenu(null);
                inputRef.current?.click();
              }}
            >
              打开图片
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!pages.length && !error && !status && !busy}
              onClick={() => {
                setCtxMenu(null);
                clearAll();
              }}
            >
              清除全部
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
