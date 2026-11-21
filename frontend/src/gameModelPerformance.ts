import { invoke, isTauri } from "@tauri-apps/api/core";
import { isGameBenchmarkWindow } from "./gameBenchmarkWindow";
import { logRuntimeError } from "./runtimeLog";

type Execution = { llmConcurrency?: number; performanceConcurrency?: number; performanceScope: string; performanceStep: string };
export type ModelServiceTiming = { totalMs: number; loadMs: number; promptMs: number; generationMs: number };
type ServiceTimingTotals = ModelServiceTiming & { requests: number; outsideMs: number };
type Meter = { model: string; concurrency: number; tokens: number; requestMs: number; generationTokens: number; generationMs: number; requests: number; serviceTiming?: ServiceTimingTotals };
export type GameTimingCategory = "queueMs" | "processingMs" | "saveMs" | "modelRequestMs" | "detectorMs" | "ocrMs" | "workflowMs";
export type StepPerformance = {
  elapsedMs: number;
  itemsDone?: number;
  failures?: number;
  cacheHits?: number;
  started?: number;
  requestTimingComplete?: boolean;
  busyMs?: number;
  idleMs?: number;
  wallTiming?: Partial<Record<GameTimingCategory, number>>;
  timing?: Partial<Record<GameTimingCategory, number>>;
  modelWallTiming?: Record<string, { requestMs: number }>;
  models: Record<string, Meter>;
  taskId?: string;
  beginTime?: string;
  endedAt?: string;
  benchmark?: Record<string, unknown>;
};
type Archive = Omit<StepPerformance, "started"> & { totalMs: number; scope: string; step: string; reason: "completed" | "cleared" };
const mainArchiveKey = "llmchat-game-performance-outbox";
const benchmarkArchiveKey = mainArchiveKey + ":benchmark-window";
const archiveKey = isGameBenchmarkWindow ? benchmarkArchiveKey : mainArchiveKey;
const archiveWrites = new Map<string, Promise<void>>();

function pendingArchives(key = archiveKey): Archive[] {
  return JSON.parse(localStorage.getItem(key) || "[]");
}
export function flushGamePerformanceArchive(key = archiveKey) {
  if (!isTauri() || archiveWrites.has(key)) return archiveWrites.get(key);
  try {
    if (!pendingArchives(key).length) return;
  } catch (error) {
    logRuntimeError("game-performance-archive-error", error);
    return;
  }
  const append = async () => {
    for (;;) {
      const record = pendingArchives(key)[0];
      if (!record) break;
      await invoke("append_game_performance", { record });
      localStorage.setItem(key, JSON.stringify(pendingArchives(key).filter(item => item.taskId !== record.taskId)));
    }
  };
  const writing = (navigator.locks?.request(key, append) ?? append())
    .catch(error => logRuntimeError("game-performance-archive-error", error)).finally(() => archiveWrites.delete(key));
  archiveWrites.set(key, writing);
  return writing;
}
export function recoverGamePerformanceArchives() {
  void flushGamePerformanceArchive();
  if (!isGameBenchmarkWindow) void flushGamePerformanceArchive(benchmarkArchiveKey);
}

