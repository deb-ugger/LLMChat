import { gameTaskPrompt, type GamePromptSelection } from "./gamePrompts";
import { API_BASE, type Settings } from "./api";
import { resolveFeatureLlm, loadLocalModelProfiles } from "./modelPresets";
import type { PaddleOcrLine } from "./ocr/paddleOcr";
import { renderUnityImage } from "./unityImages";
import type { UnityImageRegion } from "./unityOffline";

async function request(settings: Settings, model: string, prompt: string, signal: AbortSignal, image?: string): Promise<unknown> {
  if (!model) throw new Error("请选择处理模型");
  const connection = resolveFeatureLlm(settings, model);
  if (!connection.apiUrl) throw new Error("所选模型未配置接口地址");
  const taskId = crypto.randomUUID();
  const cancel = () => { void fetch(`${API_BASE}/api/translate/cancel`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({taskId})}).catch(() => {}); };
  signal.throwIfAborted(); signal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await fetch(`${API_BASE}/api/game-images/model`, { method: "POST", signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...connection, taskId, prompt, image, localModel: !!loadLocalModelProfiles()[model] }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "图片模型处理失败");
    const content = String(result.content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { return JSON.parse(content); } catch { throw new Error("模型未返回有效 JSON，请选择支持结构化输出的模型"); }
  } finally { signal.removeEventListener("abort", cancel); }
}

/** Coordinates are normalized to 0–1000 so resized model input retains original pixel bounds. */
export async function recognizeGameImage(settings: Settings, model: string, blob: Blob, signal: AbortSignal, scene: "screen" | "recognize" = "recognize", selection?: GamePromptSelection, variables?:{source?:string;target?:string}): Promise<PaddleOcrLine[]> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas"), scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const value = await request(settings, model, gameTaskPrompt(scene,selection,variables)+'\n识别图片全部可读文字及位置，不翻译、不推测。仅返回 JSON 数组，每项为 {"text":"原文","confidence":95,"x0":0,"y0":0,"x1":1000,"y1":1000}。坐标以图片左上角为原点，横纵均归一化至0–1000。置信度0–100，无文字返回[]。', signal, canvas.toDataURL("image/png"));
    if (!Array.isArray(value)) throw new Error("识别模型未返回文字区域数组");
    return value.map((line: Record<string, unknown>) => {
      if (!line || typeof line.text !== "string" || !line.text.trim() || ![line.x0,line.y0,line.x1,line.y1,line.confidence].every(n => typeof n === "number" && Number.isFinite(n))) throw new Error("识别模型返回无效文字区域");
      const {x0,y0,x1,y1,confidence} = line as unknown as PaddleOcrLine;
      if (x0 < 0 || y0 < 0 || x1 > 1000 || y1 > 1000 || x1 <= x0 || y1 <= y0 || confidence < 0 || confidence > 100) throw new Error("识别模型返回越界坐标或置信度");
      return {text:line.text, confidence, x0:x0*bitmap.width/1000,y0:y0*bitmap.height/1000,x1:x1*bitmap.width/1000,y1:y1*bitmap.height/1000};
    });
  } finally { bitmap.close(); }
}

export async function renderGameImage(settings: Settings, model: string, blob: Blob, regions: UnityImageRegion[], signal: AbortSignal, selection?: GamePromptSelection, variables?:{source?:string;target?:string}) {
  if (!model) return renderUnityImage(blob, regions);
  const selected = regions.map((region,index) => ({...region,index})).filter(region => region.selected);
  if (!selected.length) return renderUnityImage(blob, regions);
  const result = await request(settings, model, gameTaskPrompt('layout',selection,variables)+'\n为游戏译图规划自然断行，结合文字区域宽高，避免拆开词语。只能添加或删除换行，不能改变文字、标点或空格。返回 JSON 数组，每项 {"index":原索引,"translation":"断行后的译文"}。必须包含全部输入区域。\n'+JSON.stringify(selected.map(r=>({index:r.index,width:r.x1-r.x0,height:r.y1-r.y0,translation:r.translation}))), signal);
  if (!Array.isArray(result) || result.length !== selected.length) throw new Error("排版模型返回的区域数量不匹配");
  const layouts = new Map<number,string>();
  for (const item of result) {
    const original = selected.find(region => region.index === item?.index);
    if (!original || layouts.has(item.index) || typeof item.translation !== "string" || item.translation.replace(/[\r\n]/g, "") !== original.translation.replace(/[\r\n]/g, "")) throw new Error("排版模型修改了译文或区域索引，已停止生成");
    layouts.set(item.index,item.translation);
  }
  return renderUnityImage(blob,regions.map((region,index)=>({...region,translation:layouts.get(index)??region.translation})));
}
