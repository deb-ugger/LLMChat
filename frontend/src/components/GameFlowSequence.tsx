import { createContext, useLayoutEffect, useRef, useState, useContext, useEffect, type ReactNode, type RefObject } from "react";
import { GamePromptContext } from "../gamePrompts";
import { deriveFlowMetrics, type FlowMetric, type FlowMetricInput } from "../gameFlowMetrics";
import { stepPerformance, gameDuration, saveModelConcurrency, modelConcurrency, type StepPerformance } from "../gameModelPerformance";
import { readModelFilter, saveModelFilter, type ModelFilter } from "./ModelFilterSelect";
import { showAppNotice } from "./AppNotice";
import type { GameTestConfigurationAccess } from "../gameModelPreset";
import { openGameAuxWindow } from "../gameAuxWindows";
import { GameFlowCard } from "./GameFlowCard";
import { benchmarkBlockingReason, isBenchmarkRunning, useBenchmarkProgress, useBenchmarkRunning } from "../benchmark/benchmarkRunner";

export type GameFlowStep = {
  id: string;
  title: string;
  summary?: string;
  models?: { role: string; id?: string }[];
  state: "done" | "current" | "waiting";
  stateLabel?: string;
  run?: () => void;
  stop?: () => void;
  runLabel?: string;
  runDisabled?: boolean;
  stopDisabled?: boolean;
  clear?: () => void;
};
type ConcurrencyEdit = { role: string; model: string; count: number };
export const GameConcurrencyDraft = createContext<{
  value: (role: string, model: string) => number | undefined;
  update: (edit: ConcurrencyEdit) => void;
  filter: (role: string) => ModelFilter;
  updateFilter: (role: string, filter: ModelFilter) => void;
} | null>(null);

type Activity = { step: string; state: string; label?: string; progress?: ReactNode };
const stateLabels: Record<string, string> = {
  done: "已完成", current: "未完成", waiting: "等待上一步",
  running: "正在处理", error: "失败", stopped: "已中止",
};
// Layout-only session state. Closing the app starts a new module instance.
const formatTiming = (value: number | undefined) => value === undefined ? "—" : value < 60000 ? (value / 1000).toFixed(1) + " 秒" : gameDuration(value);
const settingsHeights = new Map<string, number>();

type FlowMeasurement = StepPerformance & FlowMetricInput & {
  modelWallTiming?: Readonly<Record<string, { requestMs?: number; generationMs?: number }>>;
};
type ModelStats = StepPerformance["models"][string];
type ConfiguredModel = Pick<ModelStats, "model" | "concurrency">;
type ModelGroup = ConfiguredModel & { records: ModelStats[] };

function groupModels(measured: FlowMeasurement, configured: ConfiguredModel[]) {
  const groups = new Map<string, ModelGroup>();
  for (const model of configured) {
    const existing = groups.get(model.model);
    if (existing) existing.concurrency = Math.max(existing.concurrency, model.concurrency);
    else groups.set(model.model, { ...model, records: [] });
  }
  for (const model of Object.values(measured.models)) {
    const group = groups.get(model.model) ?? { model: model.model, concurrency: 0, records: [] };
    group.records.push(model);
    group.concurrency = Math.max(group.concurrency, model.concurrency);
    groups.set(model.model, group);
  }
  return [...groups.values()].map(({ records, model, concurrency }) => {
    const total = records.reduce((sum, item) => ({
      tokens: sum.tokens + item.tokens, requests: sum.requests + item.requests,
      generationTokens: sum.generationTokens + item.generationTokens,
    }), { tokens: 0, requests: 0, generationTokens: 0 });
    const [record] = records;
    const sequential = records.length === 1 && (record.concurrency <= 1 || record.requests <= 1);
    const wall = measured.modelWallTiming?.[model];
    const wholeStep = groups.size === 1 && measured.requestTimingComplete
      ? measured.busyMs ?? measured.wallTiming?.modelRequestMs : undefined;
    return {
      model, concurrency, ...total,
      requestMs: wall?.requestMs ?? (sequential ? record.requestMs : wholeStep),
      generationMs: wall?.generationMs ?? (sequential ? record.generationMs : undefined),
    };
  });
}

