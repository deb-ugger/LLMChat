export type ReplaceRule = { src: string; dst: string };
export type GlossaryEntry = { src: string; dst: string; info?: string };

export type TransEntryStatus =
  | "pending"
  | "done"
  | "skipped"
  | "error"
  | "running";

export type TransEntry = {
  id: string;
  src: string;
  dst: string;
  status: TransEntryStatus;
  error?: string;
  /** Link to subtitle cue / dialogue index */
  metaIndex?: number;
};

/** Plain text / paragraph files */
export const DEFAULT_TEXT_PROMPT =
  "You are a precise bilingual translator for general prose. " +
  "Translate the user text faithfully into the target language. " +
  "Preserve meaning, tone, paragraph breaks, and markdown/code fences when present. " +
  "Do not add explanations, notes, or quotation marks around the whole result. " +
  "Output only the translation.";

/** MTool / JSON string-table localization */
export const DEFAULT_MTOOL_PROMPT =
  "You are a game and UI localization translator for MTool-style JSON string tables. " +
  "Each user message is ONE source string (may be UI label, item name, or short dialogue). " +
  "Translate into the target language naturally and concisely. " +
  "STRICTLY preserve placeholders and control tokens exactly as written, including: " +
  "{0}/{1}/..., %s/%d/%f, %%, \\n, \\t, &lt;tags&gt;, [color]...[/color], and similar markup. " +
  "Do not invent extra lines or merge multiple entries. " +
  "Output only the translated string.";

/** Subtitle translate without timeline retime (ASR fragments / cue groups) */
export const DEFAULT_SUBTITLE_PROMPT =
  "You are a professional subtitle translator for on-screen captions. " +
  "The input may be one cue or several consecutive cues of the same utterance. " +
  "Translate dialogue into the target language for reading on screen: natural, concise, and timed-friendly. " +
  "Keep line breaks if present. Do not add speaker names, timestamps, or notes. " +
  "Preserve meaningful punctuation. Output only the translated subtitle text.";

/**
 * Subtitle translate after timeline retime:
 * each line is already a complete utterance.
 */
export const DEFAULT_SUBTITLE_RETIME_TRANSLATE_PROMPT =
  "You are a professional subtitle translator. " +
  "Each input line is already a complete spoken utterance after timeline repair. " +
  "Translate into the target language for on-screen captions: fluent, natural, and similar in length when possible. " +
  "Do not add speaker names, timestamps, or commentary. " +
  "Keep one translated line for one input line. Output only the translation.";

export type TextPromptScenario =
  | "plain"
  | "mtool"
  | "subtitle"
  | "subtitleRetime";

export function resolveTextPromptScenario(
  format: string,
  opts?: { subtitleRetiming?: boolean; subtitleRetimed?: boolean },
): TextPromptScenario {
  if (format === "srt" || format === "ass") {
    return opts?.subtitleRetiming || opts?.subtitleRetimed
      ? "subtitleRetime"
      : "subtitle";
  }
  if (format === "json") return "mtool";
  return "plain";
}

export function defaultPromptForScenario(scenario: TextPromptScenario): string {
  switch (scenario) {
    case "mtool":
      return DEFAULT_MTOOL_PROMPT;
    case "subtitle":
      return DEFAULT_SUBTITLE_PROMPT;
    case "subtitleRetime":
      return DEFAULT_SUBTITLE_RETIME_TRANSLATE_PROMPT;
    default:
      return DEFAULT_TEXT_PROMPT;
  }
}

export function promptForScenario(
  settings: {
    textTranslatePrompt?: string;
    textPromptMtool?: string;
    textPromptSubtitle?: string;
    textPromptSubtitleRetime?: string;
  },
  scenario: TextPromptScenario,
): string {
  switch (scenario) {
    case "mtool":
      return (settings.textPromptMtool || "").trim() || DEFAULT_MTOOL_PROMPT;
    case "subtitle":
      return (settings.textPromptSubtitle || "").trim() || DEFAULT_SUBTITLE_PROMPT;
    case "subtitleRetime":
      return (
        (settings.textPromptSubtitleRetime || "").trim() ||
        DEFAULT_SUBTITLE_RETIME_TRANSLATE_PROMPT
      );
    default:
      return (settings.textTranslatePrompt || "").trim() || DEFAULT_TEXT_PROMPT;
  }
}

