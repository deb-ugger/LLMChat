import type { UnityEntry } from "./unityOffline";

type TranslationRow = { id: string; source: string; translation: string };
const kind = "llmchat-unity-translations";

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
  return rows.map((values, index) => {
    if (values.length !== 3) throw new Error(`CSV 第 ${index + 2} 行必须包含三列`);
    return { id: values[0], source: values[1], translation: values[2] };
  });
}

export function importUnityTranslations(entries: UnityEntry[], contents: string, csv: boolean, validate: (source: string, translation: string) => string) {
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
  for (const value of rows) {
    if (!value || typeof value.id !== "string" || typeof value.source !== "string" || typeof value.translation !== "string") throw new Error("每个条目必须包含字符串 id、source 和 translation");
    if (replacements.has(value.id)) throw new Error(`条目标识重复：${value.id}`);
    const original = originals.get(value.id);
    if (!original || original.source !== value.source) throw new Error(`条目 ${value.id} 与当前工程不匹配，请勿修改 id 或 source`);
    const problem = value.translation.trim() ? validate(original.source, value.translation) : "";
    if (problem) throw new Error(`条目 ${value.id}：${problem}`);
    replacements.set(value.id, value.translation);
  }
  let changed = 0, cleared = 0;
  const next = entries.map(entry => {
    const translation = replacements.get(entry.id);
    if (translation === undefined || translation === entry.translation) return entry;
    changed++;
    if (!translation.trim()) cleared++;
    return { ...entry, translation, error: "", layoutDraft: undefined };
  });
  return { entries: next, matched: replacements.size, changed, cleared, unchanged: replacements.size - changed, remaining: entries.length - replacements.size };
}
