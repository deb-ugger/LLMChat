import { ImageKind, OPS, Util, type PDFPageProxy } from "pdfjs-dist";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

export type PdfImageHit = {
  pageNumber: number;
  /** PDF user-space axis-aligned bbox */
  pdfRect: { xMin: number; yMin: number; xMax: number; yMax: number };
  /** CSS pixels relative to the page `.canvasWrapper` / page canvas */
  cssRect: { left: number; top: number; width: number; height: number };
  blob: Blob;
  objectUrl: string;
};

type Mat = [number, number, number, number, number, number];

type PdfRect = { xMin: number; yMin: number; xMax: number; yMax: number };

type CollectedImage = {
  pdfRect: PdfRect;
  /** XObject name for paintImageXObject*; null → need render fallback */
  objId: string | null;
  /** Inline image payload embedded in the operator args */
  inlineData?: PdfJsImageData | null;
};

type PdfJsImageData = {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8ClampedArray | Uint8Array | null;
  /** pdf.js OffscreenCanvas path: native pixels as ImageBitmap */
  bitmap?: ImageBitmap | HTMLCanvasElement | HTMLImageElement | OffscreenCanvas | null;
};

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function bboxFromUnitSquare(ctm: Mat): PdfRect {
  const pts = [
    Util.applyTransform([0, 0], ctm),
    Util.applyTransform([1, 0], ctm),
    Util.applyTransform([1, 1], ctm),
    Util.applyTransform([0, 1], ctm),
  ];
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const [x, y] of pts) {
    xMin = Math.min(xMin, x);
    yMin = Math.min(yMin, y);
    xMax = Math.max(xMax, x);
    yMax = Math.max(yMax, y);
  }
  return { xMin, yMin, xMax, yMax };
}

/** Collect painted image bboxes (+ optional XObject id) for a page. */
export async function collectPageImages(
  page: PDFPageProxy,
): Promise<CollectedImage[]> {
  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;
  const stack: Mat[] = [];
  let ctm: Mat = IDENTITY;
  const images: CollectedImage[] = [];

  const pushImage = (
    objId: string | null,
    inlineData: PdfJsImageData | null = null,
  ) => {
    const box = bboxFromUnitSquare(ctm);
    const w = box.xMax - box.xMin;
    const h = box.yMax - box.yMin;
    // Skip tiny decorative glyphs / icons (< 12pt)
    if (w < 12 || h < 12) return;
    images.push({ pdfRect: box, objId, inlineData });
  };

  const asImageData = (v: unknown): PdfJsImageData | null => {
    if (!v || typeof v !== "object") return null;
    const img = v as PdfJsImageData;
    if (!img.width || !img.height) return null;
    if (img.bitmap || img.data) return img;
    return null;
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case OPS.transform: {
        const m = args as unknown as Mat;
        ctm = Util.transform(ctm, m) as Mat;
        break;
      }
      case OPS.paintImageXObject:
      case OPS.paintImageMaskXObject: {
        const id = typeof args[0] === "string" ? args[0] : null;
        pushImage(id);
        break;
      }
      case OPS.paintImageXObjectRepeat:
      case OPS.paintImageMaskXObjectRepeat: {
        const id = typeof args[0] === "string" ? args[0] : null;
        pushImage(id);
        break;
      }
      case OPS.paintInlineImageXObject: {
        pushImage(null, asImageData(args[0]));
        break;
      }
      case OPS.paintSolidColorImageMask:
      case OPS.paintInlineImageXObjectGroup:
      case OPS.paintImageMaskXObjectGroup:
        pushImage(null);
        break;
      default:
        break;
    }
  }
  return images;
}

/** @deprecated use collectPageImages */
export async function collectPageImageRects(
  page: PDFPageProxy,
): Promise<PdfRect[]> {
  return (await collectPageImages(page)).map((i) => i.pdfRect);
}