/** True when text needs no LLM translation (empty / numbers / punctuation only). */
export function isNoNeedTranslate(text: string): boolean {
  const t = text.replace(/\{[^}]*\}/g, "").replace(/\\[nNh]/g, " ").trim();
  if (!t) return true;
  // digits, spaces, punctuation, symbols only
  if (/^[\d\s\p{P}\p{S}]+$/u.test(t)) return true;
  // very short pure latin codes like EV001 already handled if alphanumeric mixed — keep translating words
  return false;
}

export function classifyEntryStatus(
  src: string,
  dst: string,
): TransEntryStatus {
  if (isNoNeedTranslate(src)) return "skipped";
  if (dst.trim() && dst !== src) return "done";
  return "pending";
}
export function parseJsonArray<T>(raw: string | undefined | null, fallback: T[]): T[] {
  if (!raw || !raw.trim()) return fallback;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : fallback;
  } catch {
    return fallback;
  }
}

export function stringifyRules(rows: unknown[]): string {
  return JSON.stringify(rows);
}

/** Exact-match replace; longer src first to avoid short-token steal. */
export function applyReplaceRules(text: string, rules: ReplaceRule[]): string {
  const sorted = [...rules]
    .filter((r) => r.src)
    .sort((a, b) => b.src.length - a.src.length);
  let out = text;
  for (const r of sorted) {
    if (!r.src) continue;
    out = out.split(r.src).join(r.dst ?? "");
  }
  return out;
}

/** Split long text into paragraph-aware chunks. */
export function splitTextChunks(text: string, maxLen = 1800): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxLen) return [trimmed];

  const paras = trimmed.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = "";

  const flush = () => {
    if (buf.trim()) chunks.push(buf);
    buf = "";
  };

  const pushPiece = (piece: string) => {
    if (!piece) return;
    if (piece.length > maxLen) {
      flush();
      for (let i = 0; i < piece.length; i += maxLen) {
        chunks.push(piece.slice(i, i + maxLen));
      }
      return;
    }
    const next = buf ? `${buf}\n\n${piece}` : piece;
    if (next.length > maxLen) {
      flush();
      buf = piece;
    } else {
      buf = next;
    }
  };

  for (const p of paras) {
    pushPiece(p);
  }
  flush();
  return chunks.length ? chunks : [trimmed];
}

/**
 * LinguaGacha ManualTransFile.json: flat { "原文": "译文" }.
 * Untranslated entries usually have dst === src.
 */
export function parseManualTransFile(raw: string): {
  map: Record<string, string>;
  entries: TransEntry[];
} {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("需要 LinguaGacha 风格的 JSON 对象（键为原文、值为译文）");
  }
  const map = parsed as Record<string, string>;
  const entries: TransEntry[] = [];
  let i = 0;
  for (const [src, dst] of Object.entries(map)) {
    const d = typeof dst === "string" ? dst : String(dst ?? "");
    entries.push({
      id: `e-${i++}`,
      src,
      dst: d,
      status: classifyEntryStatus(src, d),
    });
  }
  return { map, entries };
}

export function entriesToManualTransJson(entries: TransEntry[]): string {
  const obj: Record<string, string> = {};
  for (const e of entries) {
    obj[e.src] = e.dst;
  }
  return `${JSON.stringify(obj, null, 4)}\n`;
}

export function shouldSkipEntry(
  e: TransEntry,
  opts: { onlyUntranslated: boolean; skipEmpty: boolean },
): boolean {
  if (opts.skipEmpty && !e.src.trim()) return true;
  if (opts.onlyUntranslated && e.dst !== e.src && e.dst.trim() !== "") {
    return true;
  }
  return false;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
