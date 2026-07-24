import { DEFAULT_TEXT_PROMPT, type GlossaryEntry, type ReplaceRule, type TransEntry } from "./textTranslate";
import type { AssDocument, SrtCue } from "./subtitle";

export const PROJECT_KIND = "llmchat-text-project";
export const PROJECT_VERSION = 1;
export const PROJECT_EXT = ".lcproj";
export const PROJECT_FILENAME = `project${PROJECT_EXT}`;

export type ProjectFormat = "plain" | "json" | "srt" | "ass";

export type TokenStats = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type TextProject = {
  version: number;
  kind: typeof PROJECT_KIND;
  name: string;
  /** Folder name under text-projects root */
  folder?: string;
  createdAt: string;
  updatedAt: string;
  sourceLang: string;
  targetLang: string;
  model: string;
  prompt: string;
  glossary: GlossaryEntry[];
  preReplace: ReplaceRule[];
  postReplace: ReplaceRule[];
  format: ProjectFormat;
  entries: TransEntry[];
  /** Original filename if imported from source */
  sourceFileName?: string;
  sourceMeta?: {
    srtCues?: SrtCue[];
    assDoc?: AssDocument;
    plainText?: string;
    /** Backup before subtitleRetiming rewrite */
    originalSrtCues?: SrtCue[];
    originalAssDoc?: AssDocument;
  };
  tokens: TokenStats;
  /** Accumulated translation wall time for this project (ms) */
  elapsedMs?: number;
  /**
   * Subtitle only: when true, merge ASR fragments and retime cues
   * before translating (Scheme C). Default false.
   */
  subtitleRetiming?: boolean;
  /** True after a successful retiming pass on current sourceMeta cues */
  subtitleRetimed?: boolean;
};

export function isProjectFileName(name: string): boolean {
  return name.toLowerCase().endsWith(PROJECT_EXT);
}

export function stripProjectExt(name: string): string {
  return name.replace(/\.lcproj$/i, "");
}

/** Default folder/display name: project - YYYY-MM-DD - HH-mm-ss */
export function defaultProjectName(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `project - ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` - ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

export function isSupportedSourceFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (isProjectFileName(lower)) return false;
  return (
    lower.endsWith(".json") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".md") ||
    lower.endsWith(".srt") ||
    lower.endsWith(".ass") ||
    lower.endsWith(".ssa")
  );
}

export function emptyTokenStats(): TokenStats {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function createProject(opts: {
  name: string;
  format: ProjectFormat;
  sourceLang: string;
  targetLang: string;
  model: string;
  prompt?: string;
  glossary?: GlossaryEntry[];
  preReplace?: ReplaceRule[];
  postReplace?: ReplaceRule[];
  entries: TransEntry[];
  sourceFileName?: string;
  sourceMeta?: TextProject["sourceMeta"];
}): TextProject {
  const now = new Date().toISOString();
  return {
    version: PROJECT_VERSION,
    kind: PROJECT_KIND,
    name: opts.name,
    createdAt: now,
    updatedAt: now,
    sourceLang: opts.sourceLang,
    targetLang: opts.targetLang,
    model: opts.model,
    prompt: opts.prompt?.trim() ? opts.prompt : DEFAULT_TEXT_PROMPT,
    glossary: opts.glossary ?? [],
    preReplace: opts.preReplace ?? [],
    postReplace: opts.postReplace ?? [],
    format: opts.format,
    entries: opts.entries,
    sourceFileName: opts.sourceFileName,
    sourceMeta: opts.sourceMeta,
    tokens: emptyTokenStats(),
    elapsedMs: 0,
    subtitleRetiming: false,
    subtitleRetimed: false,
  };
}

export function parseProject(raw: string): TextProject {
  const data = JSON.parse(raw) as TextProject;
  if (!data || data.kind !== PROJECT_KIND) {
    throw new Error("不是有效的 LLMChat 文本工程文件");
  }
  if (!Array.isArray(data.entries)) {
    throw new Error("工程文件缺少词条列表");
  }
  return {
    ...data,
    version: data.version || PROJECT_VERSION,
    prompt: data.prompt || DEFAULT_TEXT_PROMPT,
    glossary: data.glossary || [],
    preReplace: data.preReplace || [],
    postReplace: data.postReplace || [],
    tokens: data.tokens || emptyTokenStats(),
    elapsedMs: typeof data.elapsedMs === "number" ? data.elapsedMs : 0,
    subtitleRetiming: !!data.subtitleRetiming,
    subtitleRetimed: !!data.subtitleRetimed,
    // "running" must never survive a reload — treat as unfinished
    entries: data.entries.map((e) =>
      e.status === "running"
        ? { ...e, status: "pending" as const, error: undefined }
        : e,
    ),
  };
}

export function serializeProject(project: TextProject): string {
  const next: TextProject = {
    ...project,
    updatedAt: new Date().toISOString(),
    // Never persist transient "running" — crash/reopen would show false in-progress
    entries: project.entries.map((e) =>
      e.status === "running"
        ? { ...e, status: "pending", error: undefined }
        : e,
    ),
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function addTokens(a: TokenStats, b: Partial<TokenStats>): TokenStats {
  return {
    promptTokens: a.promptTokens + (b.promptTokens || 0),
    completionTokens: a.completionTokens + (b.completionTokens || 0),
    totalTokens: a.totalTokens + (b.totalTokens || 0),
  };
}
