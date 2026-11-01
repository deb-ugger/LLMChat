import type { UnityEntry } from "./unityOffline";

export type TranslationRow = { id: string; source: string; translation: string };
export type UnityTranslationImportIssue = TranslationRow & { reason: string };
export class UnityTranslationImportError extends Error {
  constructor(public issues: UnityTranslationImportIssue[], public checked: number) {
    super(`已检查 ${checked} 条，发现 ${issues.length} 条问题`);
    this.issues = issues.map(issue => ({ ...issue, reason: issue.reason.replace(/[，,]?\s*请重试此条$/, "") }));
    this.name = "UnityTranslationImportError";
  }
}
const kind = "llmchat-unity-translations";
export type UnityTranslationImportMode = "fill" | "replace";
type ImportOptions = { mode?: UnityTranslationImportMode; allowClear?: boolean };

export function unityTranslationFileName(gameExe: string, gameDir: string) {
  const name = (gameExe.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") || gameDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "游戏")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
  return `${name || "游戏"}_Unity翻译.json`;
}

export function exportUnityTranslations(entries: UnityEntry[], csv = false) {
  const rows = entries.map(({ id, source, translation }) => ({ id, source, translation }));
  if (!csv) return JSON.stringify({ kind, version: 1, entries: rows }, null, 2);
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return "\uFEFF" + [["id", "source", "translation"], ...rows.map(row => [row.id, row.source, row.translation])].map(row => row.map(quote).join(",")).join("\r\n");
}

function readCsv(text: string): TranslationRow[] {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false, closed = false;
  const finishRow = () => { row.push(cell); if (row.some(value => value.length)) rows.push(row); row = []; cell = ""; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else cell += char;
    } else if (char === ",") { row.push(cell); cell = ""; closed = false; }
    else if (char === "\r" || char === "\n") { if (char === "\r" && text[i + 1] === "\n") i++; finishRow(); }
    else if (char === '"' && !cell && !closed) quoted = true;
    else if (char === '"' || closed) throw new Error("CSV 引号格式错误，请保留导出文件的列结构");
    else cell += char;
  }
  if (quoted) throw new Error("CSV 引号未闭合");
  finishRow();
  const header = rows.shift() || [];
  if (header.length !== 3 || header.join(",") !== "id,source,translation") throw new Error("CSV 表头必须为 id,source,translation");
  const parsed: TranslationRow[] = [], issues: UnityTranslationImportIssue[] = [];
  rows.forEach((values, index) => {
    if (values.length !== 3) issues.push({ id: `CSV 第 ${index + 2} 行`, source: values[1] || "", translation: values[2] || "", reason: "必须包含 id、source、translation 三列" });
    else parsed.push({ id: values[0], source: values[1], translation: values[2] });
  });
  if (issues.length) throw new UnityTranslationImportError(issues, rows.length);
  return parsed;
}

export function readUnityTranslationRows(entries: UnityEntry[], contents: string, csv: boolean): TranslationRow[] {
  const text = contents.replace(/^\uFEFF/, "");
  let rows: unknown;
  if (csv) rows = readCsv(text);
  else {
    const data = JSON.parse(text);
    if (!data || data.kind !== kind || data.version !== 1) throw new Error("请选择导出的 Unity 翻译文件（JSON 或 CSV）");
    rows = data.entries;
  }
  if (!Array.isArray(rows) || !rows.length) throw new Error("翻译文件没有条目");
  const originals = new Map(entries.map(entry => [entry.id, entry]));
  const replacements = new Map<string, string>();
  const issues: UnityTranslationImportIssue[] = [];
  for (const [index, value] of rows.entries()) {
    if (!value || typeof value.id !== "string" || typeof value.source !== "string" || typeof value.translation !== "string") {
      issues.push({ id: `第 ${index + 1} 行`, source: "", translation: "", reason: "每个条目必须包含字符串 id、source 和 translation" }); continue;
    }
    if (replacements.has(value.id)) issues.push({ ...value, reason: "条目标识重复" });
    const original = originals.get(value.id);
    if (!original || original.source !== value.source) issues.push({ ...value, reason: "与当前工程不匹配，请勿修改 id 或 source" });
    replacements.set(value.id, value.translation);
  }
  if (issues.length) throw new UnityTranslationImportError(issues, rows.length);
  return rows as TranslationRow[];
}

export function applyUnityTranslationRows(entries: UnityEntry[], rows: TranslationRow[], validate: (source: string, translation: string) => string, options: ImportOptions = {}) {
  const replacements = new Map(rows.map(row => [row.id, row.translation]));
  const mode = options.mode || "fill";
  const issues: UnityTranslationImportIssue[] = [];
  let changed = 0, cleared = 0, skippedEmpty = 0, preservedExisting = 0;
  const next = entries.map(entry => {
    const provided = replacements.get(entry.id);
    if (provided === undefined) return entry;
    const translation = provided.trim() ? provided : "";
    if (!translation && !(mode === "replace" && options.allowClear)) { skippedEmpty++; return entry; }
    if (mode === "fill" && (entry.translation.trim() || entry.layoutDraft?.trim())) { preservedExisting++; return entry; }
    const problem = translation ? validate(entry.source, translation) : "";
    if (problem) { issues.push({ id: entry.id, source: entry.source, translation, reason: problem }); return entry; }
    if (translation === entry.translation && !(translation === "" && entry.layoutDraft)) return entry;
    changed++;
    if (!translation.trim()) cleared++;
    return { ...entry, translation, error: "", layoutDraft: undefined };
  });
  if (issues.length) throw new UnityTranslationImportError(issues, rows.length);
  return { entries: next, matched: replacements.size, changed, cleared, skippedEmpty, preservedExisting, unchanged: replacements.size - changed, remaining: entries.length - replacements.size };
}

export function importUnityTranslations(entries: UnityEntry[], contents: string, csv: boolean, validate: (source: string, translation: string) => string, options: ImportOptions = {}) {
  return applyUnityTranslationRows(entries, readUnityTranslationRows(entries, contents, csv), validate, options);
}