function archiveStep(scope: string, step: string, meter: StepPerformance, reason: Archive["reason"]) {
  if (meter.endedAt || !meter.taskId) return;
  const { started: _, ...results } = meter;
  const endedAt = new Date().toISOString();
  localStorage.setItem(archiveKey, JSON.stringify([...pendingArchives(), { ...results, totalMs: results.elapsedMs, scope, step, reason, endedAt }]));
  meter.endedAt = endedAt;
  flushGamePerformanceArchive();
}
const checkpoints = new Map<string, ReturnType<typeof setInterval>>();
const scopes = new Map<string, Record<string, StepPerformance>>();
const selectionScopes = new WeakMap<object, string>();
const concurrencyPrefix = "llmchat-game-model-concurrency:";
export const gameDefaultTextModel = {
  id: "hf.co/tencent/Hy-MT2-7B-GGUF:Q8_0",
  pattern: /(?:^|\/)Hy-MT2-7B-GGUF:Q8_0$/i,
  concurrency: 4,
};
const imageRoles = new Set(["screen", "refine", "recognize", "image", "review", "layout"]);
const steps: Record<string, string> = { textScreen: "screen", text: "translate", dialogue: "translate", names: "translate", line: "translate", screen: "filter", refine: "refine", recognize: "recognize", image: "translate", review: "review", layout: "render" };
export function rememberPromptSelection(selection: object, scope: string) { selectionScopes.set(selection, scope); }
export function modelConcurrency(scope: string, role: string, model: string) {
  const defaultLanes = role === "refine" && /^qwen3-vl:[48]b-instruct$/i.test(model) ||
    role === "recognize" && /^qwen3-vl:8b-instruct$/i.test(model) ? 2 : 1;
  const translationRole = role === "text" || role === "dialogue" || role === "names" || role === "image";
  const fallback = translationRole && gameDefaultTextModel.pattern.test(model) ? gameDefaultTextModel.concurrency : defaultLanes;
  const value = Number(localStorage.getItem(concurrencyPrefix + JSON.stringify([scope, role, model])) ?? fallback);
  return Number.isInteger(value) && value >= 1 && value <= 4 ? value : 1;
}
export function saveModelConcurrency(scope: string, role: string, model: string, value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 4) throw new Error("并发数必须为 1–4");
  localStorage.setItem(concurrencyPrefix + JSON.stringify([scope, role, model]), String(value));
}
export function maximumModelConcurrency() {
  let maximum = 1;
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(concurrencyPrefix)) maximum = Math.max(maximum, Math.min(4, Number(localStorage.getItem(key)) || 1));
  }
  return maximum;
}
const benchmarkExecutions = new WeakMap<object, Execution>();
export function rememberBenchmarkExecution(selection: object, scope: string, step: string, lanes: number) {
  benchmarkExecutions.set(selection, { performanceScope: scope, performanceStep: step, llmConcurrency: lanes });
}
export function gameStepSelections(scope: string, step: string, llmConcurrency?: number) {
  const selections = new Map<number, object>();
  return (lanes: number) => {
    let selection = selections.get(lanes);
    if (!selection) {
      selection = {};
      // Report worker lanes without changing the request scheduler's existing limit.
      benchmarkExecutions.set(selection, { performanceScope: scope, performanceStep: step, performanceConcurrency: lanes, llmConcurrency });
      selections.set(lanes, selection);
    }
    return selection;
  };
}

export function gameModelExecution(selection: object | undefined, role: string, model: string): Partial<Execution> {
  const benchmark = selection && benchmarkExecutions.get(selection);
  if (benchmark) return benchmark;
  const scope = selection && selectionScopes.get(selection);
  if (!scope) return {};
  return { llmConcurrency: modelConcurrency(scope, role, model), performanceScope: scope + (imageRoles.has(role) ? ":images" : ":text"), performanceStep: steps[role] };
}
function records(scope: string) {
  if (!scopes.has(scope)) {
    let saved: Record<string, StepPerformance> = {};
    try { saved = JSON.parse(localStorage.getItem("llmchat-game-performance:" + scope) || "{}"); } catch { /* Empty history. */ }
    for (const [step, value] of Object.entries(saved)) {
      if (!value.taskId) delete saved[step]; else delete value.started;
    }
    flushGamePerformanceArchive();
    scopes.set(scope, saved);
  }
  return scopes.get(scope)!;
}
function commit(scope: string) {
  const value = records(scope);
  const running = Object.values(value).some(meter => meter.started !== undefined);
  const timer = checkpoints.get(scope);
  if (running && timer === undefined) {
    checkpoints.set(scope, setInterval(() => commit(scope), 5000));
  } else if (!running && timer !== undefined) {
    clearInterval(timer);
    checkpoints.delete(scope);
  }
  const key = "llmchat-game-performance:" + scope;
  const steps = Object.entries(value);
  if (steps.length) localStorage.setItem(key, JSON.stringify(Object.fromEntries(steps.map(([step, meter]) => [step, { ...performanceSnapshot(meter), started: undefined }]))));
  else {
    localStorage.removeItem(key);
    scopes.delete(scope);
  }
  window.dispatchEvent(new Event("llmchat-game-performance"));
}
export function beginGameStep(scope: string, step: string, benchmark?: Record<string, unknown>) {
  const all = records(scope);
  if (all[step]?.started !== undefined) return;
  for (const [id, meter] of Object.entries(all)) {
    if (id !== step && meter.started !== undefined) {
      stopMeter(meter);
      archiveStep(scope, id, meter, "completed");
    }
  }
  if (!all[step] || all[step].endedAt) {
    all[step] = { elapsedMs: 0, requestTimingComplete: true, models: {}, modelWallTiming: {}, taskId: crypto.randomUUID(), beginTime: new Date().toISOString(), benchmark };
  }
  const meter = all[step];
  meter.started ??= performance.now(); commit(scope);
}
export function reportGameStepItems(scope: string, step: string, itemsDone: number, failures?: number) {
  const meter = records(scope)[step];
  if (meter?.started === undefined) return;
  meter.itemsDone = itemsDone;
  if (failures !== undefined) meter.failures = failures;
}

