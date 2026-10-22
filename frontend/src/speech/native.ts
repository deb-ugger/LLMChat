import { invoke } from "@tauri-apps/api/core";
import type { ChineseScript, SpeechCue, SpeechFormat, SpeechModel } from "./transcription";

export type SpeechSource = { path: string; name: string; size: number; modified: number; duration: number };
export type SpeechOnlineProvider = "google" | "qwen" | "custom";
export type SpeechProcessing = { mode: "local" | "online"; provider: SpeechOnlineProvider; model: string; proofread: boolean; proofreadModel: string };
export type SpeechJobOptions = { model: SpeechModel; language: string; chineseScript: ChineseScript; formats: SpeechFormat[]; processing?: SpeechProcessing };
export type SpeechJob = { id: string; folder: string; source: SpeechSource; options: SpeechJobOptions; offset: number; cueCount: number; outputStem?: string };
export type SpeechChunk = { from: number; to: number; cues: SpeechCue[]; text: string };

export const speechNative = {
  environment: () => invoke<{ outputRoot: string; legacyOutputRoot: string; toolsReady: boolean }>("speech_environment"),
  probe: (path: string) => invoke<SpeechSource>("speech_probe", { path }),
  create: (root: string, id: string, source: SpeechSource, options: SpeechJobOptions) => {
    const now = new Date();
    const outputDate = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    return invoke<SpeechJob>("speech_create_job", { root, id, source, options, outputDate });
  },
  list: (root: string) => invoke<SpeechJob[]>("speech_list_jobs", { root }),
  resume: (folder: string) => invoke<SpeechJob>("speech_resume_job", { folder }),
  decode: async (folder: string, offset: number) => new Float32Array(await invoke<ArrayBuffer>("speech_decode_chunk", { folder, offset })),
  commit: (folder: string, chunk: SpeechChunk) => invoke<SpeechJob>("speech_commit_chunk", { folder, chunk }),
  cancel: (folder: string) => invoke<void>("speech_cancel_job", { folder }),
  preview: (folder: string, page: number) => invoke<{ cues: SpeechCue[]; total: number }>("speech_read_result", { folder, page }),
};
