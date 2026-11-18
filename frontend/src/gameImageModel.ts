import { gameModelExecution, measureGameAsync, measureGameWork } from "./gameModelPerformance";
import type { OllamaOutput } from "./gameOllama";
import { gameTaskPrompt, type GamePromptSelection } from "./gamePrompts";
import type { Settings } from "./api";
import { requestGameModelJson } from "./gameModelRequest";
import type { PaddleOcrLine } from "./ocr/paddleOcr";
import { renderUnityImage, UnityImageLayoutError } from "./unityImages";
import type { UnityImageRegion } from "./unityOffline";
import { IMAGE_PRESENCE_CONFLICT, IMAGE_PRESENCE_REVIEW_HINT, type ImagePresence } from "./gameImageScreening";

class InvalidImageRegions extends Error {}

export function parseImagePresence(value: unknown): ImagePresence {
  if (!value || typeof value !== "object") throw new Error("复筛模型未返回文字存在判断");
  const result = value as Record<string, unknown>;
  if (typeof result.text_probability !== "number" || !Number.isFinite(result.text_probability) || result.text_probability < 0 || result.text_probability > 100) {
    throw new Error("复筛模型的文字存在概率无效");
  }
  if (result.text_probability === 0 && typeof result.text === "string" && result.text.trim()) throw new Error(`${IMAGE_PRESENCE_CONFLICT}。${IMAGE_PRESENCE_REVIEW_HINT}`);
  return { textProbability: result.text_probability };
}

export async function classifyGameImagePresence(settings: Settings, model: string, blob: Blob, signal: AbortSignal,
  selection: GamePromptSelection | undefined, variables: { source?: string; target?: string }, report: OllamaOutput | undefined, threshold = 50): Promise<ImagePresence> {
  const execution = gameModelExecution(selection, "refine", model);
  const bitmap = await measureGameAsync(execution, "processingMs", () => createImageBitmap(blob));
  try {
    const prompt = gameTaskPrompt("refine", selection, variables) +
      '\n输出只包含 text_probability 的 JSON 对象。以 0–100 的数值表示图片存在真实可读文字的概率：清楚看到文字接近 100，无法确定时填 50，确定没有文字时填 0。不输出文字证据、坐标或说明。';
    const classify = async (maxSide: number) => {
      signal.throwIfAborted();
      const image = measureGameWork(execution, "processingMs", () => {
        const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
      });
      const result = await requestGameModelJson(settings, model, prompt, signal, image, "game-images", report,
        { selection, role: "refine", imageClassification: true });
      return measureGameWork(execution, "processingMs", () => parseImagePresence(result));
    };
    const initial = await classify(1024);
    const certainty = Math.max(initial.textProbability, 100 - initial.textProbability);
    if (Math.max(bitmap.width, bitmap.height) <= 1024 || certainty >= Math.max(75, threshold)) return initial;
    return await classify(1600);
  } finally { bitmap.close(); }
}

export function parseGameImageRegions(value: unknown, width: number, height: number, onClipped?: (edges: string[]) => void): PaddleOcrLine[] {
  const rows: unknown = value && typeof value === "object" && "regions" in value ? value.regions : value;
  if (!Array.isArray(rows)) throw new InvalidImageRegions("识别模型未返回文字区域数组");
  const clipped: string[] = [];
  const lines = rows.map((line, index) => {
    const region = `第 ${index + 1} 个识别区域`;
    if (!line || typeof line.text !== "string" || !line.text.trim()) throw new InvalidImageRegions(`${region}缺少文字`);
    let clippedEdge = false;
    const number = (field: "x0" | "y0" | "x1" | "y1" | "confidence", max: number) => {
      const raw: unknown = line[field];
      const value = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
      if (Number.isFinite(value) && value >= 0 && value <= max) return value;
      const start = field === "x0" || field === "y0";
      if (!clippedEdge && field !== "confidence" && Number.isFinite(value) && (start ? value < 0 : value > max)) {
        const boundary = start ? 0 : max;
        clippedEdge = true;
        clipped.push(`${region}坐标 ${field} 从 ${value} 裁到 ${boundary}`);
        return boundary;
      }
      const label = field === "confidence" ? "置信度" : `坐标 ${field}`;
      const received = raw === undefined ? "缺失" : typeof raw === "object" && raw !== null ? "非数值" : JSON.stringify(typeof raw === "string" ? raw.slice(0, 40) : raw);
      throw new InvalidImageRegions(`${region}${label}无效（返回 ${received}，应为 0–${max} 的数值）`);
    };
    const [left, top, right, bottom] = (["x0", "y0", "x1", "y1"] as const).map(field => number(field, 1000));
    const confidence = number("confidence", 100);
    const x0 = Math.min(left, right), x1 = Math.max(left, right);
    const y0 = Math.min(top, bottom), y1 = Math.max(top, bottom);
    if (x0 === x1 || y0 === y1) {
      throw new InvalidImageRegions(`${region}坐标无效（x0=${x0}，y0=${y0}，x1=${x1}，y1=${y1}，区域宽高必须大于 0）`);
    }
    return { text: line.text, confidence, x0: x0 * width / 1000, y0: y0 * height / 1000, x1: x1 * width / 1000, y1: y1 * height / 1000 };
  });
  if (clipped.length) onClipped?.(clipped);
  return lines;
}