export function finishGameStep(scope: string, completed = false) {
  for (const [step, meter] of Object.entries(records(scope))) {
    if (meter.started === undefined) continue;
    stopMeter(meter);
    if (completed) archiveStep(scope, step, meter, "completed");
  }
  commit(scope);
}
export function completeGameStep(scope: string, step: string) {
  const meter = records(scope)[step];
  if (meter) { stopMeter(meter); archiveStep(scope, step, meter, "completed"); commit(scope); }
}
export function clearGamePerformance(scope: string, affected: readonly string[], archive = true) {
  const all = records(scope);
  for (const step of affected) {
    const meter = all[step];
    if (!meter) continue;
    stopMeter(meter);
    if (archive) archiveStep(scope, step, meter, "cleared");
    delete all[step];
  }
  commit(scope);
}
const benchmarkWindowMeters = new Map<string, { queue: StepPerformance; run: StepPerformance; step: string }>();
export function updateBenchmarkWindowPerformance(scope: string, value?: { queue: StepPerformance; run: StepPerformance; step: string }) {
  if (value?.queue.started !== undefined) {
    const now = performance.now();
    benchmarkWindowMeters.set(scope, {
      step: value.step,
      queue: { ...value.queue, started: value.queue.started === undefined ? undefined : now },
      run: { ...value.run, started: value.run.started === undefined ? undefined : now },
    });
  } else benchmarkWindowMeters.delete(scope);
  window.dispatchEvent(new Event("llmchat-game-performance"));
}

export function stepPerformance(scope: string, step: string) {
  const queueSuffix = ":benchmark-total";
  const runSuffix = /:benchmark:(?:text|images)$/.exec(scope)?.[0];
  const run = runSuffix && benchmarkWindowMeters.get(scope.slice(0, -runSuffix.length));
  const external = scope.endsWith(queueSuffix) && step === "queue" ? benchmarkWindowMeters.get(scope.slice(0, -queueSuffix.length))?.queue
    : run && run.step === step ? run.run : undefined;
  if (external) return performanceSnapshot(external);
  const meter = records(scope)[step];
  return meter ? performanceSnapshot(meter) : { elapsedMs: 0, models: {} };
}
function requestMeter(execution: Partial<Execution>) {
  if (!execution.performanceScope || !execution.performanceStep) return;
  const scope = execution.performanceScope, all = records(scope);
  const active = Object.entries(all).find(([, value]) => value.started !== undefined)?.[0];
  const step = scope.endsWith(":unity:images") && active === "translate" && ["review", "render"].includes(execution.performanceStep) ? active : execution.performanceStep;
  return all[step];
}

type TimingWindow = { started: number; count: number };
const timingWindows = new WeakMap<StepPerformance, Map<GameTimingCategory, TimingWindow>>();
const modelTimingWindows = new WeakMap<StepPerformance, Map<string, TimingWindow>>();
function performanceSnapshot(meter: StepPerformance, now = performance.now()): StepPerformance {
  const active = timingWindows.get(meter);
  const wallTiming = { ...meter.wallTiming };
  for (const [category, interval] of active || []) wallTiming[category] = (wallTiming[category] || 0) + now - interval.started;
  const elapsedMs = meter.elapsedMs + (meter.started === undefined ? 0 : now - meter.started);
  const busyMs = wallTiming.modelRequestMs ?? (meter.requestTimingComplete ? 0 : undefined);
  const idleMs = meter.requestTimingComplete && busyMs !== undefined ? Math.max(0, elapsedMs - busyMs) : undefined;
  const modelWallTiming = meter.modelWallTiming && Object.assign(Object.create(null) as NonNullable<StepPerformance["modelWallTiming"]>, meter.modelWallTiming);
  if (modelWallTiming) {
    for (const [model, interval] of modelTimingWindows.get(meter) || []) {
      modelWallTiming[model] = { requestMs: (modelWallTiming[model]?.requestMs ?? 0) + now - interval.started };
    }
  }
  return { ...meter, elapsedMs, busyMs, idleMs, modelWallTiming,
    wallTiming: Object.keys(wallTiming).length ? wallTiming : undefined };
}
function stopMeter(meter: StepPerformance) {
  if (meter.started === undefined) return;
  const snapshot = performanceSnapshot(meter);
  meter.elapsedMs = snapshot.elapsedMs;
  meter.wallTiming = snapshot.wallTiming;
  meter.modelWallTiming = snapshot.modelWallTiming;
  timingWindows.delete(meter);
  modelTimingWindows.delete(meter);
  delete meter.started;
}

