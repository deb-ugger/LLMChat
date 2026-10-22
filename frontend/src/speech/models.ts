import { useEffect, useSyncExternalStore } from "react";
import { SPEECH_MODELS, type SpeechModel, type SpeechFormat, type ChineseScript } from "./transcription";
import type { SpeechOnlineProvider } from "./native";

export const SPEECH_ONLINE_PROVIDERS = {
  google: { label: "Gemini", model: "gemini-3.8-flash", apiUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" },
  qwen: { label: "通义 Omni", model: "qwen3.8-omni-flash", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions" },
  custom: { label: "自定义音频接口", model: "", apiUrl: "" },
};
export type SpeechConnection = { useGeneral: boolean; apiUrl: string; apiKey: string };
function readConnections(): Record<SpeechOnlineProvider, SpeechConnection> {
  let saved: Partial<Record<SpeechOnlineProvider, SpeechConnection>> = {};
  try { saved = JSON.parse(localStorage.getItem("llmchat-speech-connections") || "{}"); } catch { /* no saved connections */ }
  return Object.fromEntries(Object.entries(SPEECH_ONLINE_PROVIDERS).map(([id, provider]) => [id, saved[id as SpeechOnlineProvider] ?? { useGeneral: id !== "custom", apiUrl: provider.apiUrl, apiKey: "" }])) as Record<SpeechOnlineProvider, SpeechConnection>;
}

export type SpeechPreferences = {
  concurrency: number; formats: SpeechFormat[];
  chineseScript: ChineseScript; language: string; outputRoot: string;
  mode: "local" | "online"; onlineProvider: SpeechOnlineProvider; onlineModel: string; proofread: boolean; proofreadModel: string;
};
const defaultPreferences: SpeechPreferences = { concurrency: 1, formats: ["srt", "txt"], chineseScript: "simplified", language: "auto", outputRoot: "", mode: "local", onlineProvider: "google", onlineModel: SPEECH_ONLINE_PROVIDERS.google.model, proofread: false, proofreadModel: "" };
function readPreferences(): SpeechPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem("llmchat-speech-preferences") || "{}");
    return { ...defaultPreferences, ...saved, concurrency: Math.min(4, Math.max(1, Number(saved.concurrency) || 1)) };
  } catch { return defaultPreferences; }
}

