export type BatchTextItem = { id: string; text: string; prompt: string; context: { source: string; translation: string }[] };
export function decodeTextBatch(raw: string, expected: string[]) {
  const rows: unknown = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  if (!Array.isArray(rows) || rows.length !== expected.length) throw new Error("批量译文条目数量不匹配");
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || typeof row.translation !== "string" || !expected.includes(row.id) || result.has(row.id)) throw new Error("批量译文编号不匹配或重复");
    result.set(row.id, row.translation);
  }
  return result;
}
export function estimateTextTokens(text: string) { return Math.ceil([...text].reduce((count, char) => count + (/[^\x00-\x7f]/.test(char) ? 1 : 0.25), 0)); }
/** The module owns only text-project request batches; callers own persistence. */
export function createTextBatchClient(request: (items: BatchTextItem[]) => Promise<Map<string, string>>, tokenBudget: number, concurrency: number, signal: AbortSignal) {
  type Pending = { item: BatchTextItem; resolve: (text: string) => void; reject: (error: unknown) => void };
  const pending: Pending[] = [];
  let running = 0, scheduled = false;
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
      void request(batch.map(row => row.item)).then(result => {
        signal.throwIfAborted();
        for (const row of batch) { if (!result.has(row.item.id)) throw new Error("批量译文缺少条目编号"); }
        batch.forEach(row => row.resolve(result.get(row.item.id)!));
      }).catch(error => batch.forEach(row => row.reject(error))).finally(() => { running--; drain(); });
    }
  };
  return (item: BatchTextItem) => new Promise<string>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    pending.push({ item, resolve, reject });
    if (!scheduled) { scheduled = true; queueMicrotask(drain); }
  });
}
