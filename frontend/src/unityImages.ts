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
  const paddle = new LocalPaddleOcr(mode), manga = mode === "manga" ? new LocalMangaOcr() : null;
  return {
    async recognize(blob: Blob, stage: (value: string) => void): Promise<PaddleOcrLine[]> {
      const result = await paddle.recognize(blob, stage);
      if (!manga) return result.lines;
      if (!result.lines.length) throw new Error("未检测到漫画文字区域，请调整识别模式或替换译图");
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

/** Pure-color replacement is explicit; never claim it reconstructs a complex background. */
export async function renderUnityImage(source: Blob, regions: UnityImageRegion[]): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error("无法创建图片画布");
    context.drawImage(bitmap, 0, 0);
    const selected = regions.filter(region => region.selected);
    const boxes = selected.map(region => {
      const x = Math.max(0, Math.floor(region.x0)), y = Math.max(0, Math.floor(region.y0));
      const width = Math.min(canvas.width - x, Math.ceil(region.x1) - x), height = Math.min(canvas.height - y, Math.ceil(region.y1) - y);
      if (width <= 0 || height <= 0 || !region.translation.trim()) throw new Error("文字区域无效或译文为空，请检查图片译文");
      const pixels = context.getImageData(x, y, width, height).data, samples: number[][] = [[], [], [], []];
      for (let cy = 0; cy < height; cy++) for (let cx = 0; cx < width; cx++) if (cx === 0 || cy === 0 || cx === width - 1 || cy === height - 1)
        for (let channel = 0; channel < 4; channel++) samples[channel].push(pixels[(cy * width + cx) * 4 + channel]);
      const color = samples.map(values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]);
      return { region, x, y, width, height, color };
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
      if (lines.length * size * 1.2 > box.height || lines.some(line => context.measureText(line).width > box.width)) throw new Error("译文无法放入原文字区域，请缩短译文、调整区域或替换译图");
      context.save(); context.beginPath(); context.rect(box.x, box.y, box.width, box.height); context.clip();
      context.fillStyle = box.color[3] <= 16 || box.color[0] * .299 + box.color[1] * .587 + box.color[2] * .114 > 128 ? "#151515" : "#ffffff";
      context.textAlign = "center"; context.textBaseline = "middle";
      lines.forEach((line, i) => context.fillText(line, box.x + box.width / 2, box.y + box.height / 2 + (i - (lines.length - 1) / 2) * size * 1.2));
      context.restore();
    }
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
export async function processUnityImages(project: UnityProject, signal: AbortSignal, services: UnityImageServices, progress: (value: UnityProgress) => void) {
  const next = structuredClone(project); next.imagesSkipped = false;
  const images = (next.images || []).filter(image => image.selected), cache = new Map<string, string>();
  for (const entry of next.entries) if (entry.translation && !entry.error && !services.validate(entry.source, entry.translation)) cache.set(entry.source, entry.translation);
  for (const image of next.images || []) for (const region of image.regions) if (region.translation && !region.error && !services.validate(region.text, region.translation)) cache.set(region.text, region.translation);
  let completed = images.filter(image => image.completed).length, failures = 0, imageFailures = 0;
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
        image.regions = lines.filter(line => line.text.trim()).map(line => ({ ...line, translation: "", error: "", selected: true }));
        image.ocrCompleted = true; image.error = ""; await publish();
      }
      let regionNumber = 0;
      for (const region of image.regions.filter(region => region.selected)) {
        signal.throwIfAborted(); regionNumber++;
        if (region.translation && !services.validate(region.text, region.translation)) { region.error = ""; continue; }
        report(`${image.name} · 翻译文字 ${regionNumber} / ${image.regions.filter(region => region.selected).length}`);
        try {
          const translation = cache.get(region.text) || await services.translate(region.text); signal.throwIfAborted();
          const problem = services.validate(region.text, translation); if (problem) throw new Error(problem);
          region.translation = translation; region.error = ""; cache.set(region.text, translation); failures = 0;
        } catch (error) {
          if (signal.aborted) throw error;
          region.error = error instanceof Error ? error.message : String(error); failures++;
          await publish();
          if (failures >= 3) throw new Error(`图片文字连续翻译失败 3 次，已停止并保存进度：${region.error}`);
          throw error;
        }
        await publish();
      }
      if (image.regions.some(region => region.selected)) {
        report(`${image.name} · 生成译图`);
        const result = await services.write(next, image, await services.render(source, image.regions)); signal.throwIfAborted();
        image.renderedFile = result.path; image.renderedHash = result.hash;
      } else { image.renderedFile = ""; image.renderedHash = ""; }
      image.completed = true; image.error = ""; imageFailures = 0; completed++; await publish();
      report(`已完成图片：${image.name}${image.regions.length ? "" : "（未检测到文字）"}`);
    } catch (error) {
      image.error = signal.aborted ? "" : error instanceof Error ? error.message : String(error);
      await publish();
      imageFailures++;
      if (signal.aborted || failures >= 3 || imageFailures >= 3) throw error;
    }
  }
  signal.throwIfAborted();
  const failed = images.filter(image => !image.completed);
  if (failed.length) throw new Error(`${failed.length} 张图片未完成，请检查图片结果后恢复，或跳过未完成的图片`);
  report(images.length ? "图片识别、翻译与译图已保存" : "当前没有选中的可处理图片");
  return next;
}
