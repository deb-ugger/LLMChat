import type { UnityLinePlan } from "./unityLineLayout";

// Keep explicit paragraph/list boundaries. Never infer ownership from text length.
type Marker = { key: string; start: number };
const numbered = /(?:[0-9０-９]{1,3}[.．、)）](?![0-9０-９])|[①-⑳]|[・•●■□◆◇*])/gu;
function key(text: string) {
  const value = text.normalize("NFKC");
  if (/^[・•●■□◆◇*]$/.test(value)) return "bullet";
  return value.match(/^\d+/)?.[0] || value;
}
function sourceMarkers(text: string): Marker[] {
  const markers: Marker[] = []; let offset = 0;
  for (const line of text.split(/(?<=\n)|(?<=\r)(?!\n)/)) {
    const match = /^[\t \u3000]*([0-9０-９]{1,3}[.．、)）](?![0-9０-９])|[①-⑳]|[・•●■□◆◇*])/u.exec(line);
    if (match) markers.push({ key: key(match[1]), start: offset });
    offset += line.length;
  }
  return markers;
}
function isList(markers: Marker[]) {
  return markers.length > 1 && (markers.every(m => m.key === "bullet") || markers.every((m, i) => /^\d+$/.test(m.key) && (!i || Number(m.key) === Number(markers[i - 1].key) + 1)));
}
function paragraphs(text: string) {
  const starts = [0]; let offset = 0, content = false, blank = false;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!match[0]) continue;
    if (match[0].trim()) {
      if (content && blank) starts.push(offset);
      content = true; blank = false;
    } else if (content) blank = true;
    offset += match[0].length;
  }
  return starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length));
}
function sourceBlocks(source: string) {
  // Keep explicit paragraph boundaries; join display wrapping only inside each block.
  const markers = sourceMarkers(source);
  const numberedList = isList(markers);
  const starts = new Set([0, source.length]);
  if (numberedList) markers.forEach(m => starts.add(m.start));
  let offset = 0;
  for (const paragraph of paragraphs(source)) { starts.add(offset); offset += paragraph.length; }
  const offsets = [...starts].sort((a, b) => a - b);
  return offsets.slice(0, -1).map((start, i) => source.slice(start, offsets[i + 1]));
}
export function prepareUnityStructuredText(source: string, flatten: (text: string) => string) {
  return sourceBlocks(source).map(flatten).filter(Boolean).join("\n\n");
}
export async function translateUnityStructuredText(source: string, translate: (source: string) => Promise<string>) {
  const blocks = sourceBlocks(source).filter(block => block.trim());
  if (blocks.length <= 1) return translate(source);
  const translated: string[] = [];
  for (const block of blocks) {
    const result = flatten(await translate(block.trim()));
    if (!result) throw new Error("译文段落为空");
    translated.push(result);
  }
  return translated.join("\n\n");
}
export function unityListBlocks(source: string, translation: string) {
  const original = sourceMarkers(source);
  if (!isList(original)) return null;
  const translated: Marker[] = [];
  const bullets = original[0].key === "bullet";
  const pattern = bullets ? /[・·•*]|(?:^|(?<=\s))[-●■□◆◇](?=\s)/gu : numbered;
  for (const match of translation.matchAll(pattern)) {
    if (!bullets && key(match[0]) === "bullet") continue;
    // A decimal, date, identifier or sentence-internal number is not a list marker.
    if (!bullets && match.index && !/[\s。！？!?；;]/u.test(translation[match.index - 1])) continue;
    translated.push({ key: bullets ? "bullet" : key(match[0]), start: match.index });
  }
  if (translated.length !== original.length || original.some((m, i) => m.key !== translated[i].key))
    throw new Error("译文编号与原文条目无法对应，请检查编号及条目顺序；译文草稿已保留。");
  if (!!source.slice(0, original[0].start).trim() !== !!translation.slice(0, translated[0].start).trim())
    throw new Error("译文列表前的说明无法对应，请手动确认段落；译文草稿已保留。");
  const preamble = !!source.slice(0, original[0].start).trim();
  const starts = [0, ...original.slice(preamble ? 0 : 1).map(m => m.start), source.length];
  const targets = [0, ...translated.slice(preamble ? 0 : 1).map(m => m.start), translation.length];
  return starts.slice(0, -1).map((start, i) => ({ source: source.slice(start, starts[i + 1]), translation: translation.slice(targets[i], targets[i + 1]).trim() }));
}
function flatten(translation: string) {
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f]/u;
  return translation.split(/\r\n|\r|\n/).map(s => s.trim()).filter(Boolean).reduce((body, part) => body + (!body || cjk.test([...body].at(-1)!) && cjk.test([...part][0]) ? "" : " ") + part, "");
}
function structureBlocks(source: string, translation: string) {
  const flat = flatten(translation);
  const blocks = unityListBlocks(source, translation);
  if (blocks) return blocks;
  const original = paragraphs(source);
  if (original.length <= 1) return null;
  // These repeated paragraph markers can recover a boundary misplaced by older reflow.
  if (original.every(part => /^[\s]*[〇○](?![〇○])/.test(part))) {
    const markers = [...flat.matchAll(/(?<![〇○])[〇○](?![〇○])/g)];
    if (markers.length !== original.length || flat.slice(0, markers[0]?.index).trim())
      throw new Error("译文段落标记与原文无法对应，请检查分段；译文草稿已保留。");
    return original.map((part, i) => ({ source: part, translation: flat.slice(markers[i].index, markers[i + 1]?.index).trim() }));
  }
  const translated = paragraphs(translation);
  if (translated.length !== original.length)
    throw new Error("译文段落数量与原文不同，请保留空行分段后重试；译文草稿已保留。");
  return original.map((part, i) => ({ source: part, translation: translated[i].trim() }));
}
export function formatUnityStructure(source: string, translation: string, format: (source: string, translation: string) => string): string {
  const blocks = structureBlocks(source, translation);
  return blocks ? blocks.map(block => formatUnityStructure(block.source, block.translation, format)).join("") : format(source, flatten(translation));
}
export function canReuseUnityStructuredDraft(source: string, translation: string) {
  try { formatUnityStructure(source, translation, (_source, text) => text); return true; } catch { return false; }
}
export function planUnityStructuredLines(source: string, translation: string, plan: (source: string, translation: string) => UnityLinePlan): UnityLinePlan {
  const blocks = structureBlocks(source, translation);
  if (!blocks) return plan(source, translation);
  const result: UnityLinePlan = { layout: [], slots: [], units: [], candidates: [], breaks: [] };
  blocks.forEach((block, i) => {
    const sub = planUnityStructuredLines(block.source, block.translation, plan), offset = result.units.length;
    const layoutOffset = result.layout.length;
    result.layout.push(...sub.layout);
    result.slots.push(...sub.slots.map(slot => slot + layoutOffset));
    result.units.push(...sub.units);
    result.candidates.push(...sub.candidates.map(points => points.map(point => point + offset)));
    result.breaks.push(...sub.breaks.map(point => point + offset));
    if (i < blocks.length - 1) { result.candidates.push([result.units.length]); result.breaks.push(result.units.length); }
  });
  return result;
}
