import type { UnityEntry } from "./unityOffline";

export type TranslationRow = { id: string; source: string; translation: string; file?: string; container?: string; objectId?: string; locator?: string; locale?: string; localizationKey?: string };
export type MatchedTranslationRows = TranslationRow[] & { issues: UnityTranslationImportIssue[]; remapped: number };
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
  const rows = entries.map(({ id, source, translation, file, container, objectId, locator, locale, localizationKey }) => ({ id, source, translation, file, container, objectId, locator, locale, localizationKey }));
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

export function readUnityTranslationRows(entries: UnityEntry[], contents: string, csv: boolean, partial = false): MatchedTranslationRows {
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
  const seen = new Set<string>();
  const malformed: UnityTranslationImportIssue[] = [];
  const incoming: TranslationRow[] = [];
  for (const [index, value] of rows.entries()) {
    if (!value || typeof value.id !== "string" || typeof value.source !== "string" || typeof value.translation !== "string") {
      malformed.push({ id: `第 ${index + 1} 行`, source: "", translation: "", reason: "每个条目必须包含字符串 id、source 和 translation" }); continue;
    }
    if (seen.has(value.id)) malformed.push({ ...value, reason: "条目标识重复" });
    seen.add(value.id); incoming.push(value);
  }
  if (malformed.length) throw new UnityTranslationImportError(malformed, rows.length);
  const incomingIds = new Map(incoming.map(row => [row.id, row]));
  const stableIds = incoming.every(row => originals.get(row.id)?.source === row.source);
  const bySource = new Map<string, TranslationRow[]>();
  for (const row of incoming) { const list = bySource.get(row.source); if (list) list.push(row); else bySource.set(row.source, [row]); }
  const identity = (row: TranslationRow) => typeof row.file === "string" && typeof row.container === "string" && typeof row.objectId === "string" && typeof row.locator === "string"
    ? JSON.stringify([row.file.replaceAll("\\", "/"), row.container, row.objectId, row.locator, row.source]) : null;
  const positioned = new Map<string, TranslationRow[]>();
  for (const row of incoming) { const key = identity(row); if (key) { const list = positioned.get(key); if (list) list.push(row); else positioned.set(key, [row]); } }
  const issues: UnityTranslationImportIssue[] = [], matched: TranslationRow[] = [];
  let remapped = 0;
  const resolved = new Map<TranslationRow[], { choices: Set<string>; ids: Set<string> }>();
  for (const entry of entries) {
    const candidateId = incomingIds.get(entry.id);
    const sameId = candidateId?.source === entry.source ? candidateId : undefined;
    const location = identity(entry); const exact = location ? positioned.get(location) : undefined;
    const candidates = exact?.length ? exact : stableIds && sameId ? [sameId] : bySource.get(entry.source);
    if (!candidates?.length) continue;
    // Ignore blank duplicates when a valid translation is present. Never choose
    // arbitrarily between different translations of the same original.
    let group = resolved.get(candidates);
    if (!group) {
      const nonempty = candidates.filter(row => row.translation.trim());
      if (!nonempty.length && !exact?.length && !stableIds) continue;
      const usable = nonempty.length ? nonempty : candidates;
      group = { choices: new Set(usable.map(row => row.translation)), ids: new Set(usable.map(row => row.id)) }; resolved.set(candidates, group);
    }
    const { choices, ids } = group;
    if (choices.size !== 1) { issues.push({ id: entry.id, source: entry.source, translation: [...choices].map((text, index) => `候选 ${index + 1}：${text}`).join("\n\n"), reason: `同一原文存在 ${choices.size} 个不同译文，缺少可唯一匹配的定位；已跳过，请比较候选后手动填写` }); continue; }
    const translation = choices.values().next().value!;
    matched.push({ id: entry.id, source: entry.source, translation });
    if (!ids.has(entry.id)) remapped++;
  }
  const sourceSet = new Set(entries.map(entry => entry.source));
  for (const row of incoming) if (row.translation.trim() && !sourceSet.has(row.source)) issues.push({ ...row, id: `旧条目 ${row.id}`, reason: "当前扫描中没有此原文，已保留导入文件中的译文" });
  if (!matched.length && !issues.length) issues.push({ id: "导入文件", source: "", translation: "", reason: "没有匹配到当前工程的原文" });
  if (!partial && issues.length) throw new UnityTranslationImportError(issues, incoming.length);
  return Object.assign(matched, { issues, remapped });

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
