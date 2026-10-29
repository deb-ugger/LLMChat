import type { OcrMode } from "./api";
import type { UnityImage, UnityImageRegion, UnityProject, UnityProgress } from "./unityOffline";
import { LocalPaddleOcr, type PaddleOcrLine } from "./ocr/paddleOcr";
import { LocalMangaOcr } from "./ocr/mangaOcr";

async function png(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("无法生成图片译图");
  return blob;
}
export function createUnityImageOcr(mode: OcrMode) {
  const paddle = new LocalPaddleOcr(mode, mode === "fast" ? { upscale: false, maxSide: 1280 } : {}), manga = mode === "manga" ? new LocalMangaOcr() : null;
  return {
    async recognize(blob: Blob, stage: (value: string) => void): Promise<PaddleOcrLine[]> {
      const result = await paddle.recognize(blob, stage);
      if (!manga) return result.lines;
      if (!result.lines.length) return [];
      const bitmap = await createImageBitmap(blob);
      try {
        const lines: PaddleOcrLine[] = [];
        for (const box of result.lines) {
          const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.ceil(box.x1 - box.x0)); canvas.height = Math.max(1, Math.ceil(box.y1 - box.y0));
          const context = canvas.getContext("2d"); if (!context) throw new Error("无法裁剪图片文字区域");
          context.drawImage(bitmap, box.x0, box.y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
          stage(`日文增强识别 ${lines.length + 1} / ${result.lines.length}`);
          lines.push({ ...box, text: await manga.recognize(await png(canvas)) });
        }
        return lines;
      } finally { bitmap.close(); }
    },
    async dispose() { await Promise.all([paddle.dispose(), manga?.dispose()]); },
  };
}

export class UnityImageLayoutError extends Error {
  constructor(public readonly failures: { index: number; message: string }[]) {
    super(failures.map(failure => `区域 ${failure.index + 1}：${failure.message}`).join("；"));
  }
}
/** Pure-color replacement is explicit; never claim it reconstructs a complex background. */
export async function renderUnityImage(source: Blob, regions: UnityImageRegion[]): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error("无法创建图片画布");
    context.drawImage(bitmap, 0, 0);
    const failures: { index: number; message: string }[] = [];
    const selected = regions.map((region, index) => ({ region, index })).filter(item => item.region.selected);
    const boxes = selected.flatMap(({ region, index }) => {
      const x = Math.max(0, Math.floor(region.x0)), y = Math.max(0, Math.floor(region.y0));
      const width = Math.min(canvas.width - x, Math.ceil(region.x1) - x), height = Math.min(canvas.height - y, Math.ceil(region.y1) - y);
      if (width <= 0 || height <= 0 || !region.translation.trim()) { failures.push({ index, message: "文字区域无效或译文为空，请检查图片译文" }); return []; }
      const pixels = context.getImageData(x, y, width, height).data, samples: number[][] = [[], [], [], []];
      for (let cy = 0; cy < height; cy++) for (let cx = 0; cx < width; cx++) if (cx === 0 || cy === 0 || cx === width - 1 || cy === height - 1)
        for (let channel = 0; channel < 4; channel++) samples[channel].push(pixels[(cy * width + cx) * 4 + channel]);
      const color = samples.map(values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]);
      return [{ region, index, x, y, width, height, color }];
    });
    // Clear all original text before painting any translations, so overlapping boxes do not erase freshly painted text.
    for (const box of boxes) {
      context.clearRect(box.x, box.y, box.width, box.height);
      if (box.color[3] > 16) { context.fillStyle = `rgba(${box.color[0]},${box.color[1]},${box.color[2]},${box.color[3] / 255})`; context.fillRect(box.x, box.y, box.width, box.height); }
    }
    for (const box of boxes) {
      const wrap = (size: number) => {
        context.font = `${size}px "Microsoft YaHei", "Yu Gothic", sans-serif`;
        const lines: string[] = [];
        for (const paragraph of box.region.translation.split(/\r\n|\r|\n/)) {
          let line = "";
          for (const { segment: char } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(paragraph)) {
            if (line && context.measureText(line + char).width > box.width - 4) { lines.push(line); line = ""; }
            line += char;
          }
          lines.push(line);
        }
        return lines;
      };
      let size = Math.min(48, Math.max(7, box.height * .8)), lines = wrap(size);
      while (size > 7 && (lines.length * size * 1.2 > box.height - 2 || lines.some(line => context.measureText(line).width > box.width - 4))) { size -= .5; lines = wrap(size); }
      if (lines.length * size * 1.2 > box.height || lines.some(line => context.measureText(line).width > box.width)) { failures.push({ index: box.index, message: "译文无法放入原文字区域，请缩短译文、调整区域或替换译图" }); continue; }
      context.save(); context.beginPath(); context.rect(box.x, box.y, box.width, box.height); context.clip();
      context.fillStyle = box.color[3] <= 16 || box.color[0] * .299 + box.color[1] * .587 + box.color[2] * .114 > 128 ? "#151515" : "#ffffff";
      context.textAlign = "center"; context.textBaseline = "middle";
      lines.forEach((line, i) => context.fillText(line, box.x + box.width / 2, box.y + box.height / 2 + (i - (lines.length - 1) / 2) * size * 1.2));
      context.restore();
    }
    if (failures.length) throw new UnityImageLayoutError(failures);
    return png(canvas);
  } finally { bitmap.close(); }
}

