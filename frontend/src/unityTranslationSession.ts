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
  const pending = entries.filter(e => !e.translation || session.validate(e.source, e.translation));
  let completed = entries.length - pending.length;
  let consecutive = 0, failures = 0;
  const commit = async (entry: UnityEntry) => {
    let failure: unknown;
    try {
      const translated = cache.get(entry.source) || await session.translate(entry.source);
      const problem = session.validate(entry.source, translated);
      if (problem) throw new Error(problem);
      entry.translation = translated; entry.error = "";
      cache.set(entry.source, translated); consecutive = 0; completed++;
    } catch (error) {
      if (session.signal.aborted) throw error;
      entry.error = error instanceof Error ? error.message : String(error);
      failure = error; consecutive++; failures++;
    }
    await session.persist(); // Disk failures stop immediately, never become API failures.
    session.progress?.({ detail: `已保存 ${completed} 条译文${failures ? `，本轮失败 ${failures} 条` : ""}`, completed, total: entries.length });
    return failure;
  };
  const probe = pending.find(e => !cache.has(e.source));
  if (probe && !session.signal.aborted) {
    session.progress?.({ detail: "正在检查翻译服务可用性，成功结果将保存为首条译文", completed, total: entries.length });
    const failure = await commit(probe);
    if (failure) throw new Error(`翻译服务预检失败，未继续批量翻译：${session.formatFailure(failure)} 请检查服务或代理后恢复。`);
  }
  for (const entry of pending) {
    if (session.signal.aborted) break;
    if (entry === probe) continue;
    session.progress?.({ detail: `翻译第 ${completed + 1} 条：${entry.file}`, completed, total: entries.length });
    const failure = await commit(entry);
    if (failure && (consecutive >= 3 || failures >= 5))
      throw new Error(`翻译已自动停止：${consecutive >= 3 ? "连续 3 次" : "本轮累计 5 次"}请求失败。${session.formatFailure(failure)} 已保存 ${completed} 条译文，修正服务配置后可恢复。`);
  }
}
