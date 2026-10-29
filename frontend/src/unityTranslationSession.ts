import type { UnityEntry, UnityProgress, UnityTranslationActivity } from "./unityOffline";
export type UnityTranslationQueue = {
  status: (id: string) => "pending" | "active" | "failed" | "done" | "not-in-task";
  retry: (id: string) => boolean;
};

type Session = {
  references?: UnityEntry[];
  key?: (entry: UnityEntry) => string;
  signal: AbortSignal;
  concurrency?: number;
  translate: (source: string, entry?: UnityEntry) => Promise<string>;
  format?: (source: string, translated: string) => string | Promise<string>;
  retainDraft?: boolean;
  persistDraftBeforeFormat?: boolean;
  canReuseDraft?: (source: string, translation: string) => boolean;
  validate: (source: string, translated: string) => string;
  persist: () => Promise<void>;
  progress?: (value: UnityProgress) => void;
  onQueue?: (queue: UnityTranslationQueue | null) => void;
};
const keyOf = (source: string) => source.replace(/\r\n?/g, "\n").normalize("NFC").trim();
export async function yieldUnityPreparation(signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  signal.throwIfAborted();
}
export const unityTranslationContextKey = (entry: UnityEntry) => JSON.stringify([entry.file, entry.container, entry.kind, entry.locale || "", (entry.parentLocator || entry.locator || "").replace(/\/\d+(?=\/|$)/g, "/#"), keyOf(entry.source)]);
export function unityTranslationCharacters(selected: UnityEntry[], entries: UnityEntry[], validate: Session["validate"], prepare: (source: string) => string, canReuseDraft?: Session["canReuseDraft"], key = (entry: UnityEntry) => keyOf(entry.source)) {
  const reusable = new Set(entries.filter(entry => entry.translation && !entry.error && !validate(entry.source, entry.translation) || entry.layoutDraft && !validate(entry.source, entry.layoutDraft) && (canReuseDraft?.(entry.source, entry.layoutDraft) ?? true)).map(key));
  const pending = new Set<string>();
  let selectedCharacters = 0, pendingCharacters = 0;
  for (const entry of selected) {
    for (const _ of entry.source) selectedCharacters++;
    const identity = key(entry);
    if (reusable.has(identity) || pending.has(identity)) continue;
    pending.add(identity);
    for (const _ of prepare(entry.source)) pendingCharacters++;
  }
  return { selectedCharacters, pendingCharacters };
}
export function unityTranslationStats(entries: UnityEntry[], validate: Session["validate"], key = (entry: UnityEntry) => keyOf(entry.source)) {
  const groups = new Map<string, boolean>(); let coverageCompleted = 0;
  for (const entry of entries) {
    const identity = key(entry), valid = !!entry.translation && !entry.error && !validate(entry.source, entry.translation);
    if (valid) coverageCompleted++;
    groups.set(identity, (groups.get(identity) ?? true) && valid);
  }
  return { completed: [...groups.values()].filter(Boolean).length, total: groups.size, coverageCompleted, coverageTotal: entries.length };
}

