import { createContext, useLayoutEffect, useRef, useState, useContext, useEffect, type ReactNode, type RefObject } from "react";
import { GamePromptContext } from "../gamePrompts";
import { deriveFlowMetrics, type FlowMetricInput } from "../gameFlowMetrics";
import { stepPerformance, gameDuration, saveModelConcurrency, modelConcurrency, sumModelServiceTiming, modelServiceTimingLines, type StepPerformance } from "../gameModelPerformance";
import { readModelFilter, saveModelFilter, type ModelFilter } from "./ModelFilterSelect";
import { showAppNotice } from "./AppNotice";
import type { GameTestConfigurationAccess } from "../gameModelPreset";
import { openGameAuxWindow } from "../gameAuxWindows";
import { GameFlowCard, type GameFlowActivity } from "./GameFlowCard";
import type { BenchmarkParameter } from "../benchmark/benchmarkParameters";
import { benchmarkBlockingReason, isBenchmarkRunning, resumeBenchmarkJob, useBenchmarkProgress, useBenchmarkRunning, usePausedBenchmarkProgress, type BenchmarkState, type BenchmarkTarget } from "../benchmark/benchmarkRunner";

export type GameFlowStep = {
  id: string;
  title: string;
  summary?: string;
  models?: { role: string; id?: string }[];
  state: "done" | "current" | "waiting";
  stateLabel?: string;
  runningParameters?: BenchmarkParameter[];
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

type Activity = GameFlowActivity & { step: string };
const stateLabels: Record<string, string> = {
  done: "已完成", current: "未完成", waiting: "等待上一步",
  running: "正在处理", error: "失败", stopped: "已中止",
};
const formatTiming = (value: number | undefined) => {
  if (value === undefined) return "—";
  if (value > 0 && value < 100) return value.toFixed(value < 1 ? 2 : 0) + " 毫秒";
  return value < 60000 ? (value / 1000).toFixed(1) + " 秒" : gameDuration(value);
};

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
      serviceTiming: sumModelServiceTiming(sum.serviceTiming, item.serviceTiming),
    }), { tokens: 0, requests: 0, generationTokens: 0, serviceTiming: undefined as ModelStats["serviceTiming"] });
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
  detectorMs: "ONNX 运行时执行检测的经过时间，包含运行时调度和数据传输。",
  ocrMs: "本地 OCR 调用的经过时间，包含识别内部的图像预处理和结果解析。",
  cacheHits: "直接复用可用结果的次数。每次复用省去一次对应的检测或识别调用。",
  workflowMs: "ComfyUI 记录的工作流开始至结束用时，逐次累加。包含节点内部的 CPU 与 GPU 时间。",
  busyMs: "模型请求在途的墙钟时间，并发重叠只计一次。查看「模型请求合计」时，并发请求重叠的部分会被逐次累加，因此可能大于该步骤实际经过的时间。",
  idleMs: "步骤运行中没有任何模型请求在途的时间。",
};

