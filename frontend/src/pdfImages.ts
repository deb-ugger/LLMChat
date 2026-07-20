import { OPS, Util, type PDFPageProxy } from "pdfjs-dist";

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

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function bboxFromUnitSquare(ctm: Mat): {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
} {
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

/** Collect painted image bboxes (PDF user space) for a page. */
export async function collectPageImageRects(
  page: PDFPageProxy,
): Promise<{ xMin: number; yMin: number; xMax: number; yMax: number }[]> {
  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;
  const stack: Mat[] = [];
  let ctm: Mat = IDENTITY;
  const rects: { xMin: number; yMin: number; xMax: number; yMax: number }[] =
    [];

  const pushImage = () => {
    const box = bboxFromUnitSquare(ctm);
    const w = box.xMax - box.xMin;
    const h = box.yMax - box.yMin;
    // Skip tiny decorative glyphs / icons (< 12pt)
    if (w < 12 || h < 12) return;
    rects.push(box);
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
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintSolidColorImageMask:
        pushImage();
        break;
      case OPS.paintImageXObjectRepeat:
      case OPS.paintImageMaskXObjectRepeat:
      case OPS.paintInlineImageXObjectGroup:
      case OPS.paintImageMaskXObjectGroup:
        pushImage();
        break;
      default:
        break;
    }
  }
  return rects;
}

function pdfRectToCss(
  page: PDFPageProxy,
  pdfRect: { xMin: number; yMin: number; xMax: number; yMax: number },
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

async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("导出图片失败"))),
      "image/png",
    );
  });
}

/** Crop image region from the rendered page canvas. */
export async function cropImageFromPageCanvas(
  pageCanvas: HTMLCanvasElement,
  cssRect: { left: number; top: number; width: number; height: number },
): Promise<Blob> {
  const scaleX = pageCanvas.width / pageCanvas.clientWidth;
  const scaleY = pageCanvas.height / pageCanvas.clientHeight;
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
  if (!canvas) return null;

  const pageRect = pageEl.getBoundingClientRect();
  const cssX = clientX - pageRect.left;
  const cssY = clientY - pageRect.top;
  const cssScale = pageRect.width / page.getViewport({ scale: 1 }).width;

  const rects = await collectPageImageRects(page);
  let best: {
    pdfRect: (typeof rects)[0];
    cssRect: { left: number; top: number; width: number; height: number };
    area: number;
  } | null = null;

  for (const pdfRect of rects) {
    const cssRect = pdfRectToCss(page, pdfRect, cssScale);
    if (
      cssX >= cssRect.left &&
      cssX <= cssRect.left + cssRect.width &&
      cssY >= cssRect.top &&
      cssY <= cssRect.top + cssRect.height
    ) {
      const area = cssRect.width * cssRect.height;
      if (!best || area < best.area) {
        best = { pdfRect, cssRect, area };
      }
    }
  }
  if (!best) return null;

  const blob = await cropImageFromPageCanvas(canvas, best.cssRect);
  const objectUrl = URL.createObjectURL(blob);
  return {
    pageNumber,
    pdfRect: best.pdfRect,
    cssRect: best.cssRect,
    blob,
    objectUrl,
  };
}

export async function copyImageBlob(blob: Blob): Promise<void> {
  if (navigator.clipboard && "write" in navigator.clipboard) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type || "image/png"]: blob }),
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
    reader.readAsDataURL(blob);
  });
  await navigator.clipboard.writeText(dataUrl);
}

export function downloadImageBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