function tokenMetrics(input: FlowMetricInput) {
  const generationTokens = input.generationTokens ?? 0;
  const generationMs = input.generationMs ?? 0;
  const hasGeneration = Number.isFinite(generationTokens) && generationTokens > 0 &&
    Number.isFinite(generationMs) && generationMs > 0;
  const rates = deriveFlowMetrics(input).filter(metric => metric.unit === "tok/s" &&
    (metric.key !== "generationRate" || hasGeneration));
  if (hasGeneration && !rates.length) {
    // Derive the independent generation rate even when the request denominator is unavailable.
    return deriveFlowMetrics({
      ...input, tokens: input.generationTokens, requestMs: input.generationMs,
    }).filter(metric => metric.key === "generationRate");
  }
  return rates;
}

const metricDetails: Record<string, string> = {
  generationRate: "生成 token 数除以模型报告的生成耗时。只计生成，不含排队、网络往返或应用校验。",
  requestRate: "生成 token 数除以请求耗时，含网络往返和回包解析，不含应用侧排队和请求结束后的业务校验。",
  itemsRate: "已处理数量除以整步经过时间，含排队、读写 I/O 和结果处理。",
  secondsPerItem: "整步经过时间除以已处理数量，含排队、读写 I/O 和结果处理。",
  queueMs: "请求发出前在应用侧等待的时段。",
  processingMs: "应用侧处理和校验结果的时段。",
  saveMs: "应用写入结果的时段。",
  busyMs: "模型请求在途的时间并集。重叠的请求只计一次。",
  idleMs: "步骤运行中没有任何模型请求在途的时间。",
};

function MetricValue({ metric, onToggle, itemUnit = "张", compact = false }: {
  metric: FlowMetric; onToggle: () => void; itemUnit?: "张" | "条"; compact?: boolean;
}) {
  const detail = metric.tooltip ?? metricDetails[metric.key];
  const label = metric.key === "itemsRate" ? undefined :
    metric.key === "secondsPerItem" ? "每" + itemUnit : metric.label;
  const unit = metric.unit === "张/s" ? itemUnit + "/秒" :
    metric.unit === "秒/张" ? "秒" : metric.unit === "张" ? itemUnit : metric.unit;
  const content = <>{label && label + " "}<span className="game-flow-metric" style={compact ? { fontSize: "inherit" } : undefined}>
    {metric.value}{unit && " " + unit}
  </span></>;
  return detail ? <GameMetricHint detail={detail} onClick={onToggle}>{content}</GameMetricHint> : <span>{content}</span>;
}

function stepMetrics(measured: FlowMeasurement, samples?: { done: number; elapsedMs: number; failed: number }) {
  const busyMs = measured.busyMs ?? measured.wallTiming?.modelRequestMs;
  const input: FlowMetricInput = {
    itemsDone: measured.itemsDone ?? samples?.done,
    elapsedMs: samples?.elapsedMs ?? (measured.taskId || measured.elapsedMs > 0 ? measured.elapsedMs : undefined),
    failures: measured.failures ?? samples?.failed,
    queueMs: measured.queueMs ?? measured.wallTiming?.queueMs ?? measured.timing?.queueMs,
    processingMs: measured.processingMs ?? measured.wallTiming?.processingMs ?? measured.timing?.processingMs,
    saveMs: measured.saveMs ?? measured.wallTiming?.saveMs ?? measured.timing?.saveMs,
    busyMs,
    idleMs: measured.idleMs ?? (measured.requestTimingComplete && busyMs !== undefined
      ? Math.max(0, measured.elapsedMs - busyMs) : undefined),
  };
  const metrics = deriveFlowMetrics(input).filter(metric => {
    if (metric.key === "itemsDone") return input.itemsDone !== undefined;
    if (metric.key === "elapsedMs") return input.elapsedMs !== undefined;
    return true;
  });
  const throughput = metrics.filter(metric => ["itemsRate", "secondsPerItem", "itemsDone", "elapsedMs"].includes(metric.key));
  const timings = metrics.filter(metric => !throughput.includes(metric));
  return { throughput, timings };
}