function pdfRectToCss(
  page: PDFPageProxy,
  pdfRect: PdfRect,
  cssScale: number,
): { left: number; top: number; width: number; height: number } {
  const viewport = page.getViewport({ scale: cssScale });
  const [x1, y1] = viewport.convertToViewportPoint(pdfRect.xMin, pdfRect.yMin);
  const [x2, y2] = viewport.convertToViewportPoint(pdfRect.xMax, pdfRect.yMax);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  return { left, top, width, height };
}

/** CSS rects of selectable images on a page (relative to `.page`). */
export async function listPageImageCssRects(
  page: PDFPageProxy,
  pageEl: HTMLElement,
): Promise<Array<{ left: number; top: number; width: number; height: number }>> {
  const pageRect = pageEl.getBoundingClientRect();
  const cssScale = pageRect.width / page.getViewport({ scale: 1 }).width;
  const images = await collectPageImages(page);
  return images.map((img) => pdfRectToCss(page, img.pdfRect, cssScale));
}

/**
 * Mount/update transparent hit targets so the cursor becomes a hand over images.
 * Safe to call after each `pagerendered`.
 */
export async function syncPageImageHotspots(
  page: PDFPageProxy,
  pageEl: HTMLElement,
): Promise<void> {
  const rects = await listPageImageCssRects(page, pageEl);
  let layer = pageEl.querySelector(
    ":scope > .pdf-image-hotspots",
  ) as HTMLDivElement | null;
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "pdf-image-hotspots";
    layer.setAttribute("aria-hidden", "true");
    pageEl.appendChild(layer);
  }
  layer.replaceChildren();
  for (const r of rects) {
    if (r.width < 4 || r.height < 4) continue;
    const spot = document.createElement("div");
    spot.className = "pdf-image-hotspot";
    spot.title = "双击查看图片";
    spot.style.left = `${r.left}px`;
    spot.style.top = `${r.top}px`;
    spot.style.width = `${r.width}px`;
    spot.style.height = `${r.height}px`;
    layer.appendChild(spot);
  }
}

export function clearPageImageHotspots(root: ParentNode): void {
  root.querySelectorAll(".pdf-image-hotspots").forEach((el) => el.remove());
}

async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("导出图片失败"))),
      "image/png",
    );
  });
}

type PdfObjectStore = {
  has: (objId: string) => boolean;
  get: (objId: string, callback?: (data: unknown) => void) => unknown;
};

function peekResolvedImage(
  store: PdfObjectStore,
  objId: string,
): PdfJsImageData | null {
  try {
    if (!store.has(objId)) return null;
    const data = store.get(objId) as PdfJsImageData | null | undefined;
    if (!data?.width || !data?.height) return null;
    if (data.bitmap || data.data) return data;
    return null;
  } catch {
    return null;
  }
}

function waitStoreObject(
  store: PdfObjectStore,
  objId: string,
  timeoutMs: number,
): Promise<PdfJsImageData | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (data: PdfJsImageData | null) => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    const done = (raw: unknown) => {
      window.clearTimeout(timer);
      const img = raw as PdfJsImageData | null;
      if (img?.width && img?.height && (img.bitmap || img.data)) {
        finish(img);
      } else {
        finish(null);
      }
    };
    try {
      const immediate = store.get(objId, done);
      if (immediate != null) done(immediate);
    } catch {
      window.clearTimeout(timer);
      finish(null);
    }
  });
}

/** Prefer page objs, then commonObjs (globally cached / `g_` images). */
function peekPdfImageObject(
  page: PDFPageProxy,
  objId: string,
): PdfJsImageData | null {
  const stores = [page.objs as PdfObjectStore, page.commonObjs as PdfObjectStore];
  for (const store of stores) {
    const peeked = peekResolvedImage(store, objId);
    if (peeked) return peeked;
  }
  return null;
}

async function waitPdfImageObject(
  page: PDFPageProxy,
  objId: string,
  timeoutMs = 2500,
): Promise<PdfJsImageData | null> {
  const peeked = peekPdfImageObject(page, objId);
  if (peeked) return peeked;
  const stores = [page.objs as PdfObjectStore, page.commonObjs as PdfObjectStore];
  return Promise.race([
    waitStoreObject(stores[0], objId, timeoutMs),
    waitStoreObject(stores[1], objId, timeoutMs),
  ]);
}