// Join wrapped fields and clearly continuous CJK lines while keeping separate boxes intact.
export function mergeGameImageFieldLines<T extends PaddleOcrLine>(lines: T[], compatible?: (first: T, next: T) => boolean): T[] {
  const fieldStart = /^[^：:\r\n。！？]{1,24}[:：]/u;
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const endsSentence = /[。！？!?…]$/u;
  const continuation = /^(?:的[\p{Script=Han}]|之[\p{Script=Han}]|[をがにでへともの][\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[，、。！？])/u;
  const blocks: { box: T; tail: T }[] = [];
  for (const line of [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
    let match: typeof blocks[number] | undefined;
    let minGap = Infinity;
    if (!fieldStart.test(line.text.trim()) && !/[\r\n]/.test(line.text)) {
      for (const block of blocks) {
        const { box, tail } = block;
        const previousText = tail.text.trim(), nextText = line.text.trim();
        if (/[\r\n]/.test(tail.text) || endsSentence.test(previousText) || compatible && !compatible(tail, line)) continue;
        const height = line.y1 - line.y0, previousHeight = tail.y1 - tail.y0;
        const gap = line.y0 - tail.y1;
        const overlap = Math.min(line.x1, tail.x1) - Math.max(line.x0, tail.x0);
        const narrower = Math.min(line.x1 - line.x0, tail.x1 - tail.x0);
        if (height < previousHeight * .7 || height > previousHeight * 1.4 || gap < -previousHeight * .15 || gap > previousHeight * .35 ||
            overlap < narrower * .75) continue;
        const leftAligned = Math.abs(line.x0 - tail.x0) <= previousHeight * .4;
        const centered = Math.abs(line.x0 + line.x1 - tail.x0 - tail.x1) <= previousHeight;
        const wrapsField = leftAligned && fieldStart.test(box.text.trim());
        const continuesSentence = (leftAligned || centered) && cjk.test(previousText) && cjk.test(nextText) &&
          [...previousText].length >= 4 && continuation.test(nextText);
        if (!wrapsField && !continuesSentence) continue;
        if (Math.abs(gap) < minGap) { match = block; minGap = Math.abs(gap); }
      }
    }
    if (!match) { blocks.push({ box: line, tail: line }); continue; }
    const previous = match.box.text.trimEnd(), following = line.text.trimStart();
    const separator = cjk.test(previous.at(-1) || "") && (cjk.test(following[0] || "") || /^[，、。！？]/u.test(following)) ? "" : " ";
    match.box = { ...match.box, text: previous + separator + following, confidence: Math.min(match.box.confidence, line.confidence),
      x0: Math.min(match.box.x0, line.x0), y0: Math.min(match.box.y0, line.y0),
      x1: Math.max(match.box.x1, line.x1), y1: Math.max(match.box.y1, line.y1) };
    match.tail = line;
  }
  return blocks.map(block => block.box);
}

/** Coordinates are normalized to 0–1000 so resized model input retains original pixel bounds. */
export async function recognizeGameImage(settings: Settings, model: string, blob: Blob, signal: AbortSignal, scene: "screen" | "refine" | "recognize" = "recognize", selection?: GamePromptSelection, variables?:{source?:string;target?:string}, report?: OllamaOutput, fallback?: (blob: Blob) => Promise<PaddleOcrLine[]>): Promise<PaddleOcrLine[]> {
  const execution = gameModelExecution(selection, scene, model);
  const bitmap = await measureGameAsync(execution, "processingMs", () => createImageBitmap(blob));
  try {
    const canvas = document.createElement("canvas"), scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const image = measureGameWork(execution, "processingMs", () => {
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    });
    const prompt = gameTaskPrompt(scene, selection, variables) + '\n识别图片全部可读文字及位置，不翻译、不推测。仅返回 JSON 对象 {"regions":[...]}，每项为 {"text":"原文","confidence":95,"x0":0,"y0":0,"x1":1000,"y1":1000}。坐标以图片左上角为原点，横纵均归一化至0–1000，必须满足 0<=x0<x1<=1000、0<=y0<y1<=1000。confidence 必须为0–100的数值，不带百分号。无文字返回 {"regions":[]}，不要输出说明。' + (scene === "recognize" ? "同一段落或同一标签的内容因排版换行时，用一个区域包住整段，合成完整原文。不同列、独立标题或下一个带标签的字段分别返回。" : "");
    const recognize = async (instruction: string) => {
      const value = await requestGameModelJson(settings, model, instruction, signal, image, "game-images", report, { selection, role: scene });
      return measureGameWork(execution, "processingMs", () => {
        const lines = parseGameImageRegions(value, bitmap.width, bitmap.height, edges => {
          const detail = edges.length === 1 ? edges[0] : `已裁正 ${edges.length} 个越界坐标（${edges[0]}）`;
          report?.(`${model} · ${detail}。已保留识别结果。`, "error");
        });
        return scene === "recognize" ? mergeGameImageFieldLines(lines) : lines;
      });
    };
    try { return await recognize(prompt); }
    catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof InvalidImageRegions)) throw error;
      report?.(`${model} · ${error.message}。正在重新识别一次。`, "error");
      return await recognize(prompt + '\n上次输出未通过校验：' + error.message + '。请重新检查所有区域的坐标范围、非零宽高和置信度，返回完整结果。');
    }
  } catch (error) {
    signal.throwIfAborted();
    const failure = error as { code?: string; outputTokenLimit?: number; completionTokens?: number; promptTokens?: number } | null;
    const code = failure?.code;
    const truncated = code === "LLM_OUTPUT_TRUNCATED";
    const contextLimited = code === "OLLAMA_CONTEXT_LIMIT";
    const limit = failure?.outputTokenLimit;
    const tokens = failure?.completionTokens;
    const input = failure?.promptTokens;
    const limitLabel = limit === undefined ? "未记录" : limit > 0 ? `${limit} token` : "未指定，使用服务设置";
    const usage = tokens !== undefined && tokens > 0 ? input !== undefined && input > 0
      ? `，输入 ${input} + 输出 ${tokens} = ${input + tokens} token` : `，服务报告已生成 ${tokens} token` : "";
    const message = error instanceof Error ? error.message : String(error);
    const reason = truncated && !message.startsWith("Ollama") ? `视觉识字输出被截断（请求输出上限 ${limitLabel}${usage}）` : message;
    if (!fallback || !(error instanceof InvalidImageRegions || code === "GAME_MODEL_INVALID_JSON" || truncated || contextLimited || code === "LLM_NO_FINAL_ANSWER")) {
      if (reason !== message) throw Object.assign(new Error(reason, { cause: error }), { code });
      throw error;
    }
    report?.(`${model} · ${reason.replace(/。$/, "")}。软件已自动启动本地 OCR。`, "error");
    try {
      const lines = await measureGameAsync(execution, "processingMs", () => fallback(blob));
      signal.throwIfAborted();
      const regions = scene === "recognize" ? mergeGameImageFieldLines(lines) : lines;
      report?.(`本地 OCR 已完成，${regions.length ? `得到 ${regions.length} 个文字区域` : "未识别到文字"}。`, "success");
      return regions;
    } catch (fallbackError) {
      signal.throwIfAborted();
      throw Object.assign(new Error(reason.replace(/。$/, "") + "；本地 OCR 也未完成：" +
        (fallbackError instanceof Error ? fallbackError.message : String(fallbackError)), { cause: fallbackError }), { code });
    }
  } finally { bitmap.close(); }
}