export type UnityImageServices = {
  read: (image: UnityImage) => Promise<Blob>;
  recognize: (source: Blob, stage: (value: string) => void) => Promise<PaddleOcrLine[]>;
  translate: (text: string) => Promise<string>;
  render: (source: Blob, regions: UnityImageRegion[]) => Promise<Blob>;
  write: (project: UnityProject, image: UnityImage, blob: Blob) => Promise<{ path: string; hash: string }>;
  persist: (project: UnityProject, image: UnityImage) => Promise<void>;
  validate: (source: string, translated: string) => string;
};
export function unityImageParticipates(image: UnityImage) {
  return !/字库图集、法线或光照纹理不参与图片文字翻译|仅支持单张二维纹理，不处理数组或立方体纹理/.test(image.error);
}
export function unityImageHasText(image: UnityImage) { return image.regions.some(region => !!region.text.trim()); }
export function unityImageResultGroup(image: UnityImage) {
  return unityImageHasText(image) ? "text" : image.error ? "failed" : image.ocrCompleted ? "empty" : "pending";
}
export function unityImageTranslationRegions(regions: UnityImageRegion[], threshold: number) {
  return regions.map(region => ({ ...region, selected: region.selected && (region.confidence >= threshold || !!region.manualSelected) }));
}
export async function processUnityImages(project: UnityProject, signal: AbortSignal, services: UnityImageServices, progress: (value: UnityProgress) => void, confidenceThreshold = 50) {
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 100) throw new Error("翻译置信度阈值必须在 0% 到 100% 之间");
  const next = structuredClone(project); next.imagesSkipped = false;
  const images = (next.images || []).filter(image => image.selected && unityImageParticipates(image)), cache = new Map<string, string>();
  for (const entry of next.entries) if (entry.translation && !entry.error && !services.validate(entry.source, entry.translation)) cache.set(entry.source, entry.translation);
  for (const image of next.images || []) for (const region of image.regions) if (region.translation && !region.error && !services.validate(region.text, region.translation)) cache.set(region.text, region.translation);
  let completed = images.filter(image => image.completed).length;
  const report = (detail: string) => progress({ completed, total: images.length, detail });
  for (const image of images) {
    signal.throwIfAborted();
    if (image.completed) continue;
    const publish = async () => services.persist(next, image);
    try {
      report(`读取图片：${image.name}`);
      const source = await services.read(image); signal.throwIfAborted();
      if (!image.ocrCompleted) {
        const lines = await services.recognize(source, stage => report(`${image.name} · ${stage}`)); signal.throwIfAborted();
        image.regions = lines.filter(line => line.text.trim()).map(line => ({ ...line, translation: "", error: "", selected: line.confidence >= confidenceThreshold }));
        image.ocrCompleted = true; image.error = ""; await publish();
      }
      if (!unityImageHasText(image)) image.selected = false;
      let regionNumber = 0;
      const selectedRegions = image.regions.filter(region => region.selected && (region.confidence >= confidenceThreshold || region.manualSelected));
      for (const region of selectedRegions) {
        signal.throwIfAborted(); regionNumber++;
        if (region.translation && !services.validate(region.text, region.translation)) { region.error = ""; continue; }
        report(`${image.name} · 翻译文字 ${regionNumber} / ${selectedRegions.length}`);
        try {
          const translation = cache.get(region.text) || await services.translate(region.text); signal.throwIfAborted();
          const problem = services.validate(region.text, translation); if (problem) throw new Error(problem);
          region.translation = translation; region.error = ""; cache.set(region.text, translation);
        } catch (error) {
          if (signal.aborted) throw error;
          region.error = error instanceof Error ? error.message : String(error);
        }
        await publish();
      }
      const failedRegions = selectedRegions.filter(region => !!region.error);
      if (failedRegions.length) throw new Error(`${failedRegions.length} 个文字区域翻译失败，已保留成功译文和失败详情`);
      if (selectedRegions.length) {
        report(`${image.name} · 生成译图`);
        const result = await services.write(next, image, await services.render(source, unityImageTranslationRegions(image.regions, confidenceThreshold))); signal.throwIfAborted();
        image.renderedFile = result.path; image.renderedHash = result.hash;
      } else { image.renderedFile = ""; image.renderedHash = ""; }
      image.completed = true; image.error = ""; completed++; await publish();
      report(`已完成图片：${image.name}${image.regions.length ? selectedRegions.length ? "" : "（没有达到翻译阈值的区域）" : "（未识别出文字）"}`);
    } catch (error) {
      image.error = signal.aborted ? "" : error instanceof Error ? error.message : String(error);
      if (error instanceof UnityImageLayoutError) for (const failure of error.failures) image.regions[failure.index].error = failure.message;
      await publish();
      if (signal.aborted) throw error;
      completed++;
      report(`图片处理失败，已记录并继续：${image.name}`);
    }
  }
  signal.throwIfAborted();
  const failed = images.filter(image => !image.completed);
  if (failed.length) { report(`已处理 ${images.length} 张图片，${failed.length} 张未完成，失败详情已保存`); throw new Error(`${failed.length} 张图片未完成，请检查图片结果后恢复，或跳过未完成的图片`); }
  report(images.length ? "图片识别、翻译与译图已保存" : "当前没有选中的可处理图片");
  return next;
}
