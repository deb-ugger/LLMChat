import type { AssDocument, SrtCue } from "./subtitle";
import type { TransEntry } from "./textTranslate";

/** One utterance may span multiple subtitle cues; translate as a group, write back per cue. */
export type SubtitleCueGroup = {
  id: string;
  entryIds: string[];
  sources: string[];
  /** Relative lengths for proportional fallback split */
  sourceLens: number[];
};

const SENTENCE_END = /[.!?…。！？]["'”’」』）)\]]*\s*$/u;
const WEAK_BREAK = /[,，、:：;；—–\-]\s*$/u;

export function srtTimeToMs(t: string): number {
  const m = t
    .trim()
    .replace(",", ".")
    .match(/(\d+):(\d+):(\d+)[.,](\d+)/);
  if (!m) return 0;
  const ms = m[4].padEnd(3, "0").slice(0, 3);
  return (
    (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 +
    Number(ms)
  );
}

/** ASS time H:MM:SS.cs (centiseconds) or similar. */
export function assTimeToMs(t: string): number {
  const m = t.trim().match(/(\d+):(\d+):(\d+)[.,](\d+)/);
  if (!m) return 0;
  const frac = m[4];
  const ms =
    frac.length <= 2
      ? Number(frac.padEnd(2, "0").slice(0, 2)) * 10
      : Number(frac.padEnd(3, "0").slice(0, 3));
  return (
    (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + ms
  );
}

function plainSubtitleText(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\[nNh]/g, "\n")
    .trim();
}

function endsCompleteSentence(text: string): boolean {
  const t = plainSubtitleText(text).replace(/\s+/g, " ");
  if (!t) return true;
  return SENTENCE_END.test(t);
}

function endsWeakBreak(text: string): boolean {
  return WEAK_BREAK.test(plainSubtitleText(text));
}

function parseAssStartEnd(prefix: string): { start: number; end: number } | null {
  // Dialogue: Layer,Start,End,...
  const m = prefix.match(
    /^Dialogue:\s*[^,]*,\s*([^,]+),\s*([^,]+),/i,
  );
  if (!m) return null;
  return { start: assTimeToMs(m[1]), end: assTimeToMs(m[2]) };
}

function shouldMergeWithNext(
  prevText: string,
  nextText: string,
  gapMs: number | null,
): boolean {
  if (!plainSubtitleText(prevText) || !plainSubtitleText(nextText)) return false;
  if (endsCompleteSentence(prevText)) return false;
  // Incomplete previous line → usually continues
  if (endsWeakBreak(prevText)) return true;
  // Tight timing (overlap or < 0.8s gap) and no sentence end
  if (gapMs != null && gapMs <= 800) return true;
  // Short previous fragment without terminal punctuation
  const prevPlain = plainSubtitleText(prevText);
  if (prevPlain.length > 0 && prevPlain.length <= 42 && !SENTENCE_END.test(prevPlain)) {
    return true;
  }
  return false;
}

/**
 * Group consecutive subtitle entries into utterance units (Scheme B).
 * Timing is never changed — groups only affect translate/batching.
 */
export function buildSubtitleCueGroups(
  entries: TransEntry[],
  format: "srt" | "ass",
  meta?: { srtCues?: SrtCue[]; assDoc?: AssDocument },
): SubtitleCueGroup[] {
  const ordered = [...entries].sort(
    (a, b) => (a.metaIndex ?? 0) - (b.metaIndex ?? 0),
  );
  const groups: SubtitleCueGroup[] = [];
  let buf: TransEntry[] = [];

  const flush = () => {
    if (!buf.length) return;
    const sources = buf.map((e) => e.src);
    groups.push({
      id: `grp-${buf[0].id}`,
      entryIds: buf.map((e) => e.id),
      sources,
      sourceLens: sources.map((s) => Math.max(1, plainSubtitleText(s).length)),
    });
    buf = [];
  };

  const timingOf = (
    e: TransEntry,
  ): { start: number; end: number } | null => {
    const idx = e.metaIndex ?? -1;
    if (idx < 0) return null;
    if (format === "srt" && meta?.srtCues?.[idx]) {
      const c = meta.srtCues[idx];
      return { start: srtTimeToMs(c.start), end: srtTimeToMs(c.end) };
    }
    if (format === "ass" && meta?.assDoc?.dialogues?.[idx]) {
      return parseAssStartEnd(meta.assDoc.dialogues[idx].prefix);
    }
    return null;
  };

  for (let i = 0; i < ordered.length; i++) {
    const cur = ordered[i];
    if (!buf.length) {
      buf = [cur];
      continue;
    }
    const prev = buf[buf.length - 1];
    const prevT = timingOf(prev);
    const curT = timingOf(cur);
    let gap: number | null = null;
    if (prevT && curT) gap = Math.max(0, curT.start - prevT.end);

    // Only merge adjacent meta indexes
    const prevIdx = prev.metaIndex ?? -1;
    const curIdx = cur.metaIndex ?? -1;
    const adjacent = curIdx === prevIdx + 1;

    if (
      adjacent &&
      shouldMergeWithNext(prev.src, cur.src, gap)
    ) {
      buf.push(cur);
    } else {
      flush();
      buf = [cur];
    }
  }
  flush();
  return groups;
}

/** Split model output into N cue lines; fall back to length-proportional cut. */
export function splitGroupTranslation(
  raw: string,
  n: number,
  sourceLens: number[],
): string[] {
  const cleaned = raw.replace(/^\uFEFF/, "").trim();
  if (n <= 1) return [cleaned];

  const stripNum = (s: string) =>
    s.replace(/^\s*(?:\[?\d+\]?[.:)、]\s*|第\s*\d+\s*[行条]:\s*)/u, "").trim();

  const bySep = cleaned
    .split(/\n\s*-{3,}\s*\n/)
    .map((s) => stripNum(s))
    .filter((s) => s.length > 0);
  if (bySep.length === n) return bySep;

  const byLine = cleaned
    .split(/\n+/)
    .map((s) => stripNum(s))
    .filter((s) => s.length > 0);
  if (byLine.length === n) return byLine;

  // Proportional character split on flattened text
  const flat = byLine.join("") || cleaned.replace(/\s+/g, "");
  const total = sourceLens.reduce((a, b) => a + b, 0) || n;
  const parts: string[] = [];
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    if (i === n - 1) {
      parts.push(flat.slice(cursor).trim() || flat.slice(cursor));
      break;
    }
    const take = Math.max(
      1,
      Math.round((sourceLens[i] / total) * flat.length),
    );
    let end = Math.min(flat.length, cursor + take);
    // Prefer break near punctuation
    const window = flat.slice(cursor, Math.min(flat.length, end + 8));
    const m = window.match(/^[\s\S]*?[，。！？、；：,.!?;]/);
    if (m && m[0].length >= take * 0.5) {
      end = cursor + m[0].length;
    }
    parts.push(flat.slice(cursor, end).trim());
    cursor = end;
  }
  while (parts.length < n) parts.push("");
  return parts.slice(0, n);
}

export function buildGroupTranslatePayload(
  sources: string[],
  basePrompt: string,
): { text: string; prompt: string } {
  const n = sources.length;
  if (n <= 1) {
    return { text: sources[0] || "", prompt: basePrompt };
  }
  const text = sources.map((s, i) => `[${i + 1}] ${s}`).join("\n");
  const prompt =
    `${basePrompt.trim()}\n\n` +
    `The ${n} numbered lines below are ONE spoken utterance split across subtitle cues. ` +
    `Translate them as a coherent whole for the target language, then split the translation ` +
    `back into exactly ${n} subtitle lines (same order, similar relative length). ` +
    `Output ONLY the ${n} translated lines, each on its own line. ` +
    `Do not include numbers, labels, quotes, or explanations.`;
  return { text, prompt };
}