function stepMetrics(measured: FlowMeasurement, samples?: { done: number; elapsedMs: number; failed: number }) {
  const busyMs = measured.busyMs ?? measured.wallTiming?.modelRequestMs;
  const input: FlowMetricInput = {
    itemsDone: measured.itemsDone ?? samples?.done,
    elapsedMs: samples?.elapsedMs ?? (measured.taskId || measured.elapsedMs > 0 ? measured.elapsedMs : undefined),
    failures: measured.failures ?? samples?.failed,
    queueMs: measured.queueMs ?? measured.wallTiming?.queueMs ?? measured.timing?.queueMs,
    processingMs: measured.processingMs ?? measured.wallTiming?.processingMs ?? measured.timing?.processingMs,
    saveMs: measured.saveMs ?? measured.wallTiming?.saveMs ?? measured.timing?.saveMs,
    detectorMs: measured.wallTiming?.detectorMs,
    ocrMs: measured.wallTiming?.ocrMs,
    cacheHits: measured.cacheHits,
    workflowMs: measured.timing?.workflowMs,
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
  return { throughput, timings, input };
}


function GameModelServiceTiming({ timing, requests }: {
  timing: NonNullable<ModelStats["serviceTiming"]>; requests: number;
}) {
  const [total, phases] = modelServiceTimingLines(timing, requests, formatTiming);
  return <small className="game-flow-model-service">
    <span data-tooltip="模型就绪可能包含 Ollama 内部等待。服务外开销为同一请求的总耗时减去 Ollama 回报的服务耗时，包含后台处理与往返。并发时逐次累加。输入评估与输出生成合计包含 CPU 与 GPU 时间。">
      {total}<br />{phases}
    </span>
  </small>;
}

const emptyPerformance: StepPerformance = { elapsedMs: 0, models: {} };
const textBenchmarkTargets = ["screen", "translate"] as const;
const imageBenchmarkTargets: readonly BenchmarkTarget[] = ["filter", "refine", "recognize", "imageTranslate", "review", "render"];

const liveTimings = [
  ["elapsedMs", "用时"], ["queueMs", "排队"], ["processingMs", "处理与校验"], ["saveMs", "保存"],
  ["busyMs", "模型请求占用"], ["idleMs", "无在途模型请求"],
] as const;

function MetricsValues({ values }: { values: readonly { label: string; value: ReactNode; detail?: string }[] }) {
  return <div className="game-benchmark-running-params">{values.map(({ label, value, detail }) =>
    <span className="kv" key={label} data-tooltip={detail}><span>{label}</span>
      <b title={typeof value === "string" ? value : undefined}>{value}</b></span>
  )}</div>;
}

export function GameFlowPerformance({ measured = emptyPerformance, models = [] }: {
  measured?: StepPerformance;
  models?: ConfiguredModel[];
}) {
  const rateColumns = [
    { key: "generationRate", label: "纯生成" },
    { key: "requestRate", label: "请求平均" },
  ] as const;
  const rows = groupModels(measured, models).map(row => {
    const generationMs = Object.values(measured.models).filter(model => model.model === row.model)
      .reduce((total, model) => total + model.generationMs, 0);
    const rates = tokenMetrics({ ...row, generationMs });
    return {
      model: row.model,
      name: row.model.split("/").at(-1),
      requests: row.requests,
      rates: rateColumns.map(column => {
        const rate = rates.find(metric => metric.key === column.key);
        return { ...column, value: rate ? rate.value + "\u00a0tok/s" : "—" };
      }),
    };
  });
  const { timings, input } = stepMetrics(measured);
  const timingColors = { queueMs: "var(--accent)", processingMs: "var(--signal)", saveMs: "var(--success)", busyMs: "var(--warning)" } as const;
  const segments = (Object.keys(timingColors) as (keyof typeof timingColors)[]).flatMap(key => {
    const metric = timings.find(timing => timing.key === key);
    return metric ? [{ metric, ms: input[key] ?? 0, color: timingColors[key] }] : [];
  });
  const duration = segments.reduce((total, segment) => total + segment.ms, 0);
  if (!rows.length && !segments.length) return null;
  return <section className="game-step-metrics-group is-performance game-flow-performance" aria-label="性能">
    <h4 className="game-step-metrics-label">{rows.length ? "模型性能" : "性能"} <small>只读</small></h4>
    {rows.length > 0 && <>
      <div className="game-benchmark-compare-table game-flow-performance-wide">
        <table style={{ tableLayout: "fixed" }}>
          <thead><tr><th scope="col" style={{ width: "40%" }}>模型</th><th scope="col">请求</th>
            {rateColumns.map(({ key, label }) => <th key={key} scope="col">{label}</th>)}
          </tr></thead>
          <tbody>{rows.map(row => <tr key={row.model} data-model-row={row.model}>
            <th scope="row"><span className="game-step-metric-model" data-tooltip={row.model}>{row.name}</span></th>
            <td>{row.requests} 次</td>
            {row.rates.map(({ key, value }) => <td key={key} data-tooltip={metricDetails[key]}>{value}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
      <ul className="game-flow-performance-compact" role="list">
        {rows.map(row => <li key={row.model} data-model-row={row.model}>
          <div className="game-flow-model-identity">
            <strong className="game-step-metric-model" data-tooltip={row.model}>{row.name}</strong>
            <span>请求 <b>{row.requests} 次</b></span>
          </div>
          <dl className="game-flow-model-speed">
            {row.rates.map(({ key, label, value }) => <div key={key} data-tooltip={metricDetails[key]}>
              <dt>{label}</dt><dd>{value}</dd>
            </div>)}
          </dl>
        </li>)}
      </ul>
    </>}
    {duration > 0 && <div className="game-flow-progress-bar" style={{ display: "flex" }} aria-hidden="true">
      {segments.filter(segment => segment.ms > 0).map(({ metric, ms, color }) =>
        <i key={metric.key} style={{ inlineSize: 100 * ms / duration + "%", background: color, borderRadius: 0 }} />)}
    </div>}
    {segments.length > 0 && <small className="game-flow-model-rates" aria-label="分项用时">
      {segments.map(({ metric, color }) => <span key={metric.key} style={{ color }} data-tooltip={metricDetails[metric.key]}>
        {metric.label} <b className="game-flow-metric">{metric.value}</b>
      </span>)}
    </small>}
  </section>;
}

type RunningQueueMetrics = { position: number; ahead?: number; startedTime?: string };

export function StepRunningMetrics({ measured = emptyPerformance, models = [], parameters = [], benchmark, queue,
  device, elapsedMs, stopped = false, itemUnit = "张" }: {
  measured?: StepPerformance;
  models?: ConfiguredModel[];
  parameters?: readonly BenchmarkParameter[];
  benchmark?: BenchmarkState;
  queue?: RunningQueueMetrics;
  device?: string;
  elapsedMs?: number;
  stopped?: boolean;
  itemUnit?: "张" | "条";
}) {
  const elapsed = measured.taskId || measured.started !== undefined ? measured.elapsedMs : elapsedMs;
  const { throughput, timings } = stepMetrics(measured);
  const timingMetrics = [...throughput, ...timings];
  const modelGroups = groupModels(measured, models);
  const average = benchmark && benchmark.current > 0 && benchmark.elapsedMs > 0
    ? benchmark.elapsedMs / benchmark.current : undefined;
  const remaining = benchmark && average !== undefined ? average * Math.max(0, benchmark.total - benchmark.current) : undefined;
  const parameterRows = benchmark ? benchmark.parameters ?? [] : [...parameters,
    ...models.map(({ model, concurrency }, index): BenchmarkParameter => ({
      scope: "config", label: "模型 " + (index + 1), value: model + " · 并发 " + concurrency,
    }))];
  const actualModels = Object.values(measured.models);
  const outcomes = actualModels.flatMap(model => model.outcomes ? [model.outcomes] : []);
  const requestCounts = (key: "succeeded" | "failed" | "cancelled") => outcomes.length
    ? outcomes.reduce((total, value) => total + value[key], 0) : "—";
  const taskParameters = parameterRows.filter(item => item.scope === "task");
  const configParameters = parameterRows.filter(item => item.scope !== "task");
  const paused = stopped || benchmark?.state === "paused";
  const summaryElapsed = elapsed ?? benchmark?.elapsedMs;
  const requests = actualModels.reduce((total, model) => total + model.requests, 0);
  const eta = remaining === undefined ? "—" : gameDuration(remaining).replace(/^00:/, "");
  const summary = [paused ? "已暂停" : undefined, "用时 " + (summaryElapsed === undefined ? "—" : gameDuration(summaryElapsed)),
    "请求 " + requests, "预计剩余 " + eta].filter(Boolean).join(" ｜ ");
  return <details className="game-step-running-metrics">
    <summary title={summary}><span>{summary}</span><span className="game-step-metrics-arrow" aria-hidden="true" /></summary>
    <div className="game-flow-model-list">
      <section className="game-step-metrics-group is-performance">
        <h4 className="game-step-metrics-label">性能</h4>
        {modelGroups.map(model => {
          const records = actualModels.filter(record => record.model === model.model);
          const generationMs = records.reduce((total, record) => total + record.generationMs, 0);
          const rates = tokenMetrics({ ...model, generationMs });
          const services = [...new Set(records.flatMap(record => record.service ? [record.service === "local" ? "本地" : "在线"] : []))];
          const usages = [
            ["promptTokens", "输入"], ["completionTokens", "输出"], ["totalTokens", "合计"],
            ["cacheReadTokens", "缓存读取"], ["cacheWriteTokens", "缓存写入"],
          ] as const;
          return <div key={model.model} data-model-row={model.model}>
            <strong className="game-step-metric-model" title={model.model}>{model.model.split("/").at(-1)}</strong>
            <MetricsValues values={[
              { label: "并发", value: model.concurrency || "—", detail: "模型配置的并发数。" },
              { label: "请求", value: model.requests + " 次" },
              ...(["generationRate", "requestRate"] as const).map((key, index) => {
                const rate = rates.find(item => item.key === key);
                return { label: index === 0 ? "纯生成" : "请求平均",
                  value: rate ? rate.value + " tok/s" : "—",
                  detail: rate ? key === "generationRate" ? "输出 token 除以各请求报告的生成耗时合计。" : metricDetails[key]
                    : "等待模型返回 token 和相应计时。服务未报告这些数据时无读数。" };
              }),
              { label: "模型服务", value: services.join("、") || "—", detail: "请求层报告的服务类型。" },
            ]} />
            {(() => {
              const rows = usages.flatMap(([key, label]) => {
                const values = records.flatMap(record => {
                  const count = record.usage?.[key];
                  return count === undefined ? [] : [count];
                });
                return values.length ? [{ label: label + " token", value: values.reduce((sum, value) => sum + value, 0),
                  detail: "仅累计服务实际报告的 token 数。" }] : [];
              });
              return rows.length ? <MetricsValues values={rows} /> :
                <small data-tooltip="模型服务尚未返回可统计的输入、输出或缓存 token。">Token 用量 —</small>;
            })()}
            {model.serviceTiming && <GameModelServiceTiming timing={model.serviceTiming} requests={model.requests} />}
          </div>;
        })}
        {!modelGroups.length && <small data-tooltip="此步骤不使用模型，或模型请求尚未发出。">模型 —</small>}
        <MetricsValues values={[
          ...liveTimings.map(([key, label]) => {
            const metric = timingMetrics.find(item => item.key === key);
            return { label, value: key === "elapsedMs" ? formatTiming(elapsed) : metric?.value ?? "—",
              detail: metric?.tooltip ?? metricDetails[key] ?? "当前步骤尚未提供计时。" };
          }),
          ...timings.filter(metric => !liveTimings.some(([key]) => key === metric.key) && !["failures", "cacheHits"].includes(metric.key)).map(metric =>
            ({ label: metric.label, value: metric.value + (metric.unit ? " " + metric.unit : ""), detail: metricDetails[metric.key] })),
          ...(!benchmark ? [
            ...(measured.itemsDone == null ? [] : [{ label: "已处理", value: measured.itemsDone + " " + itemUnit }]),
            ...(measured.failures == null ? [] : [{ label: "样本失败", value: measured.failures + " " + itemUnit }]),
            ...(measured.itemsDone && elapsed ? [{ label: "墙钟平均每样本", value: formatTiming(elapsed / measured.itemsDone),
              detail: "步骤经过时间除以已处理样本数。" }] : []),
          ] : []),
          { label: "设备", value: device ?? "—", detail: "当前执行器未报告计算设备时没有读数。" },
          { label: "请求成功", value: requestCounts("succeeded"), detail: "仅统计请求层已返回的结果。" },
          { label: "请求失败", value: requestCounts("failed"), detail: "仅统计请求层已返回的结果。" },
          { label: "请求取消", value: requestCounts("cancelled"), detail: "仅统计请求层已返回的结果。" },
          { label: "结果复用", value: measured.cacheHits ?? "—", detail: "仅支持主动记录结果复用的步骤。" },
          { label: "文本请求重试", value: measured.textRequestRetries ?? "—", detail: "统计文本调度器实际重新发出的限流或超时请求。其他执行器未上报该项。" },
          { label: "最长单样本", value: "—", detail: "执行器尚未记录各样本独立耗时。" },
        ]} />
      </section>
      {(benchmark || taskParameters.length > 0) && <section className="game-step-metrics-group is-task">
        <h4 className="game-step-metrics-label">任务</h4>
        {benchmark && <MetricsValues values={[
          { label: "阶段", value: paused ? "已暂停" : { prepare: "准备", execute: "执行", finish: "收尾" }[benchmark.phase] },
          { label: "轮次", value: benchmark.round === undefined ? "—" : benchmark.round + " / " + benchmark.rounds },
          { label: "配置", value: benchmark.configIndex === undefined ? "—" : benchmark.configIndex + " / " + benchmark.configCount },
          { label: "本配置样本", value: benchmark.sampleTotal === undefined ? "—" : benchmark.sampleCurrent + " / " + benchmark.sampleTotal },
          { label: "整批样本", value: benchmark.total ? benchmark.current + " / " + benchmark.total : "—" },
          { label: "当前样本", value: benchmark.sample || "—", detail: benchmark.sample || "尚未报告当前样本。" },
          { label: "样本失败", value: benchmark.failed + " " + itemUnit },
          { label: "墙钟平均每样本", value: formatTiming(average), detail: "整批已运行时间除以已处理样本数。" },
          { label: "预计剩余", value: formatTiming(remaining),
            detail: "按当前整批样本处理速度估算，不含暂停。" },
          ...(queue ? [
            { label: "队列位置", value: queue.position },
            { label: "前方任务", value: queue.ahead ?? "—", detail: "运行任务前方为 0，暂停期间顺序将在继续时确定。" },
            { label: "开始时间", value: queue.startedTime ? new Date(queue.startedTime).toLocaleString() : "—" },
            { label: "整批已运行", value: formatTiming(benchmark.elapsedMs) },
            { label: "整批预计用时", value: formatTiming(average === undefined ? undefined : average * benchmark.total) },
          ] : []),
        ]} />}
        {taskParameters.length > 0 && <MetricsValues values={taskParameters} />}
      </section>}
      {configParameters.length > 0 && <section className="game-step-metrics-group is-config">
        <h4 className="game-step-metrics-label">当前配置</h4>
        <MetricsValues values={configParameters} />
      </section>}
    </div>
  </details>;
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
  runningParameters?: BenchmarkParameter[];
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
  const pausedBenchmark = usePausedBenchmarkProgress(scope, imageFlow ? imageBenchmarkTargets : textBenchmarkTargets);
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
  const cancelConfiguration = (step: string) => {
    if (optionsChanged(step)) saved.restore[step]?.(step);
    setFilterDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== step)));
    setConcurrencyDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== step)));
    setConfigurationError("");
  };
  const defaultStep = steps.find(step => activity?.state === "running" && step.id === activity.step) ??
    steps.find(step => step.state === "current") ?? steps[0];
  useLayoutEffect(() => {
    if (defaultStep && !steps.some(step => step.id === configured)) onConfigure(defaultStep.id);
  }, [configured, defaultStep, onConfigure, steps]);
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
        const pausedStep = pausedBenchmark?.step === "imageTranslate" ? "translate" : pausedBenchmark?.step;
        const pausedResume = pausedBenchmark?.jobId && pausedStep === step.id ? pausedBenchmark.jobId : undefined;
        const formalMeasurement = stepPerformance(performanceScope, step.id);
        const formalPaused = state === "stopped" && !!formalMeasurement.taskId;
        const displayedTest = state === "running" || formalPaused && !showingBenchmark ? undefined
          : showingBenchmark ? benchmark : pausedStep === step.id ? pausedBenchmark : undefined;
        const testMetrics = !!displayedTest;
        const measured = testMetrics ? displayedTest?.performance ?? emptyPerformance : formalMeasurement;
        const chosen = testMetrics ? undefined : saved.scope === configurationScope ? saved.models[step.id] : step.models;
        const configuredModels = (chosen || []).flatMap(({ role, id }) => id
          ? [{ model: id, concurrency: modelConcurrency(promptScope, role, id) }] : []);
        const statusLabel = matchesActivity && ["running", "error", "stopped"].includes(state) ? activity.label : undefined;
        const current = state === "running" || showingBenchmark || !benchmarkRunning && activity?.state !== "running" && state === "current";
        const runLabel = (state === "stopped" || state === "error") && (!step.runLabel || step.runLabel === "开始") ? "继续" : step.runLabel || "开始";
        const actionLabel = step.stop ? (step.stopDisabled ? "正在中止" : "中止") : runLabel;
        const expanded = configured === step.id;
        const clearAllowed = !!step.clear && step.state !== "waiting" && state !== "running";
        const hasConfiguration = expanded && !!children;
        const liveActivity = matchesActivity && (!benchmarkRunning || activity.state === "running") ? activity : undefined;
        const elapsed = liveActivity?.elapsed ?? (measured.elapsedMs > 0 || measured.started !== undefined
          ? gameDuration(measured.elapsedMs) : undefined);
        return <li key={step.id} style={{ minInlineSize: 0 }}><GameFlowCard title={step.title} state={state} benchmark={displayedTest} current={current}
          onConfigure={() => { if (!expanded) onConfigure(step.id); }}
          label={statusLabel ?? ((state === "current" || state === "done") && step.stateLabel ? step.stateLabel : stateLabels[state])}
          elapsed={elapsed}
          progress={liveActivity?.progress}
          details={liveActivity?.details ?? (!Object.keys(measured.models).length && !configuredModels.length && step.summary &&
            <small className="game-flow-model-rates">{step.summary}</small>)}
          performance={(expanded || state === "running" || formalPaused || testMetrics) &&
            <GameFlowPerformance measured={measured} models={configuredModels} />}
          actions={<>
              {liveActivity?.actions}
              {(step.run || step.stop) && <button type="button" className="unity-btn unity-btn-primary game-flow-start"
                aria-label={`${pausedResume ? "继续" : actionLabel}${step.title}`} disabled={step.stop ? step.stopDisabled : testing || step.runDisabled || savingConfiguration}
                title={step.stop ? undefined : pausedResume ? "从中止处继续这次测试" : testTitle}
                onClick={step.stop || (pausedResume ? () => { resumeBenchmarkJob(pausedResume); } : () => runConfigured(step.run, step.id))}>{pausedResume ? "继续" : actionLabel}</button>}
              <button type="button" className="unity-btn game-flow-clear" disabled={!clearAllowed||savingConfiguration} aria-label={`清理${step.title}`} onClick={step.clear}>清理</button>
          </>}
          saveConfiguration={hasConfiguration && onSaveConfiguration ? {
            disabled: savingConfiguration || configurationLocked(step) || !changed(step.id),
            saving: savingConfiguration,
            run: () => void withConfiguration(undefined, step.id, true),
          } : undefined}
          configuration={hasConfiguration && <div className="game-flow-field-wide game-flow-config-content">
            <GameConcurrencyDraft.Provider value={draftForStep(step.id)}>{children}</GameConcurrencyDraft.Provider>
            {onSaveConfiguration && <div className="game-flow-config-save">
              <button type="button" className="unity-btn" disabled={savingConfiguration || configurationLocked(step)}
                onClick={() => cancelConfiguration(step.id)}>取消</button>
            </div>}
          </div>} /></li>;
      })}</ol>
    </div>
    {configurationError&&<p className="unity-offline-error" role="alert">配置保存失败：{configurationError}</p>}
  </div>;
}
