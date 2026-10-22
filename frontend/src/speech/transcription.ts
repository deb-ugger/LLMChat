export const SPEECH_MODELS = [
  { id: "onnx-community/whisper-tiny", label: "Whisper Tiny · 轻量快速", language: "auto", englishOnly: false, sizeMiB: 41, description: "多语言快速预览；运行更快、占用较低，复杂口音和噪声下更容易漏字。" },
  { id: "onnx-community/whisper-base", label: "Whisper Base · 均衡", language: "auto", englishOnly: false, sizeMiB: 76, description: "多语言日常录音、课程和访谈；速度与识别效果较均衡。" },
  { id: "onnx-community/whisper-small", label: "Whisper Small · 多语言", language: "auto", englishOnly: false, sizeMiB: 240, description: "多语言录音、复杂口音和较快语速；精度较高，速度较慢、内存占用较高。" },
  { id: "onnx-community/whisper-small-chinese-2-ONNX", label: "Whisper Small · 中文特化", language: "chinese", englishOnly: false, sizeMiB: 391, description: "针对中文语音微调，适合普通话录音、课程和访谈。" },
  { id: "onnx-community/distil-small.en", label: "Distil-Whisper · 英文特化", language: "english", englishOnly: true, sizeMiB: 167, description: "英文语音识别，适合英语课程、访谈和演讲。" },
  { id: "onnx-community/kotoba-whisper-v2.2-ONNX", label: "Kotoba-Whisper · 日文特化", language: "japanese", englishOnly: false, sizeMiB: 985, description: "针对日语语音调优，适合日语对话、课程和节目；运行内存占用较高。" },
] as const;

export type SpeechModel = typeof SPEECH_MODELS[number]["id"];
export type SpeechCue = { start: number; end: number; text: string };
export type SpeechResult = { text: string; cues: SpeechCue[]; language?: string };
export type SpeechProgress = { phase: "download" | "recognize"; message: string; percent?: number };
export type SpeechRequest = { id: number; model: SpeechModel; language: string; pcm: Float32Array; assetBase: string; preview?: boolean };
export type SpeechResponse =
  | { id: number; type: "progress"; progress: SpeechProgress }
  | { id: number; type: "preview"; text: string }
  | { id: number; type: "result"; result: SpeechResult }
  | { id: number; type: "error"; message: string };

export type SpeechFormat = "srt" | "vtt" | "txt";
export type ChineseScript = "simplified" | "traditional" | "original";

export function estimateSpeechProgress(duration: number, offset: number, startedOffset: number, processingMs: number) {
  const percent = duration > 0 ? Math.min(100, Math.max(0, offset / duration * 100)) : 0;
  const processed = offset - startedOffset;
  const remainingSeconds = offset >= duration ? 0
    : processed > 0 && processingMs > 0 ? (duration - offset) * processingMs / processed / 1000 : null;
  return { percent, remainingSeconds };
}

/** Commit complete sentences and replay the unfinished tail in the next window. */
export function planSpeechCommit(result: SpeechResult, offset: number, duration: number, final: boolean) {
  if (result.text && !result.cues.length) throw new Error("模型没有返回有效时间戳，无法保存字幕断点");
  const bounded = final ? result.cues : result.cues.filter(cue => cue.end <= 25 && cue.end >= 0);
  const useBoundary = bounded.length > 0 && bounded.at(-1)!.end >= 5;
  const selected = useBoundary ? bounded : result.cues;
  const length = final || !selected.length || !useBoundary ? duration : selected.at(-1)!.end;
  const cues = selected.map(cue => ({ ...cue, start: offset + cue.start, end: Math.min(offset + length, offset + cue.end) }));
  return { from: offset, to: offset + length, cues, text: cues.map(cue => cue.text).join("\n") };
}

export function formatSpeechTime(seconds: number, separator = ","): string {
  const value = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const ms = String(value % 1000).padStart(3, "0");
  const s = String(Math.floor(value / 1000) % 60).padStart(2, "0");
  const m = String(Math.floor(value / 60000) % 60).padStart(2, "0");
  const h = String(Math.floor(value / 3600000)).padStart(2, "0");
  return `${h}:${m}:${s}${separator}${ms}`;
}

/** Preserve model timestamps; close an open final cue at the end of the audio. */
export function normalizeSpeechChunks(chunks: { timestamp: [number | null, number | null]; text: string }[], duration: number): SpeechCue[] {
  const cues: SpeechCue[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const text = chunk.text.trim().replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n");
    if (!text || chunk.timestamp[0] === null || !Number.isFinite(chunk.timestamp[0])) continue;
    const start = Math.max(cues.at(-1)?.end ?? 0, Math.min(duration, chunk.timestamp[0]));
    const proposedEnd = chunk.timestamp[1] ?? chunks.slice(i + 1).find(item => item.timestamp[0] !== null && Number.isFinite(item.timestamp[0]))?.timestamp[0] ?? duration;
    if (!Number.isFinite(proposedEnd)) continue;
    const end = Math.min(duration, Math.max(start, proposedEnd));
    if (Math.round(end * 1000) <= Math.round(start * 1000)) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

export function exportSpeech(result: SpeechResult, format: "srt" | "vtt" | "txt"): string {
  if (format === "txt") return result.text.trim() + "\n";
  if (!result.cues.length) throw new Error("没有可用时间戳，请导出纯文本。");
  const separator = format === "vtt" ? "." : ",";
  const body = result.cues.map((cue, i) => `${i + 1}\n${formatSpeechTime(cue.start, separator)} --> ${formatSpeechTime(cue.end, separator)}\n${cue.text.trim()}\n`).join("\n");
  return (format === "vtt" ? "WEBVTT\n\n" : "") + body;
}
