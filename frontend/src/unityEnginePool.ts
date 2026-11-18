import { measureGameAsync } from "./gameModelPerformance";
import type { TranslateProvider } from "./api";
import type { UnityEngineProgress } from "./unityOffline";
import { classicEngines, engineRequiresKey, getEngineInfo } from "./translateEngines";

export type UnityEngineChoice = { id: TranslateProvider; enabled: boolean };
export const UNITY_ENGINE_CHOICES_KEY = "unity-offline-translation-engines";
const RATE_LIMIT_COOLDOWN_MS = 60_000;

function isEngineRateLimited(error: unknown) {
  const failure = error as { status?: number; code?: string; message?: string } | undefined;
  return failure?.status === 429 || failure?.code === "RATE_LIMIT" || failure?.code === "GOOGLE_CAPTCHA" ||
    /\bHTTP\s+429\b|\b429001\b|\bRATE_LIMIT\b|\bGOOGLE_CAPTCHA\b|\bBaidu (?:error_code|errorCode)=(?:54003|54005)\b|\btoo many requests\b|请求过于频繁|请求频率受限|人机验证|MYMEMORY WARNING/i.test(failure?.message || String(error));
}
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
export function createUnityEnginePool(choices: UnityEngineChoice[], signal: AbortSignal, request: (provider: TranslateProvider, text: string) => Promise<string>, options: { timingScope?: string; initialStats?: UnityEngineProgress[]; onStats?: (value: UnityEngineProgress[]) => void; measure?: (text: string) => number; now?: () => number } = {}) {
  const enabled = normalizeUnityEngines(choices).filter(row => row.enabled);
  const free = enabled.filter(row => !engineRequiresKey(getEngineInfo(row.id)!));
  const keyed = enabled.filter(row => engineRequiresKey(getEngineInfo(row.id)!));
  const occupied = new Set<TranslateProvider>();
  const cooldowns = new Map<TranslateProvider, number>();
  const now = options.now || (() => performance.now());
  const started = options.onStats ? now() : 0;
  const ids = [...new Set([...enabled.map(row => row.id), ...(options.initialStats || []).map(row => row.id)])];
  const meters = new Map(ids.map(id => [id, { characters: options.initialStats?.find(row => row.id === id)?.characters || 0, entryId: undefined as string | undefined, samples: [] as { at: number; characters: number }[] }]));
  const emit = (stopped = false) => {
    if (!options.onStats) return;
    const time = now();
    options.onStats(ids.map(id => {
      const meter = meters.get(id)!;
      meter.samples = meter.samples.filter(sample => time - sample.at <= 5000);
      return { id, characters: meter.characters, entryId: meter.entryId, active: !stopped && !signal.aborted && occupied.has(id as TranslateProvider),
        speed: stopped || signal.aborted ? 0 : meter.samples.reduce((sum, sample) => sum + sample.characters, 0) / Math.max(1, Math.min(5000, time - started)) * 1000 };
    }));
  };
  const ticker = options.onStats ? setInterval(() => emit(), 500) : undefined;
  const waiters = new Set<{ resolve: () => void; reject: (reason: unknown) => void }>();
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  const wakeWaiters = () => {
    if (cooldownTimer !== undefined) clearTimeout(cooldownTimer);
    cooldownTimer = undefined;
    for (const waiter of waiters) waiter.resolve();
    waiters.clear();
  };
  const cancelWaiters = () => {
    for (const waiter of waiters) waiter.reject(signal.reason || new Error("任务已中止"));
    wakeWaiters();
    if (ticker !== undefined) clearInterval(ticker);
    emit(true);
  };
  signal.addEventListener("abort", cancelWaiters, { once: true });
  const available = (row: UnityEngineChoice) => (cooldowns.get(row.id) ?? 0) <= now();
  const waitForEngine = () => measureGameAsync(options.timingScope, "queueMs", () =>
    new Promise<void>((resolve, reject) => {
      waiters.add({ resolve, reject });
      if (cooldownTimer !== undefined) return;
      const time = now();
      const nextReady = Math.min(...[...cooldowns.values()].filter(until => until > time));
      if (Number.isFinite(nextReady)) cooldownTimer = setTimeout(wakeWaiters, Math.max(1, Math.ceil(nextReady - time)));
    }));
  const acquire = async (candidates: UnityEngineChoice[]) => {
    while (true) {
      signal.throwIfAborted();
      const ready = candidates.filter(available);
      if (!ready.length) return;
      const candidate = ready.find(row => !occupied.has(row.id));
      if (candidate) { occupied.add(candidate.id); return candidate.id; }
      await waitForEngine();
    }
  };
  const release = (id: TranslateProvider) => {
    occupied.delete(id);
    emit();
    wakeWaiters();
  };
  emit();
  async function translate(text: string, entryId?: string): Promise<string> {
    if (!enabled.length) throw new Error("请至少启用一个已配置的翻译引擎");
    for (;;) {
      while (!enabled.some(available)) {
        signal.throwIfAborted();
        await waitForEngine();
      }
      const attempted = new Set<TranslateProvider>(), errors: string[] = [];
      for (const tier of [free, keyed]) {
        while (tier.some(row => !attempted.has(row.id))) {
          const id = await acquire(tier.filter(row => !attempted.has(row.id)));
          if (!id) break;
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
            if (isEngineRateLimited(error)) cooldowns.set(id, now() + RATE_LIMIT_COOLDOWN_MS);
            errors.push(`${getEngineInfo(id)!.label}：${error instanceof Error ? error.message : String(error)}`);
          } finally { release(id); }
        }
      }
      if (errors.length) throw new Error(`所有已启用引擎均未完成翻译：${errors.join("；")}`);
    }
  }
  return {
    concurrency: enabled.length,
    translate,
    dispose() { signal.removeEventListener("abort", cancelWaiters); cancelWaiters(); },
  };
}