export function GameMetricHint({ detail, onClick, children }: { detail: string; onClick: () => void; children: ReactNode }) {
  return <span data-tooltip={detail} onClick={onClick} style={{ pointerEvents: "auto", cursor: "pointer" }}>{children}</span>;
}

export function GameModelUsage({ model, perImage = false, onToggle }: {
  model: StepPerformance["models"][string];
  perImage?: boolean;
  onToggle: () => void;
}) {
  const { requests, requestMs, concurrency } = model;
  const metrics = tokenMetrics(model);
  if (metrics.length) return <>
    <small className="game-flow-model-rates">
      {metrics.map(metric => <MetricValue key={metric.key} metric={metric} onToggle={onToggle} />)}
    </small>
    {requests > 0 && requestMs > 0 && <small style={{ display: "block" }}
      data-tooltip="实际请求耗时逐次相加，并发请求的耗时可能重叠。">
      请求耗时合计 <span className="game-flow-metric">{formatTiming(requestMs)}</span> · <span className="game-flow-metric">{requests} 次</span>
    </small>}
  </>;
  if (requests <= 0 || requestMs <= 0) return null;
  const seconds = requestMs / requests / 1000;
  return <small className="game-flow-model-rates">
    <span>{perImage ? "每张" : "每次"} <span className="game-flow-metric">{seconds.toFixed(seconds < 0.1 ? 3 : 1)} 秒</span></span>
    <span>· 并发 <span className="game-flow-metric">{concurrency}</span></span>
    <span>· 请求 <span className="game-flow-metric">{requests} 次</span></span>
  </small>;
}

export type GameStepConfigurationCommit = (step: string) => Promise<boolean>;