/** Save each result and collect item failures without stopping the remaining work. */
export async function translateUnitySession(entries: UnityEntry[], cache: Map<string, string>, session: Session) {
  const entryKey = session.key || ((entry: UnityEntry) => keyOf(entry.source));
  const reused = session.key ? new Map(cache) : new Map([...cache].map(([source, translation]) => [keyOf(source), translation]));
  const groups = new Map<string, UnityEntry[]>();
  const completion = new Map<string, boolean>();
  const targets = session.references ? new Set(entries.map(entry => entry.id)) : null;
  const references = session.references || entries;
  let coverageCompleted = 0;
  session.signal.throwIfAborted();
  for (let index = 0; index < references.length; index++) {
    if (index > 0 && index % 512 === 0) await yieldUnityPreparation(session.signal);
    const entry = references[index], key = entryKey(entry);
    const valid = !!entry.translation && !entry.error && !session.validate(entry.source, entry.translation);
    if (valid) reused.set(key, entry.translation);
    else if (entry.layoutDraft && !reused.has(key) && !session.validate(entry.source, entry.layoutDraft) && (session.canReuseDraft?.(entry.source, entry.layoutDraft) ?? true)) reused.set(key, entry.layoutDraft);
    if (targets && !targets.has(entry.id)) continue;
    if (valid) coverageCompleted++;
    completion.set(key, (completion.get(key) ?? true) && valid);
    if (!valid) { const group = groups.get(key) || []; group.push(entry); groups.set(key, group); }
  }
  const pending = [...groups];
  const states = new Map<string, "pending" | "active" | "failed" | "done">(pending.map(([key]) => [key, "pending"]));
  const waitingWorkers = new Set<() => void>();
  const wake = () => { const workers = [...waitingWorkers]; waitingWorkers.clear(); workers.forEach(resolve => resolve()); };
  const initial = { completed: [...completion.values()].filter(Boolean).length, total: completion.size, coverageCompleted };
  let completed = initial.completed, covered = initial.coverageCompleted, processed = 0, requests = 0, reusedGroups = initial.completed;
  let failures = 0, failedEntries = 0;
  const active = new Map<string, UnityTranslationActivity>();
  let last: { id: string; failed: boolean } | undefined;
  let saveFailure: unknown;
  let closed = false;
  let saveQueue = Promise.resolve();
  const persist = () => {
    const write = saveQueue.then(() => { if (saveFailure) throw saveFailure; return session.persist(); });
    saveQueue = write.catch(error => { saveFailure = error; });
    return write;
  };
  const report = (detail: string) => session.progress?.({ detail, completed: initial.completed + processed, total: initial.total, coverageCompleted: covered, coverageTotal: entries.length, requests, reused: reusedGroups,
    translation: { processed, pending: groups.size, successful: completed, failed: failures, failedEntries, active: [...active.values()], last } });
  const queue: UnityTranslationQueue = {
    status(id) { const entry = entries.find(item => item.id === id); return entry ? states.get(entryKey(entry)) || "done" : "not-in-task"; },
    retry(id) {
      if (closed || session.signal.aborted || saveFailure) return false;
      const entry = entries.find(item => item.id === id);
      if (!entry) return false;
      const key = entryKey(entry), group = groups.get(key);
      if (!group || states.get(key) !== "failed") return false;
      reused.delete(key); cache.delete(key);
      const draft = group.find(item => item.layoutDraft && !session.validate(item.source, item.layoutDraft) && (session.canReuseDraft?.(item.source, item.layoutDraft) ?? true));
      if (draft?.layoutDraft) reused.set(key, draft.layoutDraft);
      states.set(key, "pending"); pending.push([key, group]); processed--; failures--; failedEntries -= group.length;
      report(`条目 #${id} 已重新加入翻译队列`); wake(); return true;
    },
  };
  const commit = async ([key, group]: [string, UnityEntry[]]) => {
    const entry = group[0];
    let formatting = false, persistenceFailure = false;
    let failed = false;
    const phase = (value: UnityTranslationActivity["phase"]) => { active.set(key, { id: entry.id, references: group.length, phase: value }); report(`条目 #${entry.id} · 相同原文对应 ${group.length} 个条目`); };
    try {
      const cached = reused.get(key);
      if (!cached) requests++;
      phase(cached ? "reusing" : "translating");
      const translated = cached || await session.translate(entry.source, entry);
      const translationProblem = session.validate(entry.source, translated);
      if (translationProblem) throw new Error(translationProblem);
      if (session.retainDraft && session.format && group.some(item => /[\r\n]/.test(item.source))) {
        group.forEach(item => { item.layoutDraft = translated; });
        if (session.persistDraftBeforeFormat) try { await persist(); } catch (error) { persistenceFailure = true; throw error; }
      }
      formatting = !!session.format;
      if (formatting) phase("formatting");
      const formatted: string[] = [];
      for (const item of group) {
        if (session.signal.aborted) throw session.signal.reason || new Error("任务已中止");
        const leading = item.source.match(session.format ? /^[\t \u3000]*/ : /^\s*/)?.[0] || "";
        const trailing = session.format ? "" : item.source.match(/\s*$/)?.[0] || "";
        const body = session.format ? await session.format(item.source.trim(), translated.trim()) : translated.trim();
        const value = leading + body + trailing;
        const problem = session.validate(item.source, value); if (problem) throw new Error(problem);
        formatted.push(value);
      }
      if (session.signal.aborted) throw session.signal.reason || new Error("任务已中止");
      group.forEach((item, index) => { item.translation = formatted[index]; item.error = ""; delete item.layoutDraft; });
      reused.set(key, translated); cache.set(key, translated); completed++; covered += group.length;
      if (cached) reusedGroups++;
    } catch (error) {
      if (session.signal.aborted || persistenceFailure) throw error;
      const message = (formatting ? "译文排版失败：" : "") + (error instanceof Error ? error.message : String(error));
      for (const item of group) item.error = message;
      failures++; failedEntries += group.length; failed = true;
    }
    phase("saving");
    await persist(); // Serialize disk snapshots; never let an older write overwrite a newer result.
    processed++; active.delete(key); states.set(key, failed ? "failed" : "done"); last = { id: entry.id, failed };
    report(`本轮已检查 ${processed}/${groups.size} 种原文 · 右侧已有有效译文 ${covered}/${entries.length} 条 · 失败 ${failedEntries} 条`);
  };
  report(`已完成 ${completed}/${initial.total} 种原文 · 已有有效译文覆盖 ${covered}/${entries.length} 处`);
  let cursor = 0, inFlight = 0;
  const worker = async () => {
    while (!session.signal.aborted && !saveFailure) {
      if (cursor >= pending.length) {
        if (!inFlight) return;
        await new Promise<void>(resolve => waitingWorkers.add(resolve)); continue;
      }
      const group = pending[cursor++]; states.set(group[0], "active"); inFlight++;
      try { await commit(group); } finally { inFlight--; wake(); }
    }
  };
  session.signal.addEventListener("abort", wake);
  session.onQueue?.(queue);
  try {
    const results = await Promise.allSettled(Array.from({ length: Math.min(Math.max(1, session.concurrency || 1), pending.length) }, worker));
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
  } finally { closed = true; session.signal.removeEventListener("abort", wake); session.onQueue?.(null); }
}
