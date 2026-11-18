import type { AssDialogue, SrtCue } from "./subtitle";
import { assTimeToMs, srtTimeToMs } from "./subtitleGroups";
import {
  classifyEntryStatus,
  isNoNeedTranslate,
  type TransEntry,
} from "./textTranslate";
import type { TextProject } from "./transProject";
import { emptyTokenStats } from "./transProject";
import { api, type Settings } from "./api";
import { resolveFeatureLlm } from "./modelPresets";

const GAP_MERGE_MS = 800;
const MAX_CUES_PER_WINDOW = 12;
const MAX_CHARS_PER_WINDOW = 420;
const MIN_CUE_MS = 800;

export const SUBTITLE_RETIME_PROMPT =
  "You repair ASR subtitle fragments. The input is consecutive spoken fragments " +
  "that may split mid-sentence or glue two sentences together. " +
  "Reassemble them into complete sentences in the SAME language as the input. " +
  "Output ONLY a JSON array of strings, e.g. [\"sentence one.\",\"sentence two.\"]. " +
  "No markdown, no keys, no commentary. Keep meaning; fix only segmentation.";

export type CueWindow = {
  startMs: number;
  endMs: number;
  texts: string[];
  /** Original cue indexes in sourceMeta list */
  indexes: number[];
};

export function msToSrtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const milli = t % 1000;
  return (
    `${String(h).padStart(2, "0")}:` +
    `${String(m).padStart(2, "0")}:` +
    `${String(s).padStart(2, "0")},` +
    `${String(milli).padStart(3, "0")}`
  );
}