export async function renderGameImage(settings: Settings, model: string, blob: Blob, regions: UnityImageRegion[], signal: AbortSignal, selection?: GamePromptSelection, variables?:{source?:string;target?:string}, report?: OllamaOutput) {
  const execution = gameModelExecution(selection, "layout", model);
  const render = (values: UnityImageRegion[]) => measureGameAsync(execution, "processingMs", () => renderUnityImage(blob, values));
  if (!model) return render(regions);
  const segmenter = new Intl.Segmenter(variables?.target, { granularity: "word" });
  const selected = regions.flatMap((region, index) => {
    if (!region.selected) return [];
    const chunks = Array.from(segmenter.segment(region.translation), item => item.segment);
    return chunks.length < 2 ? [] : [{ index, width: region.x1 - region.x0, height: region.y1 - region.y0, chunks }];
  });
  if (!selected.length) return render(regions);
  const prompt = gameTaskPrompt("layout", selection, variables) +
    '\n只选择断行位置。chunks 是依序排列的原译文片段，编号从 1 开始。breakAfter 填要在其后换行的片段编号，不能填最后一段。原译文中已有的换行会保留。返回 {"regions":[{"index":原区域索引,"breakAfter":[编号]}]}，每个区域一项，无需新增换行时填空数组。只返回编号和 JSON，不抄写译文。\n' +
    JSON.stringify(selected);
  let result: unknown;
  try {
    result = await requestGameModelJson(settings, model, prompt, signal, undefined, "game-images", report, { selection, role: "layout" });
  } catch (error) {
    signal.throwIfAborted();
    const code = (error as { code?: string } | null)?.code;
    if (code !== "GAME_MODEL_INVALID_JSON" && code !== "LLM_OUTPUT_TRUNCATED" && code !== "OLLAMA_CONTEXT_LIMIT" && code !== "LLM_NO_FINAL_ANSWER") throw error;
    report?.(`${model} · ${error instanceof Error ? error.message : String(error)}。本图自动换行。`, "error");
    return render(regions);
  }
  signal.throwIfAborted();
  const rows = result && typeof result === "object" && "regions" in result && Array.isArray(result.regions) ? result.regions : [];
  const layouts = new Map<number, string>();
  const seen = new Set<number>();
  const byIndex = new Map(selected.map(region => [region.index, region.chunks]));
  for (const item of rows) {
    const chunks = byIndex.get(item?.index);
    if (!chunks) continue;
    if (seen.has(item.index)) { layouts.delete(item.index); continue; }
    seen.add(item.index);
    if (!Array.isArray(item.breakAfter) || !item.breakAfter.every((position: unknown) =>
      typeof position === "number" && Number.isInteger(position) && position > 0 && position < chunks.length)) continue;
    const breaks = new Set<number>(item.breakAfter);
    layouts.set(item.index, chunks.map((chunk, index) => breaks.has(index + 1) && !/[\r\n]/.test(chunk + (chunks[index + 1] ?? "")) ? chunk + "\n" : chunk).join(""));
  }
  if (layouts.size < selected.length) {
    report?.(`${model} · ${selected.length - layouts.size} 个区域未收到有效断点，已改为自动换行。`, "error");
  }
  const planned = regions.map((region, index) => ({ ...region, translation: layouts.get(index) ?? region.translation }));
  try { return await render(planned); }
  catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof UnityImageLayoutError)) throw error;
    const retry = new Set(error.failures.map(item => item.index).filter(index => planned[index].translation !== regions[index].translation));
    if (!retry.size) throw error;
    report?.(`${model} · ${retry.size} 个区域的断点超出排版空间，正在自动换行。`, "error");
    return render(planned.map((region, index) => retry.has(index) ? regions[index] : region));
  }
}
