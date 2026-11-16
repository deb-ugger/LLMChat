import { gameModelExecution, measureGameAsync, measureGameWork } from "./gameModelPerformance";
import type { OllamaOutput } from "./gameOllama";
import { gameTaskPrompt, type GamePromptSelection } from "./gamePrompts";
import type { Settings } from "./api";
import { requestGameModelJson } from "./gameModelRequest";
import type { PaddleOcrLine } from "./ocr/paddleOcr";
import { renderUnityImage } from "./unityImages";
import type { UnityImageRegion } from "./unityOffline";
import type { ImagePresence } from "./gameImageScreening";

class InvalidImageRegions extends Error {}

export function parseImagePresence(value: unknown): ImagePresence {
  if (!value || typeof value !== "object") throw new Error("复筛模型未返回文字存在判断");
  const result = value as Record<string, unknown>;
  if (typeof result.has_text !== "boolean" || typeof result.confidence !== "number" || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 100 || typeof result.text !== "string") {
    throw new Error("复筛模型的文字存在判断或置信度无效");
  }
  if (!result.has_text && result.text.trim()) throw new Error("复筛结果同时包含无文字判断和文字证据，请重试");
  return { hasText: result.has_text, confidence: result.confidence, evidence: result.text.trim().slice(0, 32) };
}

export async function classifyGameImagePresence(settings: Settings, model: string, blob: Blob, signal: AbortSignal,
  selection: GamePromptSelection | undefined, variables: { source?: string; target?: string }, report: OllamaOutput | undefined, threshold = 50): Promise<ImagePresence> {
  const execution = gameModelExecution(selection, "refine", model);
  const bitmap = await measureGameAsync(execution, "processingMs", () => createImageBitmap(blob));
  try {
    const prompt = gameTaskPrompt("refine", selection, variables) +
      '\n本步只判断图片是否含有真实可读文字，忽略衣物纹理、花纹和装饰。不输出坐标，不抄录全部文字。只返回 {"has_text":true或false,"confidence":0到100,"text":"最多16字的文字证据，无文字时留空"}。confidence表示对此次有字或无字判断的把握。';
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
    if (Math.max(bitmap.width, bitmap.height) <= 1024 || initial.confidence >= Math.max(75, threshold)) return initial;
    return await classify(1600);
  } finally { bitmap.close(); }
}

export function parseGameImageRegions(value: unknown, width: number, height: number): PaddleOcrLine[] {
  const rows: unknown = value && typeof value === "object" && "regions" in value ? value.regions : value;
  if (!Array.isArray(rows)) throw new InvalidImageRegions("识别模型未返回文字区域数组");
  return rows.map((line, index) => {
    if (!line || typeof line.text !== "string" || !line.text.trim()) throw new InvalidImageRegions("第 " + (index + 1) + " 个识别区域缺少文字");
    const numbers = [line.x0, line.y0, line.x1, line.y1, line.confidence].map(value =>
      typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN);
    const [left, top, right, bottom, confidence] = numbers;
    const x0 = Math.min(left, right), x1 = Math.max(left, right);
    const y0 = Math.min(top, bottom), y1 = Math.max(top, bottom);
    if (!numbers.every(Number.isFinite) || x0 < 0 || y0 < 0 || x1 > 1000 || y1 > 1000 || x1 === x0 || y1 === y0 || confidence < 0 || confidence > 100) {
      throw new InvalidImageRegions("第 " + (index + 1) + " 个识别区域的坐标或置信度无效");
    }
    return { text: line.text, confidence, x0: x0 * width / 1000, y0: y0 * height / 1000, x1: x1 * width / 1000, y1: y1 * height / 1000 };
  });
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
    const prompt = gameTaskPrompt(scene, selection, variables) + '\n识别图片全部可读文字及位置，不翻译、不推测。仅返回 JSON 对象 {"regions":[...]}，每项为 {"text":"原文","confidence":95,"x0":0,"y0":0,"x1":1000,"y1":1000}。坐标以图片左上角为原点，横纵均归一化至0–1000，必须满足 0<=x0<x1<=1000、0<=y0<y1<=1000。confidence 必须为0–100的数值，不带百分号。无文字返回 {"regions":[]}，不要输出说明。';
    const recognize = async (instruction: string) => {
      const value = await requestGameModelJson(settings, model, instruction, signal, image, "game-images", report, { selection, role: scene });
      return measureGameWork(execution, "processingMs", () => parseGameImageRegions(value, bitmap.width, bitmap.height));
    };
    try { return await recognize(prompt); }
    catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof InvalidImageRegions)) throw error;
      report?.(model + "：识别区域格式无效，正在重新识别一次。", "info");
      return await recognize(prompt + '\n上次输出未通过校验：' + error.message + '。请重新检查所有区域的坐标范围、非零宽高和置信度，返回完整结果。');
    }
  } catch (error) {
    signal.throwIfAborted();
    const code = (error as { code?: string } | null)?.code;
    if (!fallback || !(error instanceof InvalidImageRegions || code === "GAME_MODEL_INVALID_JSON" || code === "LLM_OUTPUT_TRUNCATED" || code === "LLM_NO_FINAL_ANSWER")) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    report?.(model + "：" + reason + "，改用本地 OCR 识别这张图片。", "info");
    try {
      const lines = await measureGameAsync(execution, "processingMs", () => fallback(blob));
      signal.throwIfAborted();
      return lines;
    } catch (fallbackError) {
      signal.throwIfAborted();
      throw new Error(reason + "；本地 OCR 也未完成：" + (fallbackError instanceof Error ? fallbackError.message : String(fallbackError)), { cause: fallbackError });
    }
  } finally { bitmap.close(); }
}

export async function renderGameImage(settings: Settings, model: string, blob: Blob, regions: UnityImageRegion[], signal: AbortSignal, selection?: GamePromptSelection, variables?:{source?:string;target?:string}, report?: OllamaOutput) {
  const execution = gameModelExecution(selection, "layout", model);
  const render = (values: UnityImageRegion[]) => measureGameAsync(execution, "processingMs", () => renderUnityImage(blob, values));
  if (!model) return render(regions);
  const selected = regions.map((region,index) => ({...region,index})).filter(region => region.selected);
  if (!selected.length) return render(regions);
  const result = await requestGameModelJson(settings, model, gameTaskPrompt('layout',selection,variables)+'\n为游戏译图规划自然断行，结合文字区域宽高，避免拆开词语。只能添加或删除换行，不能改变文字、标点或空格。返回 JSON 数组，每项 {"index":原索引,"translation":"断行后的译文"}。必须包含全部输入区域。\n'+JSON.stringify(selected.map(r=>({index:r.index,width:r.x1-r.x0,height:r.y1-r.y0,translation:r.translation}))), signal, undefined, "game-images", report, { selection, role: "layout" });
  if (!Array.isArray(result) || result.length !== selected.length) throw new Error("排版模型返回的区域数量不匹配");
  const layouts = new Map<number,string>();
  for (const item of result) {
    const original = selected.find(region => region.index === item?.index);
    if (!original || layouts.has(item.index) || typeof item.translation !== "string" || item.translation.replace(/[\r\n]/g, "") !== original.translation.replace(/[\r\n]/g, "")) throw new Error("排版模型修改了译文或区域索引，已停止生成");
    layouts.set(item.index,item.translation);
  }
  return render(regions.map((region,index)=>({...region,translation:layouts.get(index)??region.translation})));
}