export function startGameTiming(context: string | Partial<Execution> | undefined, category: GameTimingCategory): () => void {
  const meter = typeof context === "string"
    ? Object.values(records(context)).find(step => step.started !== undefined)
    : context && requestMeter(context);
  if (meter?.started === undefined || meter.endedAt) return () => {};
  const started = performance.now();
  const windows = timingWindows.get(meter) || new Map<GameTimingCategory, TimingWindow>();
  timingWindows.set(meter, windows);
  const interval = windows.get(category) || { started, count: 0 };
  windows.set(category, interval);
  interval.count++;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    if (timingWindows.get(meter) !== windows || meter.started === undefined || meter.endedAt) return;
    const now = performance.now();
    const totals = meter.timing ??= {};
    totals[category] = (totals[category] || 0) + now - started;
    if (--interval.count === 0) {
      windows.delete(category);
      const wallTiming = meter.wallTiming ??= {};
      wallTiming[category] = (wallTiming[category] || 0) + now - interval.started;
    }
  };
}

export function measureGameWork<T>(context: string | Partial<Execution> | undefined, category: GameTimingCategory, work: () => T): T {
  const finish = startGameTiming(context, category);
  try { return work(); } finally { finish(); }
}
export async function measureGameAsync<T>(context: string | Partial<Execution> | undefined, category: GameTimingCategory, work: () => Promise<T>): Promise<T> {
  const finish = startGameTiming(context, category);
  try { return await work(); } finally { finish(); }
}

function activeStepMeter(scope: string | undefined) {
  return scope ? Object.values(records(scope)).find(step => step.started !== undefined) : undefined;
}

export function recordGameCacheHit(scope: string | undefined) {
  const meter = activeStepMeter(scope);
  if (meter) meter.cacheHits = (meter.cacheHits ?? 0) + 1;
}

export function recordGameWorkflowTiming(scope: string | undefined, durationMs: number | undefined) {
  if (durationMs === undefined) return;
  const meter = activeStepMeter(scope);
  if (!meter) return;
  const timing = meter.timing ??= {};
  timing.workflowMs = (timing.workflowMs ?? 0) + durationMs;
}

export function modelServiceTimingLines(timing: ServiceTimingTotals, requests: number, format: (ms: number) => string) {
  return [
    `服务总计 ${format(timing.totalMs)} · 计时 ${timing.requests}/${requests} 次`,
    `模型就绪 ${format(timing.loadMs)} · 输入评估 ${format(timing.promptMs)} · 输出生成 ${format(timing.generationMs)} · 服务外开销 ${format(timing.outsideMs)}`,
  ];
}

const inFlight = new WeakMap<StepPerformance, Map<string, number>>();

function modelStats(meter: StepPerformance, key: string, model: string, concurrency: number) {
  return meter.models[key] ??= { model, concurrency, tokens: 0, requestMs: 0, generationTokens: 0, generationMs: 0, requests: 0 };
}

