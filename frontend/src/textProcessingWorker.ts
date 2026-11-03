import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { parseEpub, parseMarkdown, parseVtt, restoreEpub, restoreTextRanges } from "./textProjectFormats";
import { checkTextTranslation, entriesToManualTransJson, parseManualTransFile } from "./textTranslate";
import { serializeSrt, serializeAss, parseSrt, parseAss } from "./subtitle";
import type { TextJob } from "./textProcessing";

Object.assign(globalThis, { DOMParser, XMLSerializer });

export async function processTextJob(job: TextJob) {
  if (job.kind === "parse") {
    if (job.format === "epub") return parseEpub(job.input as Uint8Array);
    const input = job.input as string;
    if (job.format === "json") return parseManualTransFile(input);
    if (job.format === "srt") return parseSrt(input);
    if (job.format === "ass") return parseAss(input);
    return job.format === "vtt" ? parseVtt(input) : parseMarkdown(input);
  }
  const p = job.project;
  if (job.kind === "check") {
    const ids = job.ids ? new Set(job.ids) : null;
    return p.entries.filter(entry => entry.status !== "skipped" && (ids ? ids.has(entry.id) : !!entry.dst)).map(entry => ({ id: entry.id, ...checkTextTranslation(entry.src, entry.dst, p.glossary, { sourceLang: p.sourceLang, targetLang: p.targetLang, format: p.format, protection: p.translationOptions?.protection }) }));
  }
  if (p.format === "epub") {
    if (!p.sourceMeta?.epub) throw new Error("工程缺少 EPUB 原始资源");
    return restoreEpub(p.sourceMeta.epub, p.entries, job.attachment);
  }
  if (p.format === "markdown" || p.format === "vtt") {
    if (!p.sourceMeta?.textRanges) throw new Error("工程缺少原始文档结构");
    return restoreTextRanges(p.sourceMeta.textRanges, p.entries);
  }
  const byIndex = new Map(p.entries.map(entry => [entry.metaIndex, entry]));
  if (p.format === "srt") return serializeSrt(p.sourceMeta?.srtCues?.map((cue, index) => {
    const entry = byIndex.get(index); return { ...cue, text: entry?.status === "skipped" ? cue.text : entry?.dst || entry?.src || cue.text };
  }) ?? p.entries.map((entry, index) => ({ index: index + 1, start: "00:00:00,000", end: "00:00:02,000", text: entry.status === "skipped" ? entry.src : entry.dst || entry.src })));
  if (p.format === "ass") {
    const base = p.sourceMeta?.assDoc;
    const dialogues = base ? base.dialogues.map((dialogue, index) => { const entry = byIndex.get(index); return { ...dialogue, text: entry?.status === "skipped" ? dialogue.text : entry?.dst || entry?.src || dialogue.text }; }) : p.entries.map(entry => ({ prefix: "Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,", text: entry.status === "skipped" ? entry.src : entry.dst || entry.src, rawLine: "" }));
    return serializeAss(base ? { ...base, dialogues } : { header: "[Script Info]\n\n[Events]\n", dialogues, footer: "" });
  }
  if (p.format === "json") return entriesToManualTransJson(p.entries);
  return p.entries.map(entry => entry.dst || entry.src).join("\n\n");
}

self.onmessage = async event => {
  const scope = self as unknown as { postMessage: (message: unknown, transfer?: Transferable[]) => void };
  try {
    const result = await processTextJob(event.data);
    scope.postMessage({ result }, result instanceof Uint8Array ? [result.buffer as ArrayBuffer] : []);
  } catch (error) { scope.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
