import type { UnityEntry, UnityProgress } from "./unityOffline";

type Session = {
  signal: AbortSignal;
  translate: (source: string) => Promise<string>;
  validate: (source: string, translated: string) => string;
  formatFailure: (error: unknown) => string;
  persist: () => Promise<void>;
  progress?: (value: UnityProgress) => void;
};

/** The first needed request is the probe and its valid translation is reused. */
export async function translateUnitySession(entries: UnityEntry[], cache: Map<string, string>, session: Session) {
  const keyOf = (source: string) => source.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  const reused = new Map([...cache].map(([source, translation]) => [keyOf(source), translation]));
  for (const entry of entries) if (entry.translation && !session.validate(entry.source, entry.translation)) reused.set(keyOf(entry.source), entry.translation);
  const groups = new Map<string, UnityEntry[]>();
  for (const entry of entries) if (!entry.translation || session.validate(entry.source, entry.translation)) {
    const key = keyOf(entry.source); const group = groups.get(key) || []; group.push(entry); groups.set(key, group);
  }
  const pending = [...groups];
  let completed = entries.length - pending.reduce((total, [, group]) => total + group.length, 0), processed = 0;
  let consecutive = 0, failures = 0;
  const commit = async ([key, group]: [string, UnityEntry[]]) => {
    const entry = group[0];
    let failure: unknown;
    try {
      const translated = reused.get(key) || await session.translate(entry.source);
      for (const item of group) { const problem = session.validate(item.source, translated); if (problem) throw new Error(problem); }
      for (const item of group) {
        const leading = item.source.match(/^\s*/)?.[0] || "", trailing = item.source.match(/\s*$/)?.[0] || "";
        item.translation = leading + translated.trim() + trailing; item.error = "";
      }
      reused.set(key, translated); cache.set(key, translated); consecutive = 0; completed += group.length;
    } catch (error) {
      if (session.signal.aborted) throw error;
      for (const item of group) item.error = error instanceof Error ? error.message : String(error);
      failure = error; consecutive++; failures++;
    }
    processed++;
    await session.persist(); // Disk failures stop immediately, never become API failures.
    session.progress?.({ detail: `已保存 ${completed} 条译文 · 去重处理 ${processed}/${pending.length} 种原文${failures ? `，本轮失败 ${failures} 种` : ""}`, completed, total: entries.length });
    return failure;
  };
  const probe = pending.find(([key]) => !reused.has(key));
  if (probe && !session.signal.aborted) {
    session.progress?.({ detail: "正在检查翻译服务可用性，成功结果将保存为首条译文", completed, total: entries.length });
    const failure = await commit(probe);
    if (failure) throw new Error(`翻译服务预检失败，未继续批量翻译：${session.formatFailure(failure)} 请检查服务或代理后恢复。`);
  }
  for (const group of pending) {
    if (session.signal.aborted) break;
    if (group === probe) continue;
    session.progress?.({ detail: `处理第 ${processed + 1}/${pending.length} 种原文 · ${group[1].length} 处引用：${group[1][0].file}`, completed, total: entries.length });
    const failure = await commit(group);
    if (failure && (consecutive >= 3 || failures >= 5))
      throw new Error(`翻译已自动停止：${consecutive >= 3 ? "连续 3 次" : "本轮累计 5 次"}请求失败。${session.formatFailure(failure)} 已保存 ${completed} 条译文，修正服务配置后可恢复。`);
  }
}
