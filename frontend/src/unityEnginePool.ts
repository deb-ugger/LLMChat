import type { TranslateProvider } from "./api";
import type { UnityEngineProgress } from "./unityOffline";
import { classicEngines, engineRequiresKey, getEngineInfo } from "./translateEngines";

export type UnityEngineChoice = { id: TranslateProvider; enabled: boolean };
export const UNITY_ENGINE_CHOICES_KEY = "unity-offline-translation-engines";
export const defaultUnityEngines = (): UnityEngineChoice[] => classicEngines().filter(engine => !engineRequiresKey(engine)).map(engine => ({ id: engine.id, enabled: true }));
export function normalizeUnityEngines(value: unknown): UnityEngineChoice[] {
  if (!Array.isArray(value)) return defaultUnityEngines();
  const seen = new Set<string>();
  const result: UnityEngineChoice[] = [];
  for (const row of value) {
    if (!row || !classicEngines().some(engine => engine.id === row.id) || seen.has(row.id)) continue;
    seen.add(row.id); result.push({ id: row.id, enabled: row.enabled === true });
  }
  return result;
}
export function loadUnityEngines(): UnityEngineChoice[] {
  const saved = localStorage.getItem(UNITY_ENGINE_CHOICES_KEY);
  if (saved === null) return defaultUnityEngines();
  try { return normalizeUnityEngines(JSON.parse(saved)); } catch { return defaultUnityEngines(); }
}

/** One slot per provider; explicit key-based engines are only fallback candidates. */
export function createUnityEnginePool(choices: UnityEngineChoice[], signal: AbortSignal, request: (provider: TranslateProvider, text: string) => Promise<string>, options: { onStats?: (value: UnityEngineProgress[]) => void; measure?: (text: string) => number; now?: () => number } = {}) {
  const enabled = normalizeUnityEngines(choices).filter(row => row.enabled);
  const free = enabled.filter(row => !engineRequiresKey(getEngineInfo(row.id)!));
  const keyed = enabled.filter(row => engineRequiresKey(getEngineInfo(row.id)!));
  const occupied = new Set<TranslateProvider>();
  const now = options.now || (() => performance.now());
  const started = options.onStats ? now() : 0;
  const meters = new Map(enabled.map(row => [row.id, { characters: 0, entryId: undefined as string | undefined, samples: [] as { at: number; characters: number }[] }]));
  const emit = (stopped = false) => {
    if (!options.onStats) return;
    const time = now();
    options.onStats(enabled.map(row => {
      const meter = meters.get(row.id)!;
      meter.samples = meter.samples.filter(sample => time - sample.at <= 5000);
      return { id: row.id, characters: meter.characters, entryId: meter.entryId, active: !stopped && !signal.aborted && occupied.has(row.id),
        speed: stopped || signal.aborted ? 0 : meter.samples.reduce((sum, sample) => sum + sample.characters, 0) / Math.max(1, Math.min(5000, time - started)) * 1000 };
    }));
  };
  const ticker = options.onStats ? setInterval(() => emit(), 500) : undefined;
  const waiters = new Set<{ resolve: () => void; reject: (reason: unknown) => void }>();
  const cancelWaiters = () => { for (const waiter of waiters) waiter.reject(signal.reason || new Error("任务已中止")); waiters.clear(); if (ticker !== undefined) clearInterval(ticker); emit(true); };
  signal.addEventListener("abort", cancelWaiters, { once: true });
  const acquire = async (candidates: UnityEngineChoice[]) => {
    while (true) {
      signal.throwIfAborted();
      const candidate = candidates.find(row => !occupied.has(row.id));
      if (candidate) { occupied.add(candidate.id); return candidate.id; }
      await new Promise<void>((resolve, reject) => waiters.add({ resolve, reject }));
    }
  };
  const release = (id: TranslateProvider) => {
    occupied.delete(id);
    emit();
    const waiting = [...waiters]; waiters.clear();
    for (const waiter of waiting) waiter.resolve();
  };
  emit();
  return {
    concurrency: enabled.length,
    async translate(text: string, entryId?: string) {
      if (!enabled.length) throw new Error("请至少启用一个已配置的翻译引擎");
      const attempted = new Set<TranslateProvider>(), errors: string[] = [];
      for (const tier of [free, keyed]) {
        while (tier.some(row => !attempted.has(row.id))) {
          const id = await acquire(tier.filter(row => !attempted.has(row.id)));
          attempted.add(id);
          meters.get(id)!.entryId = entryId; emit();
          try {
            const result = await request(id, text); signal.throwIfAborted();
            if (options.onStats) {
              const meter = meters.get(id)!, characters = options.measure ? options.measure(text) : [...text].length;
              meter.characters += characters; meter.samples.push({ at: now(), characters });
            }
            return result;
          }
          catch (error) {
            if (signal.aborted) throw error;
            errors.push(`${getEngineInfo(id)!.label}：${error instanceof Error ? error.message : String(error)}`);
          } finally { release(id); }
        }
      }
      throw new Error(`所有已启用引擎均未完成翻译：${errors.join("；")}`);
    },
    dispose() { signal.removeEventListener("abort", cancelWaiters); cancelWaiters(); },
  };
}
