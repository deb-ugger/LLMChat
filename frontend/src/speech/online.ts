import { API_BASE, api } from "../api";
import { loadVendorProfiles, resolveFeatureLlm, vendorOfModel } from "../modelPresets";
import { getSpeechConnection, SPEECH_ONLINE_PROVIDERS } from "./models";
import type { SpeechJobOptions } from "./native";
import type { SpeechResult } from "./transcription";

export function encodeSpeechWav(pcm: Float32Array): string {
  const buffer = new ArrayBuffer(44 + pcm.length * 2), data = new DataView(buffer);
  const tag = (at: number, value: string) => { for (let i = 0; i < value.length; i++) data.setUint8(at + i, value.charCodeAt(i)); };
  tag(0, "RIFF"); data.setUint32(4, buffer.byteLength - 8, true); tag(8, "WAVE"); tag(12, "fmt ");
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
  data.setUint32(24, 16000, true); data.setUint32(28, 32000, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
  tag(36, "data"); data.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) { const value = Math.max(-1, Math.min(1, pcm[i])); data.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); }
  let binary = ""; const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

function parseJson(content: string): any {
  const text = content.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\s*```$/, "");
  try { return JSON.parse(text); } catch { throw new Error("在线模型未返回有效 JSON，未保存该片段"); }
}
export function parseOnlineSpeech(content: string, duration: number): SpeechResult {
  const result = parseJson(content);
  if (!Array.isArray(result.cues)) throw new Error("在线识别缺少字幕时间戳，未保存该片段");
  let previousEnd = 0;
  const cues = result.cues.map((cue: any) => {
    if (typeof cue.start !== "number" || typeof cue.end !== "number" || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)
      || cue.start < previousEnd || cue.end <= cue.start || cue.end > duration || typeof cue.text !== "string" || !cue.text.trim())
      throw new Error("在线识别字幕的时间或文字无效，未保存该片段");
    previousEnd = cue.end;
    return { start: cue.start, end: cue.end, text: cue.text.trim() };
  });
  return { cues, text: cues.map((cue: { text: string }) => cue.text).join("\n"), language: typeof result.language === "string" ? result.language.toLowerCase() : undefined };
}
export function applySpeechProofread(original: SpeechResult, content: string): SpeechResult {
  const result = parseJson(content);
  if (!Array.isArray(result.cues) || result.cues.length !== original.cues.length) throw new Error("校对改变了字幕段数，未保存该片段");
  const cues = original.cues.map((cue, index) => {
    const corrected = result.cues[index];
    if (corrected?.id !== index || typeof corrected.text !== "string" || !corrected.text.trim()) throw new Error("校对返回的字幕编号或文字无效，未保存该片段");
    return { ...cue, text: corrected.text.trim() };
  });
  return { ...original, cues, text: cues.map(cue => cue.text).join("\n") };
}

async function callSpeech(body: object, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const taskId = crypto.randomUUID(), controller = new AbortController();
  let cancelled = false;
  const cancel = () => {
    controller.abort();
    if (cancelled) return;
    cancelled = true;
    void fetch(`${API_BASE}/api/translate/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId }), signal: AbortSignal.timeout(5000) }).catch(() => {});
  };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; cancel(); }, 120000);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await fetch(`${API_BASE}/api/speech/process`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, taskId }), signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `在线请求失败 HTTP ${response.status}`);
    if (typeof data.content !== "string") throw new Error("在线接口未返回文本");
    return data.content;
  } catch (error) {
    cancel();
    if (signal.aborted) throw new DOMException("任务已暂停或取消", "AbortError");
    if (timedOut) throw new Error("在线请求超过 120 秒，已停止");
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
}

export async function createSpeechOnline(options: SpeechJobOptions, signal: AbortSignal) {
  const processing = options.processing!;
  const settings = await api.getSettings(); signal.throwIfAborted();
  let audio: { apiUrl: string; apiKey: string; model: string } | undefined;
  if (processing.mode === "online") {
    const connection = getSpeechConnection(processing.provider);
    if (connection.useGeneral) {
      const group = processing.provider === "google" ? "Google" : "通义千问";
      const credentials = vendorOfModel(settings.model) === group ? settings : loadVendorProfiles()[group];
      audio = { apiUrl: credentials?.apiUrl || SPEECH_ONLINE_PROVIDERS[processing.provider].apiUrl, apiKey: credentials?.apiKey || "", model: processing.model };
    } else audio = { apiUrl: connection.apiUrl, apiKey: connection.apiKey, model: processing.model };
    if (!audio.apiUrl || !audio.model || (processing.provider !== "custom" && !audio.apiKey)) throw new Error("请在设置 → 语音转文字中配置在线识别凭证");
  }
  const proofreader = processing.proofread ? resolveFeatureLlm(settings, processing.proofreadModel) : undefined;
  if (proofreader && (!proofreader.apiUrl || !proofreader.model)) throw new Error("请在通用设置中配置校对模型凭证");
  return {
    recognize: async (pcm: Float32Array) => {
      const content = await callSpeech({ ...audio, operation: "recognize", protocol: processing.provider, language: options.language, duration: pcm.length / 16000, audio: encodeSpeechWav(pcm) }, signal);
      return parseOnlineSpeech(content, pcm.length / 16000);
    },
    proofread: async (result: SpeechResult) => result.cues.length ? applySpeechProofread(result, await callSpeech({ ...proofreader, operation: "proofread", cues: result.cues.map(cue => ({ text: cue.text })) }, signal)) : result,
  };
}
