export type BatchTextItem = { id: string; text: string; prompt: string; context: { source: string; translation: string }[] };
export class TextBatchFormatError extends Error {}
export function decodeTextBatch(raw: string, expected: string[]) {
  let rows: unknown;
  try { rows = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); }
  catch { throw new TextBatchFormatError("批量译文不是有效 JSON"); }
  if (!Array.isArray(rows)) throw new TextBatchFormatError("批量译文不是数组");
  const result = new Map<string, string>();
  const seen = new Set<string>(), wanted = new Set(expected);
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !wanted.has(row.id)) continue;
    if (seen.has(row.id)) { result.delete(row.id); continue; }
    seen.add(row.id);
    if (typeof row.translation === "string" && row.translation.trim()) result.set(row.id, row.translation);
  }
  return result;
}
export function estimateTextTokens(text: string) { return Math.ceil([...text].reduce((count, char) => count + (/[^\x00-\x7f]/.test(char) ? 1 : 0.25), 0)); }
/** Structured translation batching only; callers own module state and persistence. */
export function createTextBatchClient(request: (items: BatchTextItem[]) => Promise<Map<string, string>>, tokenBudget: number, concurrency: number, signal: AbortSignal) {
  type Pending = { item: BatchTextItem; resolve: (text: string) => void; reject: (error: unknown) => void };
  const pending: Pending[] = [];
  let running = 0, scheduled = false;
  const deliver = async (batch: Pending[], retryMissing = true): Promise<void> => {
    try {
      const result = await request(batch.map(row => row.item));
      signal.throwIfAborted();
      const missing: Pending[] = [];
      for (const row of batch) {
        const text = result.get(row.item.id);
        if (text !== undefined) row.resolve(text);
        else if (retryMissing && batch.length > 1) missing.push(row);
        else row.reject(new Error(`批量译文缺少有效条目：${row.item.id}`));
      }
      for (const row of missing) {
        if (signal.aborted) row.reject(signal.reason);
        else await deliver([row], false);
      }
    } catch (error) {
      if (error instanceof TextBatchFormatError && batch.length > 1 && !signal.aborted) {
        const middle = Math.ceil(batch.length / 2);
        await deliver(batch.slice(0, middle), false);
        if (!signal.aborted) await deliver(batch.slice(middle), false);
        else batch.slice(middle).forEach(row => row.reject(signal.reason));
      } else batch.forEach(row => row.reject(error));
    }
  };
  const drain = () => {
    scheduled = false;
    if (signal.aborted) { pending.splice(0).forEach(item => item.reject(signal.reason)); return; }
    while (running < concurrency && pending.length) {
      const batch: Pending[] = []; let tokens = 0;
      while (pending.length && batch.length < 8) {
        const next = pending[0], size = estimateTextTokens(JSON.stringify(next.item));
        if (batch.length && tokens + size > tokenBudget) break;
        batch.push(pending.shift()!); tokens += size;
      }
      running++;
      void deliver(batch).finally(() => { running--; drain(); });
    }
  };
  signal.addEventListener("abort",()=>pending.splice(0).forEach(item=>item.reject(signal.reason)),{once:true});
  return (item: BatchTextItem) => new Promise<string>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    pending.push({ item, resolve, reject });
    if (!scheduled) { scheduled = true; queueMicrotask(drain); }
  });
}