export function GameFlowSequence({ configurationCommit, steps, configured, onConfigure, onRun, actions, activity, children, onSaveConfiguration, configurationScope, configuration, restoreConfiguration, testConfigurations, testConfigurationDisabled, configurationRevision }: {
  configurationCommit?: RefObject<GameStepConfigurationCommit | null>;
  steps: GameFlowStep[];
  configured: string | null;
  onConfigure: (step: string | null) => void;
  onRun?: () => void;
  testConfigurations?: GameTestConfigurationAccess;
  testConfigurationDisabled?: boolean;
  configurationRevision?: number;
  onSaveConfiguration?:()=>void|Promise<void>;
  configurationScope: string | null;
  configuration: Readonly<Partial<Record<string, string>>>;
  restoreConfiguration: (step: string) => void;
  actions?: ReactNode;
  activity?: Activity;
  children?: ReactNode;
}) {
  const promptContext = useContext(GamePromptContext);
  const imageFlow = steps.some(step => step.id === "filter" || step.id === "recognize");
  const scope = promptContext?.scope || configurationScope || "game";
  const performanceScope = scope + (imageFlow ? ":images" : ":text");
  const benchmark = useBenchmarkProgress(scope);
  const testing = useBenchmarkRunning();
  const testTitle = testing ? benchmarkBlockingReason : undefined;
  const runConfigured = (action?: () => void, step?: string) => {
    if (isBenchmarkRunning()) return;
    void withConfiguration(() => { if (!isBenchmarkRunning()) action?.(); }, step);
  };
  const benchmarkRunning = !!benchmark && (benchmark.step === "screen" || benchmark.step === "translate") !== imageFlow;
  const [, refreshPerformance] = useState(0);
  useEffect(() => {
    const refresh = () => refreshPerformance(value => value + 1);
    window.addEventListener("llmchat-game-performance", refresh);
    const timer = activity?.state === "running" ? window.setInterval(refresh, 1000) : undefined;
    return () => { window.removeEventListener("llmchat-game-performance", refresh); window.clearInterval(timer); };
  }, [performanceScope, activity?.state]);
  const [savingConfiguration, setSavingConfiguration] = useState(false);
  const pendingSave = useRef<Promise<boolean> | null>(null);
  const [configurationError, setConfigurationError] = useState("");
  const [concurrencyDrafts, setConcurrencyDrafts] = useState<Record<string, ConcurrencyEdit[]>>({});
  const [filterDrafts, setFilterDrafts] = useState<Record<string, Record<string, ModelFilter>>>({});
  const promptScope = promptContext?.scope || "game";
  const draftForStep = (step: string) => ({
    filter: (role: string) => filterDrafts[step]?.[role] ?? readModelFilter(promptScope + ":" + role),
    updateFilter: (role: string, filter: ModelFilter) => setFilterDrafts(previous => {
      const next = { ...previous[step] };
      const stored = readModelFilter(promptScope + ":" + role);
      const same = stored.local === filter.local && stored.online === filter.online &&
        JSON.stringify([...stored.excluded].sort()) === JSON.stringify([...filter.excluded].sort());
      if (same) delete next[role]; else next[role] = filter;
      return { ...previous, [step]: next };
    }),
    value: (role: string, model: string) => concurrencyDrafts[step]?.find(item => item.role === role && item.model === model)?.count,
    update: (edit: ConcurrencyEdit) => setConcurrencyDrafts(previous => {
      const next = (previous[step] || []).filter(item => item.role !== edit.role || item.model !== edit.model);
      if (edit.count !== modelConcurrency(promptScope, edit.role, edit.model)) next.push(edit);
      return { ...previous, [step]: next };
    }),
  });
  const snapshot = {
    scope: configurationScope, revision: configurationRevision, values: configuration, restore: Object.fromEntries(steps.map(step => [step.id, restoreConfiguration])),
    models: Object.fromEntries(steps.map(step => [step.id, step.models])),
  };
  const [saved, setSaved] = useState(snapshot);
  if (saved.scope !== configurationScope || saved.revision !== configurationRevision) {
    setSaved(snapshot);
    setConcurrencyDrafts({});
    setFilterDrafts({});
    setConfigurationError("");
  }
  const optionsChanged = (step: string) => configuration[step] !== saved.values[step];
  const changed = (step: string) => !!configurationScope && saved.scope === configurationScope &&
    (optionsChanged(step) || !!concurrencyDrafts[step]?.length || !!Object.keys(filterDrafts[step] || {}).length);
  const configurationLocked = (step: GameFlowStep) => activity?.state === "running" &&
    (activity.step === step.id || step.state === "done");
  const withConfiguration = async (action?: () => void, stepId?: string, announce = false) => {
    if (pendingSave.current && !await pendingSave.current) return false;
    const draftSteps = (stepId ? [stepId] : steps.map(step => step.id)).filter(changed);
    if (!onSaveConfiguration || !draftSteps.length) { action?.(); return true; }
    setConfigurationError("");
    const job = (async () => {
      setSavingConfiguration(true);
      try {
        await onSaveConfiguration();
        for (const step of draftSteps) {
          for (const [role, filter] of Object.entries(filterDrafts[step] || {})) saveModelFilter(promptScope + ":" + role, filter);
          for (const { role, model, count } of concurrencyDrafts[step] || []) saveModelConcurrency(promptScope, role, model, count);
        }
        setConcurrencyDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([step]) => !draftSteps.includes(step))));
        setFilterDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([step]) => !draftSteps.includes(step))));
        const committed = <T,>(prior: Record<string, T>, latest: Record<string, T>) =>
          { const next = { ...prior }; for (const step of draftSteps) next[step] = latest[step]; return next; };
        setSaved(previous => previous.scope === configurationScope ? {
          ...previous, values: committed(previous.values, snapshot.values),
          restore: committed(previous.restore, snapshot.restore), models: committed(previous.models, snapshot.models),
        } : previous);
        if (announce) showAppNotice(`${steps.find(step => step.id === stepId)?.title ?? "当前步骤"}的配置已保存。`);
        return true;
      } catch (error) {
        setConfigurationError(error instanceof Error ? error.message : String(error));
        return false;
      } finally { setSavingConfiguration(false); }
    })();
    pendingSave.current = job;
    const success = await job;
    if (pendingSave.current === job) pendingSave.current = null;
    if (success) action?.();
    return success;
  };
  const captureTestConfiguration = () => {
    const value = testConfigurations!.capture();
    const roles = imageFlow ? value.images?.roles : value.text.roles;
    if (roles) for (const step of steps) {
      for (const edit of concurrencyDrafts[step.id] || []) {
        const role = Object.keys(roles).find(key => key === edit.role) as keyof typeof roles | undefined;
        const activeModel = step.models?.find(model => model.role === edit.role)?.id;
        if (role && roles[role] && (roles[role]?.model || activeModel) === edit.model) roles[role] = { ...roles[role]!, concurrency: edit.count };
      }
    }
    return value;
  };
  const openTestConfiguration = () => {
    if (!testConfigurations) return;
    try {
      openGameAuxWindow({ kind: "configuration", scope: testConfigurations.scope, models: testConfigurations.models,
        current: captureTestConfiguration(), initialPart: imageFlow ? "images" : "text" });
    } catch (error) { showAppNotice(error instanceof Error ? error.message : String(error), "error"); }
  };
  useLayoutEffect(() => {
    if (!configurationCommit) return;
    configurationCommit.current = step => withConfiguration(undefined, step);
    return () => { configurationCommit.current = null; };
  });
  const panel = useRef<HTMLDivElement>(null);
  const cancelConfiguration = (step: string) => {
    if (optionsChanged(step)) saved.restore[step]?.(step);
    setFilterDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== step)));
    setConcurrencyDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== step)));
    setConfigurationError("");
    onConfigure(null);
  };
  const content = useRef<HTMLDivElement>(null);
  const layoutKey = steps.map(step => step.id).join("/") + ":" + configured;
  useLayoutEffect(() => {
    const element = panel.current;
    const body = content.current;
    if (!configured || !element || !body) return;
    const grow = () => {
      const height = Math.max(settingsHeights.get(layoutKey) || 0, Math.ceil(body.getBoundingClientRect().height));
      settingsHeights.set(layoutKey, height);
      element.style.minHeight = height + "px";
    };
    grow();
    const observer = new ResizeObserver(grow);
    observer.observe(body);
    return () => observer.disconnect();
  }, [configured, layoutKey]);
  return <div className="game-flow">
    <div className="game-flow-list">
      {(onRun || actions || testConfigurations) && <div className="game-flow-run">
        {testConfigurations && <button type="button" className="unity-btn" disabled={testConfigurationDisabled || savingConfiguration} onClick={openTestConfiguration}>应用测试配置</button>}
        {onRun && <button type="button" className="unity-btn unity-btn-primary" disabled={testing || savingConfiguration} title={testTitle} onClick={() => runConfigured(onRun)}>运行流程</button>}
        {actions}
      </div>}
      <ol>{steps.map(step => {
        const benchmarkStep = benchmark?.step === "imageTranslate" ? "translate" : benchmark?.step;
        const showingBenchmark = benchmarkRunning && benchmarkStep === step.id;
        const matchesActivity = activity?.step === step.id;
        const state = matchesActivity && ["running", "error", "stopped"].includes(activity.state) ? activity.state : step.state;
        const testMetrics = showingBenchmark && state !== "running";
        const displayScope = testMetrics ? scope + (imageFlow ? ":benchmark:images" : ":benchmark:text") : performanceScope;
        const measured = stepPerformance(displayScope, testMetrics && benchmark ? benchmark.step : step.id);
        const chosen = testMetrics ? undefined : saved.scope === configurationScope ? saved.models[step.id] : step.models;
        const configuredModels = (chosen || []).flatMap(({ role, id }) => id
          ? [{ model: id, concurrency: modelConcurrency(promptScope, role, id) }] : []);
        const models = groupModels(measured, configuredModels);
        const { throughput, timings } = stepMetrics(measured, testMetrics && benchmark
          ? { done: benchmark.current, elapsedMs: benchmark.elapsedMs, failed: benchmark.failed } : undefined);
        const itemUnit = imageFlow ? "张" : "条";
        const statusLabel = matchesActivity && state === "error" ? activity.label : undefined;
        const current = state === "running" || showingBenchmark || !benchmarkRunning && activity?.state !== "running" && state === "current";
        const runLabel = (state === "stopped" || state === "error") && (!step.runLabel || step.runLabel === "开始") ? "继续" : step.runLabel || "开始";
        const actionLabel = step.stop ? step.stopDisabled ? "正在中止" : "中止" : runLabel;
        const expanded = configured === step.id;
        const toggle = () => onConfigure(expanded ? null : step.id);
        const clearAllowed = !!step.clear && step.state !== "waiting" && state !== "running";
        const hasConfiguration = expanded && !!children;
        return <GameFlowCard key={step.id} title={step.title} state={state} benchmark={showingBenchmark ? benchmark : undefined} current={current}
          expanded={expanded} toggleTooltip={models.length ? undefined : expanded ? "收起设置" : "展开设置"}
          onToggle={toggle}
          status={<>{statusLabel ?? ((state === "current" || state === "done") && step.stateLabel ? step.stateLabel : stateLabels[state])}{(measured.elapsedMs > 0 || measured.started !== undefined) && <> · <span data-tooltip="步骤实际经过的时间，包含排队、处理和保存。" className="game-flow-metric">{gameDuration(measured.elapsedMs)}</span></>}</>}
          summary={<>
            {models.length ? models.map(model => {
              const rates = expanded ? tokenMetrics(model) : [];
              return <div className="game-flow-model-rates" data-model-row={model.model} key={model.model}
                style={{ flexWrap: "nowrap", fontSize: "var(--fs-caption)" }}>
                {models.length > 1 && <span className="game-flow-model-name" data-tooltip={model.model} onClick={toggle}
                  style={{ pointerEvents: "auto", cursor: "pointer", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {model.model.split("/").at(-1)}
                </span>}
                {rates.map(metric => <MetricValue key={metric.key} onToggle={toggle} compact metric={
                  metric.key === "requestRate" && model.requests > 0
                    ? { ...metric, tooltip: (metric.tooltip ?? metricDetails.requestRate) +
                      " 重叠请求时段只计一次，已记录 " + model.requests + " 次请求。" }
                    : metric
                } />)}
                {!rates.length && model.concurrency > 0 && <small>并发 <span className="game-flow-metric">{model.concurrency}</span></small>}
                {expanded && !rates.some(metric => metric.key === "requestRate") && model.requests > 0 &&
                  <small>请求 <span className="game-flow-metric">{model.requests} 次</span></small>}
              </div>;
            }) : step.summary && !testMetrics && <span>{step.summary}</span>}
            {expanded && throughput.length > 0 && <small className="game-flow-model-rates" aria-label="处理吞吐">
              {throughput.map(metric => <MetricValue key={metric.key} metric={metric} onToggle={toggle} itemUnit={itemUnit} />)}
            </small>}
            {expanded && timings.length > 0 && <small className="game-flow-model-rates" aria-label="分项用时与失败">
              {timings.map(metric => <MetricValue key={metric.key} metric={metric} onToggle={toggle} itemUnit={itemUnit} />)}
            </small>}
          </>}
          actions={<>
              {(step.run || step.stop) && <button type="button" className="unity-btn unity-btn-primary game-flow-start"
                aria-label={`${actionLabel}${step.title}`} disabled={step.stop ? step.stopDisabled : testing || step.runDisabled || savingConfiguration}
                title={step.stop ? undefined : testTitle} onClick={step.stop || (() => runConfigured(step.run, step.id))}>{actionLabel}</button>}
              <button type="button" className="unity-btn game-flow-clear" disabled={!clearAllowed||savingConfiguration} aria-label={`清理${step.title}`} onClick={step.clear}>清理</button>
          </>}
          configurationRef={panel}
          configuration={hasConfiguration &&
            <div ref={content} className="game-flow-config-content">
              <GameConcurrencyDraft.Provider value={draftForStep(step.id)}>{children}</GameConcurrencyDraft.Provider>
              {onSaveConfiguration && <div className="game-flow-config-save">
                <button type="button" className="unity-btn unity-btn-primary" disabled={savingConfiguration || configurationLocked(step) || !changed(step.id)} onClick={() => void withConfiguration(undefined, step.id, true)}>{savingConfiguration ? "保存中…" : "保存配置"}</button>
                <button type="button" className="unity-btn" disabled={savingConfiguration || configurationLocked(step)} onClick={() => cancelConfiguration(step.id)}>取消</button>
              </div>}
            </div>} />;
      })}</ol>
    </div>
    {configurationError&&<p className="unity-offline-error" role="alert">配置保存失败：{configurationError}</p>}
    {activity?.progress && <div className="game-flow-progress">{activity.progress}</div>}
  </div>;
}
