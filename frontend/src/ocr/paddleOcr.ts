import type {
  InitializationSummary,
  OcrResultItem,
} from "@paddleocr/paddleocr-js";
import { API_BASE, api, type OcrMode } from "../api";
import { OcrRuntime } from "./runtime";
import { runtimeAssetBase } from "../runtimeAssets";

type ModelPair = {
  detName: string;
  detUrl: string;
  recName: string;
  recUrl: string;
};

function localAssetUrl(path: string): string {
  return new URL(path, runtimeAssetBase()).href;
}

function backendModelUrl(fileName: string): string {
  return `${API_BASE}/api/ocr/model-files/${encodeURIComponent(fileName)}`;
}

export { normalizeOcrMode, OCR_MODE_LABELS } from "./modes";

function modelPair(mode: OcrMode): ModelPair {
  const detName = mode === "fast" ? "PP-OCRv6_small_det" : "PP-OCRv6_medium_det";
  // Manga OCR replaces proposal text, so its Paddle stage uses the bundled recognizer.
  const recName = mode === "precise"
    ? "PP-OCRv6_medium_rec"
    : mode === "english" ? "en_PP-OCRv5_mobile_rec" : "PP-OCRv6_small_rec";
  const assetUrl = (name: string, bundled: boolean) => {
    const file = `${name}_onnx_infer.tar`;
    return bundled ? localAssetUrl(`./ocr/${file}`) : backendModelUrl(file);
  };
  return {
    detName,
    detUrl: assetUrl(detName, mode === "fast"),
    recName,
    recUrl: assetUrl(recName, mode === "fast" || mode === "manga"),
  };
}

export type PaddleOcrLine = {
  text: string;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type PaddleOcrRecognition = {
  lines: PaddleOcrLine[];
  image: { width: number; height: number };
  initialization: InitializationSummary | null;
  elapsedMs: number;
};

type PaddleOcrModule = typeof import("@paddleocr/paddleocr-js");
type PaddleOcrInstance = Awaited<
  ReturnType<PaddleOcrModule["PaddleOCR"]["create"]>
>;

function itemToLine(item: OcrResultItem, coordinateScale = 1): PaddleOcrLine | null {
  const text = item.text.trim().replace(/\s+/g, " ");
  if (!text || item.poly.length === 0) return null;
  const xs = item.poly.map((point) => point[0]);
  const ys = item.poly.map((point) => point[1]);
  const x0 = Math.min(...xs) / coordinateScale;
  const y0 = Math.min(...ys) / coordinateScale;
  const x1 = Math.max(...xs) / coordinateScale;
  const y1 = Math.max(...ys) / coordinateScale;
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) {
    return null;
  }
  return {
    text,
    confidence: Math.max(0, Math.min(100, item.score * 100)),
    x0,
    y0,
    x1,
    y1,
  };
}

/**
 * Small screenshots often contain labels whose glyphs are only 10-15 px high.
 * Upscaling before detection gives the detector enough pixels for subscripts and
 * diagram labels, while returned coordinates are converted back to source size.
 */
async function prepareRecognitionImage(
  image: Blob,
): Promise<{ image: Blob; scale: number }> {
  if (typeof createImageBitmap !== "function") return { image, scale: 1 };
  const bitmap = await createImageBitmap(image);
  try {
    const maxSide = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(2, 2400 / Math.max(1, maxSide));
    if (scale < 1.15) return { image, scale: 1 };

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return { image, scale: 1 };
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const scaled = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    return scaled ? { image: scaled, scale } : { image, scale: 1 };
  } finally {
    bitmap.close();
  }
}

/**
 * Local PaddleOCR runner. Fast-mode archives ship with the app; precise and
 * English-enhanced archives are downloaded once by the backend and reused.
 */
export class LocalPaddleOcr {
  private runtime: OcrRuntime<PaddleOcrInstance>;

  constructor(private readonly mode: OcrMode = "fast", private readonly imageOptions: { upscale?: boolean; maxSide?: number } = {}) {
    this.runtime = new OcrRuntime(() => this.initialize(), (instance) => instance.dispose());
  }

  private async initialize(): Promise<PaddleOcrInstance> {
      const models = modelPair(this.mode);
      return (this.mode === "fast"
        ? Promise.resolve()
        : api.ensureOcrMode(this.mode).then(() => undefined))
        .then(() => import("@paddleocr/paddleocr-js"))
        .then(({ PaddleOCR }) =>
          PaddleOCR.create({
            worker: true,
            initialize: true,
            textDetectionModelName: models.detName,
            textDetectionModelAsset: {
              url: models.detUrl,
            },
            textRecognitionModelName: models.recName,
            textRecognitionModelAsset: {
              url: models.recUrl,
            },
            textDetectionBatchSize: 1,
            textRecognitionBatchSize: 8,
            textDetMaxSideLimit: this.imageOptions.maxSide ?? 4000,
            // Keep isolated diagram glyphs such as the "T" in T₂/T₃. Their
            // detection boxes score lower than normal prose at small sizes.
            textDetBoxThresh: 0.3,
            textRecScoreThresh: 0,
            ortOptions: {
              // WASM is slower than WebGPU but is consistent across Windows
              // WebView2 versions. Keeping one thread avoids COOP/COEP coupling.
              backend: "wasm",
              wasmPaths: localAssetUrl("./ort/"),
              numThreads: 1,
              simd: true,
            },
          }),
        );
  }

  async recognize(image: Blob, onStage?: (stage: string) => void): Promise<PaddleOcrRecognition> {
    return this.runtime.run(async (runner, signal) => {
    onStage?.("正在预处理图片");
    // Manga crops are recognized separately at source resolution. Do not apply
    // the small-diagram upscaling policy to the full manga page.
    const prepared = this.mode === "manga" || this.imageOptions.upscale === false
      ? { image, scale: 1 }
      : await prepareRecognitionImage(image);
    if (signal.aborted) throw new Error("识别已取消");
    onStage?.(this.mode === "manga" ? "正在检测漫画文字区域（前置 OCR）" : "正在检测文字区域，仅识别检测到的区域");
    const [result] = await runner.predict(prepared.image, {
      textDetMaxSideLimit: this.imageOptions.maxSide ?? 4000,
      textDetBoxThresh: 0.3,
      textRecScoreThresh: 0,
    });
    if (!result) throw new Error("PaddleOCR 没有返回识别结果");
    return {
      lines: result.items
        .map((item) => itemToLine(item, prepared.scale))
        .filter((line): line is PaddleOcrLine => line !== null),
      image: {
        width: result.image.width / prepared.scale,
        height: result.image.height / prepared.scale,
      },
      initialization: runner.getInitializationSummary(),
      elapsedMs: result.metrics.totalMs,
    };
    });
  }

  dispose(): Promise<void> {
    return this.runtime.dispose();
  }
}