/** ASS uses H:MM:SS.cs (centiseconds). */
export function msToAssTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const cs = Math.floor((t % 1000) / 10);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function plainLen(text: string): number {
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\[nNh]/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

function parseAssPrefixParts(prefix: string): {
  before: string;
  start: string;
  end: string;
  after: string;
} | null {
  const m = prefix.match(/^(Dialogue:\s*)([^,]*),([^,]*),([^,]*),(.*)$/i);
  if (!m) return null;
  return {
    before: `${m[1]}${m[2]},`,
    start: m[3],
    end: m[4],
    after: `,${m[5]}`,
  };
}

export function rewriteAssDialogueTiming(
  d: AssDialogue,
  startMs: number,
  endMs: number,
  text: string,
): AssDialogue {
  const parts = parseAssPrefixParts(d.prefix);
  if (!parts) {
    return { ...d, text };
  }
  const prefix =
    parts.before +
    msToAssTime(startMs) +
    "," +
    msToAssTime(endMs) +
    parts.after;
  return {
    prefix,
    text,
    rawLine: `${prefix}${text}`,
  };
}

/** Pack consecutive cues into windows for LLM sentence repair. */
export function packCueWindows(
  items: { text: string; startMs: number; endMs: number }[],
): CueWindow[] {
  const windows: CueWindow[] = [];
  let charCount = 0;
  for (const [index, cue] of items.entries()) {
    const length = Math.max(1, plainLen(cue.text));
    const current = windows.at(-1);
    if (!current || cue.startMs - current.endMs > GAP_MERGE_MS ||
        current.texts.length >= MAX_CUES_PER_WINDOW || charCount + length > MAX_CHARS_PER_WINDOW) {
      windows.push({ startMs: cue.startMs, endMs: cue.endMs, texts: [cue.text], indexes: [index] });
      charCount = length;
    } else {
      current.texts.push(cue.text);
      current.indexes.push(index);
      current.endMs = Math.max(current.endMs, cue.endMs);
      charCount += length;
    }
  }
  return windows;
}

/** Allocate [start,end] across sentences by character weight. */
export function allocateTimings(
  startMs: number,
  endMs: number,
  sentences: string[],
): { startMs: number; endMs: number; text: string }[] {
  const span = Math.max(MIN_CUE_MS, endMs - startMs);
  const weights = sentences.map((s) => Math.max(1, plainLen(s)));
  const totalW = weights.reduce((a, b) => a + b, 0) || sentences.length;

  // First pass proportional
  let durations = weights.map((w) => Math.max(MIN_CUE_MS, Math.round((w / totalW) * span)));
  let sum = durations.reduce((a, b) => a + b, 0);
  // Scale to fit span if over/under
  if (sum !== span && durations.length > 0) {
    const scale = span / sum;
    durations = durations.map((d) => Math.max(MIN_CUE_MS, Math.round(d * scale)));
    sum = durations.reduce((a, b) => a + b, 0);
    const drift = span - sum;
    durations[durations.length - 1] = Math.max(
      MIN_CUE_MS,
      durations[durations.length - 1] + drift,
    );
  }

  // If still too long for span with min lengths, compress proportionally ignoring min
  sum = durations.reduce((a, b) => a + b, 0);
  if (sum > span && sentences.length > 0) {
    const scale = span / sum;
    durations = durations.map((d) => Math.max(200, Math.round(d * scale)));
    sum = durations.reduce((a, b) => a + b, 0);
    durations[durations.length - 1] += span - sum;
  }

  const out: { startMs: number; endMs: number; text: string }[] = [];
  let t = startMs;
  for (let i = 0; i < sentences.length; i++) {
    const d = durations[i];
    const end = i === sentences.length - 1 ? endMs : t + d;
    out.push({ startMs: t, endMs: Math.max(t + 200, end), text: sentences[i] });
    t = out[out.length - 1].endMs;
  }
  if (out.length) out[out.length - 1].endMs = endMs;
  return out;
}

/** Parse LLM JSON array of sentences; fallback to naive split. */
export function parseSentenceJson(raw: string, fallbackJoined: string): string[] {
  const cleaned = raw.replace(/^\uFEFF/, "").trim();
  // Extract JSON array if wrapped in markdown/code
  const fence = cleaned.match(/\[[\s\S]*\]/);
  const candidate = fence ? fence[0] : cleaned;
  try {
    const v = JSON.parse(candidate) as unknown;
    if (Array.isArray(v)) {
      const arr = v
        .map((x) => (typeof x === "string" ? x.trim() : String(x ?? "").trim()))
        .filter((s) => s.length > 0);
      if (arr.length) return arr;
    }
  } catch {
    /* fall through */
  }
  // Naive: split on sentence-end punctuation
  const naive = fallbackJoined
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (naive.length > 1) return naive;
  return [fallbackJoined.trim()].filter(Boolean);
}

export type RetimeStepEvent =
  | { phase: "pack"; windowCount: number }
  | {
      phase: "split";
      windowIndex: number;
      windowTotal: number;
      cueCount: number;
      skipped: number;
    }
  | { phase: "writeback"; newCueCount: number }
  | { phase: "done"; windowCount: number; skippedWindows: number };

export type RetimeProgress = (msg: string) => void;
export type RetimeStepHandler = (ev: RetimeStepEvent) => void;

export type RetimeLlmOpts = {
  settings: Settings;
  /** Source language of the subtitle (segmentation stays in this language) */
  sourceLang?: string;
  signal?: AbortSignal;
  /** @deprecated prefer onStep */
  onProgress?: RetimeProgress;
  onStep?: RetimeStepHandler;
};

async function llmSplitSentences(
  joined: string,
  opts: RetimeLlmOpts,
): Promise<string[]> {
  const provider = opts.settings.textTranslateProvider || "llm";
  // Prefer LLM for segmentation; non-LLM engines just return naive join split
  if (provider !== "llm") {
    return parseSentenceJson("[]", joined);
  }
  const lang =
    opts.sourceLang || opts.settings.textTranslateSource || "en";
  const llm = resolveFeatureLlm(opts.settings, opts.settings.textTranslateModel);
  const res = await api.translate(joined, { signal: opts.signal }, {
    provider: "llm",
    source: lang,
    target: lang,
    apiUrl: llm.apiUrl,
    apiKey: llm.apiKey,
    model: llm.model,
    prompt: SUBTITLE_RETIME_PROMPT,
    glossary: "[]",
    feature: "text",
  });
  return parseSentenceJson(res.translation || "", joined);
}

function entriesFromSrtCues(cues: SrtCue[]): TransEntry[] {
  return cues.map((c, i) => ({
    id: `srt-${i}`,
    src: c.text,
    dst: "",
    status: classifyEntryStatus(c.text, ""),
    metaIndex: i,
  }));
}

function entriesFromAss(dialogues: AssDialogue[]): TransEntry[] {
  return dialogues.map((d, i) => {
    const empty = isNoNeedTranslate(
      d.text.replace(/\{[^}]*\}/g, "").replace(/\\[nNh]/g, " "),
    );
    return {
      id: `ass-${i}`,
      src: d.text,
      dst: empty ? d.text : "",
      status: empty ? ("skipped" as const) : classifyEntryStatus(d.text, ""),
      metaIndex: i,
    };
  });
}

type TimedText = { text: string; startMs: number; endMs: number };