function rgb24ToRgba(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  const n = width * height;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const o = i * 4;
    out[o] = data[j];
    out[o + 1] = data[j + 1];
    out[o + 2] = data[j + 2];
    out[o + 3] = 255;
  }
  return out;
}

function gray1ToRgba(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bitIndex = y * width + x;
      const byte = data[(bitIndex / 8) | 0] ?? 0;
      const bit = (byte >> (7 - (bitIndex & 7))) & 1;
      const v = bit ? 0 : 255;
      const o = bitIndex * 4;
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  return out;
}

async function pdfJsImageToPngBlob(img: PdfJsImageData): Promise<Blob> {
  const { width, height } = img;
  if (!width || !height) {
    throw new Error("无效的 PDF 图片数据");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");

  // Native path in Chromium/WebView2: pdf.js transfers ImageBitmap at full res.
  if (img.bitmap) {
    ctx.drawImage(img.bitmap as CanvasImageSource, 0, 0);
    return canvasToPngBlob(canvas);
  }

  if (!img.data) {
    throw new Error("无效的 PDF 图片数据");
  }
  const kind = img.kind ?? 0;
  let rgba: Uint8ClampedArray;
  if (kind === ImageKind.RGBA_32BPP) {
    rgba =
      img.data instanceof Uint8ClampedArray
        ? img.data
        : new Uint8ClampedArray(img.data);
  } else if (kind === ImageKind.RGB_24BPP) {
    rgba = rgb24ToRgba(img.data, width, height);
  } else if (kind === ImageKind.GRAYSCALE_1BPP) {
    rgba = gray1ToRgba(img.data, width, height);
  } else {
    throw new Error(`不支持的图片格式: ${kind}`);
  }
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvasToPngBlob(canvas);
}

/** Crop image region from a rendered page canvas (display resolution). */
export async function cropImageFromPageCanvas(
  pageCanvas: HTMLCanvasElement,
  cssRect: { left: number; top: number; width: number; height: number },
): Promise<Blob> {
  const scaleX = pageCanvas.width / Math.max(1, pageCanvas.clientWidth);
  const scaleY = pageCanvas.height / Math.max(1, pageCanvas.clientHeight);
  const sx = Math.max(0, Math.floor(cssRect.left * scaleX));
  const sy = Math.max(0, Math.floor(cssRect.top * scaleY));
  const sw = Math.max(
    1,
    Math.min(pageCanvas.width - sx, Math.ceil(cssRect.width * scaleX)),
  );
  const sh = Math.max(
    1,
    Math.min(pageCanvas.height - sy, Math.ceil(cssRect.height * scaleY)),
  );
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  ctx.drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvasToPngBlob(out);
}

/**
 * Re-render the page at higher scale and crop the PDF rect — sharper than
 * screen-canvas crop when XObject extraction is unavailable.
 */
async function cropImageHiRes(
  page: PDFPageProxy,
  pdfRect: PdfRect,
): Promise<Blob> {
  const pdfW = Math.max(1, pdfRect.xMax - pdfRect.xMin);
  const pdfH = Math.max(1, pdfRect.yMax - pdfRect.yMin);
  // Aim for ~1600px on the longer edge, capped to keep memory reasonable.
  const scale = Math.min(4, Math.max(2, 1600 / Math.max(pdfW, pdfH)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("无法创建画布");
  const task = page.render({
    canvasContext: ctx,
    viewport,
  });
  await task.promise;

  const [x1, y1] = viewport.convertToViewportPoint(pdfRect.xMin, pdfRect.yMin);
  const [x2, y2] = viewport.convertToViewportPoint(pdfRect.xMax, pdfRect.yMax);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  return cropImageFromPageCanvas(canvas, {
    left,
    top,
    width,
    height,
  });
}

async function extractImageBlob(
  page: PDFPageProxy,
  collected: CollectedImage,
  pageCanvas: HTMLCanvasElement | null,
  cssRect: { left: number; top: number; width: number; height: number },
): Promise<Blob> {
  // 1) Prefer original PDF pixels (XObject / inline), never screen-scale crop first.
  if (collected.inlineData) {
    try {
      return await pdfJsImageToPngBlob(collected.inlineData);
    } catch {
      /* fall through */
    }
  }
  if (collected.objId) {
    try {
      let img = peekPdfImageObject(page, collected.objId);
      // After page.cleanup(), objs may be empty — re-pump operator list to reload.
      if (!img) {
        await page.getOperatorList();
        img = peekPdfImageObject(page, collected.objId);
      }
      if (!img) {
        img = await waitPdfImageObject(page, collected.objId);
      }
      if (img) {
        return await pdfJsImageToPngBlob(img);
      }
    } catch {
      /* fall through */
    }
  }
  // 2) Hi-res re-render crop (still better than display canvas).
  try {
    return await cropImageHiRes(page, collected.pdfRect);
  } catch {
    // 3) Last resort: visible page canvas.
    if (pageCanvas) return cropImageFromPageCanvas(pageCanvas, cssRect);
    throw new Error("导出图片失败");
  }
}

export async function findImageAtPoint(
  page: PDFPageProxy,
  pageNumber: number,
  pageEl: HTMLElement,
  clientX: number,
  clientY: number,
): Promise<PdfImageHit | null> {
  const canvas =
    (pageEl.querySelector(".canvasWrapper canvas") as HTMLCanvasElement | null) ||
    (pageEl.querySelector("canvas") as HTMLCanvasElement | null);

  const pageRect = pageEl.getBoundingClientRect();
  const cssX = clientX - pageRect.left;
  const cssY = clientY - pageRect.top;
  const cssScale = pageRect.width / page.getViewport({ scale: 1 }).width;

  const images = await collectPageImages(page);
  let best: {
    collected: CollectedImage;
    cssRect: { left: number; top: number; width: number; height: number };
    area: number;
  } | null = null;

  for (const collected of images) {
    const cssRect = pdfRectToCss(page, collected.pdfRect, cssScale);
    if (
      cssX >= cssRect.left &&
      cssX <= cssRect.left + cssRect.width &&
      cssY >= cssRect.top &&
      cssY <= cssRect.top + cssRect.height
    ) {
      const area = cssRect.width * cssRect.height;
      if (!best || area < best.area) {
        best = { collected, cssRect, area };
      }
    }
  }
  if (!best) return null;

  const blob = await extractImageBlob(
    page,
    best.collected,
    canvas,
    best.cssRect,
  );
  const objectUrl = URL.createObjectURL(blob);
  return {
    pageNumber,
    pdfRect: best.collected.pdfRect,
    cssRect: best.cssRect,
    blob,
    objectUrl,
  };
}

export async function copyImageBlob(blob: Blob): Promise<void> {
  const pngBlob =
    blob.type === "image/png"
      ? blob
      : new Blob([await blob.arrayBuffer()], { type: "image/png" });
  if (navigator.clipboard && "write" in navigator.clipboard) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": pngBlob }),
      ]);
      return;
    } catch {
      /* fall through */
    }
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(pngBlob);
  });
  await navigator.clipboard.writeText(dataUrl);
}

/** Prefer native Save dialog (Tauri); fall back to anchor download. */
export async function saveImageBlob(
  blob: Blob,
  fileName: string,
): Promise<void> {
  try {
    const path = await save({
      defaultPath: fileName,
      filters: [{ name: "PNG 图片", extensions: ["png"] }],
    });
    if (!path) return;
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    await invoke("write_file_bytes", { path, contents: bytes });
    return;
  } catch {
    /* fall through to anchor download */
  }
  downloadImageBlob(blob, fileName);
}

export function downloadImageBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