export function trackGameModel(execution: Partial<Execution>, model: string) {
  const meter = requestMeter(execution);
  if (meter?.started === undefined || meter.endedAt) return;
  const models = inFlight.get(meter) || new Map<string, number>();
  inFlight.set(meter, models);
  const concurrency = execution.performanceConcurrency ?? execution.llmConcurrency ?? 1;
  const key = JSON.stringify([model, concurrency]);
  modelStats(meter, key, model, concurrency).requests++;
  const previous = models.get(key) || 0;
  models.set(key, previous + 1);

  const timings = modelTimingWindows.get(meter) ?? new Map<string, TimingWindow>();
  modelTimingWindows.set(meter, timings);
  const interval = timings.get(model) ?? { started: performance.now(), count: 0 };
  timings.set(model, interval);
  interval.count++;
  if (!previous) window.dispatchEvent(new Event("llmchat-game-performance"));
  return () => {
    if (--interval.count === 0 && modelTimingWindows.get(meter) === timings) {
      timings.delete(model);
      // Older interrupted runs lack an exact per-model denominator for their saved requests.
      if (meter.modelWallTiming) {
        const requestMs = Object.hasOwn(meter.modelWallTiming, model) ? meter.modelWallTiming[model].requestMs : 0;
        meter.modelWallTiming = { ...meter.modelWallTiming, [model]: { requestMs: requestMs + performance.now() - interval.started } };
      }
    }
    const remaining = (models.get(key) || 1) - 1;
    if (remaining) models.set(key, remaining);
    else {
      models.delete(key);
      window.dispatchEvent(new Event("llmchat-game-performance"));
    }
  };
}

export function isGameModelActive(scope: string, step: string, model: string, concurrency: number) {
  const meter = records(scope)[step];
  return meter?.started !== undefined && !!inFlight.get(meter)?.get(JSON.stringify([model, concurrency]));
}

export function sumModelServiceTiming(first?: ServiceTimingTotals, second?: ServiceTimingTotals): ServiceTimingTotals | undefined {
  if (!first || !second) return first ?? second;
  return {
    requests: first.requests + second.requests,
    outsideMs: first.outsideMs + second.outsideMs,
    totalMs: first.totalMs + second.totalMs,
    loadMs: first.loadMs + second.loadMs,
    promptMs: first.promptMs + second.promptMs,
    generationMs: first.generationMs + second.generationMs,
  };
}

export function recordGameRequest(execution: Partial<Execution>, model: string, tokens: number, requestMs: number, generationRate?: number, serviceTiming?: ModelServiceTiming) {
  const scope = execution.performanceScope;
  if (!scope) return;
  const meter = requestMeter(execution);
  if (meter?.started === undefined || meter.endedAt) return;
  const concurrency = execution.performanceConcurrency ?? execution.llmConcurrency ?? 1;
  const key = JSON.stringify([model, concurrency]);
  const stats = modelStats(meter, key, model, concurrency);
  stats.tokens += Math.max(0, tokens); stats.requestMs += requestMs;
  if (!inFlight.get(meter)?.has(key)) stats.requests++;
  if (generationRate && generationRate > 0 && tokens > 0) { stats.generationTokens += tokens; stats.generationMs += tokens / generationRate * 1000; }
  if (serviceTiming) stats.serviceTiming = sumModelServiceTiming(stats.serviceTiming, {
    ...serviceTiming, requests: 1, outsideMs: Math.max(0, requestMs - serviceTiming.totalMs),
  });
  if (!checkpoints.has(scope)) commit(scope);
}
export function gameDuration(ms: number) { return [3600000, 60000, 1000].map((unit, index) => String(index ? Math.floor(ms / unit) % 60 : Math.floor(ms / unit)).padStart(2, "0")).join(":"); }

type Waiter = { model: string; limit: number; signal?: AbortSignal | null; resolve: (release: () => void) => void; reject: (reason: unknown) => void; abort: () => void };
const gates = new Map<string, { active: Waiter[]; pending: Waiter[] }>();
export function acquireLocalModel(origin: string, model: string, limit: number, signal?: AbortSignal | null): Promise<() => void> {
  const gate = gates.get(origin) || { active: [], pending: [] }; gates.set(origin, gate);
  const drain = () => {
    while (gate.pending.length) {
      const next = gate.pending[0];
      if (gate.active.length && (gate.active[0].model !== next.model || gate.active.length >= Math.min(next.limit, ...gate.active.map(item => item.limit)))) break;
      gate.pending.shift(); next.signal?.removeEventListener("abort", next.abort); gate.active.push(next);
      next.resolve(() => { gate.active.splice(gate.active.indexOf(next), 1); drain(); if (!gate.active.length && !gate.pending.length) gates.delete(origin); });
    }
  };
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { model, limit: Math.max(1, Math.min(4, limit)), signal, resolve, reject, abort: () => { const index = gate.pending.indexOf(waiter); if (index >= 0) gate.pending.splice(index, 1); reject(signal?.reason); drain(); } };
    if (signal?.aborted) { reject(signal.reason); return; }
    gate.pending.push(waiter); signal?.addEventListener("abort", waiter.abort, { once: true }); drain();
  });
}