async function retimeWindows(
  windows: CueWindow[],
  opts: RetimeLlmOpts,
  plainText: (text: string) => string,
  append: (window: CueWindow, timings: TimedText[] | null) => void,
) {
  let skipped = 0;
  opts.onStep?.({ phase: "pack", windowCount: windows.length });
  opts.onProgress?.(`重组时间轴 · ${windows.length} 个窗口…`);
  for (const [index, window] of windows.entries()) {
    if (opts.signal?.aborted) throw new Error("已取消");
    const joined = window.texts.map(text => plainText(text)).join(" ").replace(/\s+/g, " ").trim();
    opts.onStep?.({ phase: "split", windowIndex: index + 1, windowTotal: windows.length, cueCount: window.texts.length, skipped });
    opts.onProgress?.(`重组时间轴 · 窗口 ${index + 1}/${windows.length}（${window.texts.length} 条）…`);
    let sentences: string[];
    try {
      sentences = await llmSplitSentences(joined, opts);
    } catch {
      sentences = []; // A failed window keeps its original cues and timings.
    }
    if (sentences.length) {
      append(window, allocateTimings(window.startMs, window.endMs, sentences));
    } else {
      ++skipped;
      append(window, null);
    }
  }
  return skipped;
}

/**
 * Rebuild project cues via LLM sentence repair + proportional retiming.
 * Backs up originals once; idempotent if already retimed unless force.
 */
export async function retimeProjectSubtitles(
  project: TextProject,
  opts: RetimeLlmOpts & { force?: boolean },
): Promise<{ project: TextProject; windowCount: number; skippedWindows: number }> {
  if (project.format !== "srt" && project.format !== "ass") {
    return { project, windowCount: 0, skippedWindows: 0 };
  }
  if (project.subtitleRetimed && !opts.force) {
    return { project, windowCount: 0, skippedWindows: 0 };
  }

  let entries: TransEntry[];
  let sourceMeta: TextProject["sourceMeta"];
  let windows: CueWindow[];
  let skippedWindows: number;
  if (project.format === "srt") {
    const original = project.sourceMeta?.originalSrtCues ?? project.sourceMeta?.srtCues;
    if (!original?.length) throw new Error("工程缺少 SRT 时间轴数据，无法重组");
    windows = packCueWindows(original.map(cue => ({
      text: cue.text, startMs: srtTimeToMs(cue.start), endMs: srtTimeToMs(cue.end),
    })));
    const cues: SrtCue[] = [];
    skippedWindows = await retimeWindows(windows, opts, text => text, (window, timings) => {
      if (timings) {
        for (const cue of timings) cues.push({
          index: cues.length + 1, start: msToSrtTime(cue.startMs), end: msToSrtTime(cue.endMs), text: cue.text,
        });
      } else {
        for (const index of window.indexes) cues.push({ ...original[index], index: cues.length + 1 });
      }
    });
    entries = entriesFromSrtCues(cues);
    sourceMeta = { ...project.sourceMeta, originalSrtCues: original, srtCues: cues };
  } else {
    const original = project.sourceMeta?.originalAssDoc ?? project.sourceMeta?.assDoc;
    if (!original?.dialogues.length) throw new Error("工程缺少 ASS 对白数据，无法重组");
    windows = packCueWindows(original.dialogues.map(dialogue => {
      const match = dialogue.prefix.match(/^Dialogue:\s*[^,]*,\s*([^,]+),\s*([^,]+),/i);
      return { text: dialogue.text, startMs: match ? assTimeToMs(match[1]) : 0, endMs: match ? assTimeToMs(match[2]) : 0 };
    }));
    const dialogues: AssDialogue[] = [];
    skippedWindows = await retimeWindows(windows, opts, text => text.replace(/\{[^}]*\}/g, "").replace(/\\[nNh]/g, " "), (window, timings) => {
      if (timings) {
        const template = original.dialogues[window.indexes[0]];
        for (const cue of timings) dialogues.push(rewriteAssDialogueTiming(template, cue.startMs, cue.endMs, cue.text));
      } else {
        for (const index of window.indexes) dialogues.push({ ...original.dialogues[index] });
      }
    });
    entries = entriesFromAss(dialogues);
    sourceMeta = { ...project.sourceMeta, originalAssDoc: original, assDoc: { ...original, dialogues } };
  }

  opts.onStep?.({ phase: "writeback", newCueCount: entries.length });
  const next = { ...project, entries, sourceMeta, tokens: emptyTokenStats(), subtitleRetimed: true, subtitleRetiming: true };
  const windowCount = windows.length;
  opts.onStep?.({ phase: "done", windowCount, skippedWindows });
  return { project: next, windowCount, skippedWindows };
}
