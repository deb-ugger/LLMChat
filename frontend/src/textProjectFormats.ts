import JSZip from "jszip";
import type { TransEntry } from "./textTranslate";

export type TextRanges = { original: string; ranges: { start: number; end: number }[] };
export type EpubSource = { archive: string; documents: string[] };
const entry = (id: string, src: string, metaIndex: number): TransEntry => ({ id, src, dst: "", status: "pending", metaIndex });

export function parseVtt(original: string) {
  const ranges: TextRanges["ranges"] = [];
  const blocks = original.split(/(\r?\n[ \t]*\r?\n)/);
  let offset = 0;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (index % 2 === 0 && !/^(?:\uFEFF?WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(block)) {
      const timing = block.match(/^(?:[^\r\n]+\r?\n)?(?:\d{2}:)?\d{2}:\d{2}\.\d{3}[ \t]+-->[ \t]+(?:\d{2}:)?\d{2}:\d{2}\.\d{3}[^\r\n]*\r?\n/);
      if (timing) ranges.push({ start: offset + timing[0].length, end: offset + block.replace(/[\r\n]+$/, "").length });
    }
    offset += block.length;
  }
  if (!/^\uFEFF?WEBVTT(?:\s|$)/.test(original) || !ranges.length) throw new Error("未能解析 WebVTT 字幕");
  return { metadata: { original, ranges }, entries: ranges.map((range, i) => entry(`vtt-${i}`, original.slice(range.start, range.end), i)) };
}

export function parseMarkdown(original: string) {
  const ranges: TextRanges["ranges"] = [];
  let offset = 0, fence = "", frontMatter = false;
  for (const line of original.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || []) {
    const text = line.replace(/[\r\n]+$/, "");
    if ((offset === 0 && /^\uFEFF?---\s*$/.test(text)) || frontMatter) {
      if (offset === 0) frontMatter = true;
      else if (/^(---|\.\.\.)\s*$/.test(text)) frontMatter = false;
      offset += line.length; continue;
    }
    const marker = text.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = ""; }
    else if (!fence && text.trim() && !/^( {4}|\t)/.test(text) && !/^\s*(?:[-*_]\s*){3,}$/.test(text) && !/^\s*\[[^\]]+\]:/.test(text)) {
      const prefix = text.match(/^\s*(?:(?:#{1,6}|[-*+]|\d+[.)]|>)\s+)*/)?.[0] || "";
      if (text.slice(prefix.length).trim()) ranges.push({ start: offset + prefix.length, end: offset + text.length });
    }
    offset += line.length;
  }
  return { metadata: { original, ranges }, entries: ranges.map((range, i) => entry(`md-${i}`, original.slice(range.start, range.end), i)) };
}

export function restoreTextRanges(metadata: TextRanges, entries: TransEntry[]) {
  const byIndex = new Map(entries.map(item => [item.metaIndex, item]));
  let text = metadata.original;
  for (let i = metadata.ranges.length - 1; i >= 0; i--) {
    const item = byIndex.get(i), range = metadata.ranges[i];
    if (item?.dst && item.status !== "error" && item.status !== "skipped") text = text.slice(0, range.start) + item.dst + text.slice(range.end);
  }
  return text;
}

export function protectMarkdown(text: string) {
  const protectedParts: string[] = [];
  const token = (part: string) => `⟦MD${protectedParts.push(part) - 1}⟧`;
  const prepared = text.replace(/`+[^`\r\n]*`+|!?\[[^\]]*\]\([^\r\n)]*\)|https?:\/\/[^\s]+|\|+|\*{1,3}|_{1,3}/g, part => {
    const link = part.match(/^(!?\[)([^\]]*)(\]\([^]*\))$/);
    return link ? token(link[1]) + link[2] + token(link[3]) : token(part);
  });
  return { text: prepared, restore(translated: string) {
    for (let i = 0; i < protectedParts.length; i++) if (translated.split(`⟦MD${i}⟧`).length !== 2) throw new Error("Markdown 保护片段丢失或重复，请重译该条目");
    return translated.replace(/⟦MD(\d+)⟧/g, (_, index: string) => { if (!(Number(index) in protectedParts)) throw new Error("Markdown 返回了未知保护片段"); return protectedParts[Number(index)]; });
  } };
}

function xml(source: string) {
  const document = new DOMParser().parseFromString(source, "application/xml");
  if (document.getElementsByTagName("parsererror").length) throw new Error("EPUB XML 格式无效");
  return document;
}
const elements = (document: Document, name: string) => Array.from(document.getElementsByTagName("*")).filter(element => element.localName === name);
function textNodes(document: Document) {
  const result: Text[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === 1 && /^(script|style|code|pre|kbd|samp|svg|math)$/i.test((node as Element).localName)) return;
    if (node.nodeType === 3 && node.nodeValue?.trim()) result.push(node as Text);
    else for (const child of Array.from(node.childNodes)) visit(child);
  };
  const body = elements(document, "body")[0];
  if (body) visit(body);
  return result;
}
function base64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
export async function parseEpub(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (path: string) => { const file = zip.file(path); if (!file) throw new Error(`EPUB 缺少文件：${path}`); return file.async("string"); };
  const container = xml(await read("META-INF/container.xml"));
  const opfPath = elements(container, "rootfile")[0]?.getAttribute("full-path");
  if (!opfPath) throw new Error("EPUB 缺少内容清单");
  const opf = xml(await read(opfPath));
  const manifest = new Map(elements(opf, "item").map(item => [item.getAttribute("id"), item]));
  const documents: string[] = [], entries: TransEntry[] = [];
  for (const reference of elements(opf, "itemref")) {
    const item = manifest.get(reference.getAttribute("idref"));
    if (!item || item.getAttribute("media-type") !== "application/xhtml+xml") continue;
    const path = decodeURIComponent(new URL(item.getAttribute("href")!, `https://epub.local/${opfPath}`).pathname.slice(1));
    documents.push(path);
    const document = xml(await read(path));
    textNodes(document).forEach((node, index) => entries.push({ ...entry(`epub-${entries.length}`, node.nodeValue!.trim(), index), documentPath: path, context: node.parentNode?.textContent?.trim() }));
  }
  if (!entries.length) throw new Error("EPUB 中没有可翻译正文");
  return { metadata: { archive: base64(bytes), documents }, entries };
}
export async function restoreEpub(metadata: EpubSource, entries: TransEntry[]) {
  const zip = await JSZip.loadAsync(metadata.archive, { base64: true });
  for (const path of metadata.documents) {
    const file = zip.file(path);
    if (!file) throw new Error(`EPUB 缺少原始章节：${path}`);
    const document = xml(await file.async("string")), nodes = textNodes(document);
    for (const item of entries.filter(item => item.documentPath === path)) {
      if (!item.dst || item.status === "error" || item.status === "skipped") continue;
      const node = nodes[item.metaIndex!];
      if (!node) throw new Error(`EPUB 正文定位失效：${item.id}`);
      node.nodeValue = (node.nodeValue?.match(/^\s*/)?.[0] || "") + item.dst + (node.nodeValue?.match(/\s*$/)?.[0] || "");
    }
    zip.file(path, new XMLSerializer().serializeToString(document));
  }
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
