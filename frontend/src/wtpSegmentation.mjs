// WtP BERT Mini character hashing and overlapping inference windows.
// Follows wtpsplit's hash_encode/extract; offsets always refer to original UTF-16.
const primes = [31, 43, 59, 61, 73, 97, 103, 113];
const protectedToken = /\{[^{}\r\n]+\}|%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?[sdifouxXeEgGc%]|<\/?[^>\r\n]+>|\\[nrt]/g;

export function wtpHashes(text) {
  return BigInt64Array.from(Array.from(text).flatMap(char =>
    primes.map(prime => BigInt(((char.codePointAt(0) + 1) * prime) % 8192))));
}

export async function predictWtpBoundaries(text, infer, threshold = 0.01) {
  const chars = Array.from(text), sums = new Float64Array(chars.length), counts = new Uint16Array(chars.length);
  if (!chars.length) return [];
  for (let start = 0; ;) {
    const end = Math.min(start + 512, chars.length);
    const values = await infer(chars.slice(start, end).join(""));
    if (values.length !== end - start) throw new Error("分段模型返回的字符数量不一致");
    for (let i = start; i < end; i++) {
      if (!Number.isFinite(values[i - start])) throw new Error("分段模型返回了无效边界分数");
      sums[i] += values[i - start]; counts[i]++;
    }
    if (end === chars.length) break;
    start = Math.min(start + 256, chars.length - 512);
  }
  const graphemes = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), part => part.index + part.segment.length));
  const protectedSpans = Array.from(text.matchAll(protectedToken), match => [match.index, match.index + match[0].length]);
  const ends = []; let offset = 0;
  chars.forEach((char, i) => {
    offset += char.length;
    const probability = 1 / (1 + Math.exp(-sums[i] / counts[i]));
    if (probability >= threshold && graphemes.has(offset) && !protectedSpans.some(([start, end]) => offset > start && offset < end)) ends.push(offset);
  });
  if (ends.at(-1) !== text.length) ends.push(text.length);
  return ends;
}