export const SPEECH_CACHE = "transformers-cache";
export const SPEECH_MODEL_FILES = ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"];
const modelUrl = (model: SpeechModel) => `https://huggingface.co/${model}/resolve/main/`;
export type SpeechModelStatus = { model: SpeechModel; files: number; installed: boolean; bytes: number };
export type SpeechDownload = {
  model: SpeechModel; file: string; completedFiles: number;
  loadedBytes: number; totalBytes: number; bytesPerSecond: number;
};
type State = {
  selected: SpeechModel; rows: SpeechModelStatus[] | null; error: string;
  download: SpeechDownload | null;
  inUse: SpeechModel | null;
  preferences: SpeechPreferences;
  connections: Record<SpeechOnlineProvider, SpeechConnection>;
};
const savedModel = localStorage.getItem("llmchat-speech-model");
let state: State = {
  selected: SPEECH_MODELS.find(model => model.id === savedModel)?.id ?? "onnx-community/whisper-base",
  rows: null, error: "", download: null, inUse: null, preferences: readPreferences(), connections: readConnections(),
};
const listeners = new Set<() => void>();
const update = (patch: Partial<State>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
let downloadController: AbortController | null = null;

export async function readSpeechModelStatus(cache: Cache): Promise<SpeechModelStatus[]> {
  return Promise.all(SPEECH_MODELS.map(async ({ id }) => {
    const responses = await Promise.all(SPEECH_MODEL_FILES.map(file => cache.match(modelUrl(id) + file)));
    const present = responses.filter(response => response?.ok);
    return { model: id, files: present.length, installed: present.length === SPEECH_MODEL_FILES.length,
      bytes: present.reduce((sum, response) => sum + Number(response!.headers.get("content-length") || 0), 0) };
  }));
}

export async function refreshSpeechModels() {
  try { update({ rows: await readSpeechModelStatus(await caches.open(SPEECH_CACHE)), error: "" }); }
  catch (error) { update({ error: error instanceof Error ? error.message : String(error) }); }
}
export function selectSpeechModel(model: SpeechModel) {
  if (state.inUse || state.download) return;
  localStorage.setItem("llmchat-speech-model", model);
  update({ selected: model });
}
export function setSpeechModelInUse(model: SpeechModel | null) { update({ inUse: model }); }
export function getSpeechPreferences() { return { ...state.preferences, model: state.selected }; }
export function getSpeechConnection(provider: SpeechOnlineProvider) { return state.connections[provider]; }
export function setSpeechConnection(provider: SpeechOnlineProvider, patch: Partial<SpeechConnection>) {
  const connections = { ...state.connections, [provider]: { ...state.connections[provider], ...patch } };
  localStorage.setItem("llmchat-speech-connections", JSON.stringify(connections));
  update({ connections });
}
export function setSpeechPreferences(patch: Partial<SpeechPreferences>) {
  const preferences = { ...state.preferences, ...patch };
  localStorage.setItem("llmchat-speech-preferences", JSON.stringify(preferences));
  update({ preferences });
}
export function cancelSpeechModelDownload() { downloadController?.abort(); }

export async function downloadSpeechModel(model: SpeechModel) {
  if (state.download) throw new Error("已有语音模型正在下载");
  const controller = new AbortController();
  downloadController = controller;
  update({ download: { model, file: "检查模型文件", completedFiles: 0, loadedBytes: 0, totalBytes: 0, bytesPerSecond: 0 }, error: "" });
  try {
    const cache = await caches.open(SPEECH_CACHE);
    for (let index = 0; index < SPEECH_MODEL_FILES.length; index++) {
      if (controller.signal.aborted) throw new DOMException("已取消下载", "AbortError");
      const file = SPEECH_MODEL_FILES[index], url = modelUrl(model) + file;
      if ((await cache.match(url))?.ok) continue;
      update({ download: { model, file, completedFiles: index, loadedBytes: 0, totalBytes: 0, bytesPerSecond: 0 } });
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`下载 ${file} 失败（HTTP ${response.status}）`);
      if (!response.body) throw new Error(`下载 ${file} 未返回文件内容`);
      const total = Number(response.headers.get("content-length") || 0);
      let loaded = 0, lastUpdate = performance.now(), lastLoaded = 0;
      const publishProgress = () => {
        const now = performance.now();
        update({ download: { model, file, completedFiles: index, loadedBytes: loaded, totalBytes: total,
          bytesPerSecond: (loaded - lastLoaded) * 1000 / Math.max(1, now - lastUpdate) } });
        lastUpdate = now; lastLoaded = loaded;
      };
      const progressStream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, output) {
          loaded += chunk.byteLength; output.enqueue(chunk);
          if (performance.now() - lastUpdate < 150) return;
          publishProgress();
        },
        flush: publishProgress,
      });
      await cache.put(url, new Response(response.body.pipeThrough(progressStream), { headers: response.headers }));
    }
    update({ rows: await readSpeechModelStatus(cache) });
  } catch (error) {
    await refreshSpeechModels();
    update({ error: error instanceof Error && error.name === "AbortError" ? "已停止下载，完整文件已保留，可继续下载。" : error instanceof Error ? error.message : String(error) });
    throw error;
  } finally { downloadController = null; update({ download: null }); }
}

export async function uninstallSpeechModel(model: SpeechModel) {
  if (state.inUse || state.download) throw new Error("请先停止语音识别或下载");
  const cache = await caches.open(SPEECH_CACHE);
  const keys = await cache.keys();
  await Promise.all(keys.filter(key => key.url.startsWith(modelUrl(model))).map(key => cache.delete(key)));
  window.dispatchEvent(new CustomEvent("speech-model-uninstalled", { detail: model }));
  await refreshSpeechModels();
}

export function useSpeechModels(active = true) {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(() => { if (active) void refreshSpeechModels(); }, [active]);
  return snapshot;
}
