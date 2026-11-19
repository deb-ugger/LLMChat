import { createContext, useLayoutEffect, useRef, useState, useContext, useEffect, type ReactNode, type RefObject } from "react";
import { GamePromptContext } from "../gamePrompts";
import { stepPerformance, gameDuration, saveModelConcurrency, modelConcurrency } from "../gameModelPerformance";
import { readModelFilter, saveModelFilter, type ModelFilter } from "./ModelFilterSelect";
import { showAppNotice } from "./AppNotice";
import type { GameTestConfigurationAccess } from "../gameModelPreset";
import { openGameAuxWindow } from "../gameAuxWindows";

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

type Activity = { step: string; state: string; progress?: ReactNode };
const stateLabels: Record<string, string> = {
  done: "已完成", current: "未完成", waiting: "等待上一步",
  running: "正在处理", error: "失败", stopped: "已中止",
};
// Layout-only session state. Closing the app starts a new module instance.
const formatTiming = (value: number | undefined) => value === undefined ? "—" : value < 60000 ? (value / 1000).toFixed(1) + " 秒" : gameDuration(value);
const settingsHeights = new Map<string, number>();

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
  const benchmarkQueue = configurationScope ? stepPerformance(scope + ":benchmark-total", "queue") : undefined;
  const benchmarkRunning = benchmarkQueue?.started !== undefined &&
    (benchmarkQueue.benchmark?.part ?? "text") === (imageFlow ? "images" : "text");
  const [, refreshPerformance] = useState(0);
  useEffect(() => {
    const refresh = () => refreshPerformance(value => value + 1);
    window.addEventListener("llmchat-game-performance", refresh);
    const timer = activity?.state === "running" || benchmarkRunning ? window.setInterval(refresh, 1000) : undefined;
    return () => { window.removeEventListener("llmchat-game-performance", refresh); window.clearInterval(timer); };
  }, [performanceScope, activity?.state, benchmarkRunning]);
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
        {onRun && <button type="button" className="unity-btn unity-btn-primary" disabled={savingConfiguration} onClick={()=>void withConfiguration(onRun)}>运行流程</button>}
        {actions}
      </div>}
      <ol>{steps.map(step => {
        const benchmarkStep = benchmarkQueue?.benchmark?.step || "translate";
        const showingBenchmark = benchmarkRunning && (benchmarkStep === step.id || benchmarkStep === "imageTranslate" && step.id === "translate");
        const displayScope = showingBenchmark ? scope + (imageFlow ? ":benchmark:images" : ":benchmark:text") : performanceScope;
        const metricStep = showingBenchmark && benchmarkStep === "imageTranslate" ? "imageTranslate" : step.id;
        const measured = stepPerformance(displayScope, metricStep);
        const chosen = showingBenchmark ? undefined : saved.scope === configurationScope ? saved.models[step.id] : step.models;
        const round = measured.benchmark?.round;
        const rounds = benchmarkQueue?.benchmark?.rounds;
        const label = measured.benchmark?.label;
        const modelKeys = new Map<string, { model: string; concurrency: number }>();
        for (const { role, id } of chosen || []) {
          if (!id) continue;
          const concurrency = modelConcurrency(promptScope, role, id);
          modelKeys.set(JSON.stringify([id, concurrency]), { model: id, concurrency });
        }
        const models = chosen ? [...modelKeys].map(([key, model]) => measured.models[key] || { ...model, tokens: 0, requestMs: 0, generationTokens: 0, generationMs: 0, requests: 0 }) : Object.values(measured.models);
        const matchesActivity = activity?.step === step.id;
        const state = matchesActivity && ["running", "error", "stopped"].includes(activity.state) ? activity.state : step.state;
        const current = showingBenchmark || !benchmarkRunning && (state === "running" || activity?.state !== "running" && state === "current");
        const runLabel = (state === "stopped" || state === "error") && (!step.runLabel || step.runLabel === "开始") ? "继续" : step.runLabel || "开始";
        const actionLabel = step.stop ? step.stopDisabled ? "正在中止" : "中止" : runLabel;
        const expanded = configured === step.id;
        const clearAllowed = !!step.clear && step.state !== "waiting" && state !== "running";
        const hasConfiguration = expanded && !!children;
        return <li key={step.id} className={`game-flow-item is-${state}${showingBenchmark ? " is-benchmark" : ""}${current ? " is-current-step" : ""}${hasConfiguration ? " is-configured" : ""}`}>
          <div className="game-flow-step">
          <div className="game-flow-row">
            <button type="button" className="game-flow-step-toggle" aria-label={`${expanded ? "收起" : "展开"}${step.title}设置`}
              aria-expanded={expanded} data-tooltip={models.length ? undefined : expanded ? "收起设置" : "展开设置"} onClick={() => onConfigure(expanded ? null : step.id)} />
            <div className="game-flow-step-main"><strong>{step.title}</strong><small>{showingBenchmark ? "性能测试中" : (state === "current" || state === "done") && step.stateLabel ? step.stateLabel : stateLabels[state]}{!(state === "done" && step.stateLabel && !measured.elapsedMs) && <> · <span data-tooltip="步骤实际经过的时间，包含排队、处理和保存。" className="game-flow-metric">{gameDuration(measured.elapsedMs)}</span></>}</small></div>
            <div className="game-flow-summary" style={{display:"block",overflow:"visible",WebkitLineClamp:"unset"}}>
              {showingBenchmark && benchmarkQueue && <div className="game-flow-model-rates">
                <span className="game-flow-model-name">性能测试</span>
                {typeof round === "number" && typeof rounds === "number" && <span>第 {round} / {rounds} 轮</span>}
                <span>{typeof label === "string" ? label : "正在准备"}</span>
                <span>队列用时 <b className="game-flow-metric">{gameDuration(benchmarkQueue.elapsedMs)}</b></span>
              </div>}
              {models.length ? models.map(model => {
                const pureRate = model.generationMs > 0 ? (model.generationTokens * 1000 / model.generationMs).toFixed(1) : "—";
                const requestRate = model.requestMs > 0 && model.tokens > 0 ? (model.tokens * 1000 / model.requestMs).toFixed(1) : "—";
                return <div key={JSON.stringify([model.model, model.concurrency])} style={{ marginBlock: 4 }}>
                  <div className="game-flow-model-heading">
                    <span className="game-flow-model-name">{model.model.split("/").at(-1)}</span>
                    <small className="game-flow-model-concurrency">并发 <span className="game-flow-metric">{model.concurrency}</span></small>
                  </div>
                  <small className="game-flow-model-rates">
                    <span>纯生成 <span className="game-flow-metric">{pureRate} tok/s</span></span>
                    <span>请求平均 <span className="game-flow-metric">{requestRate} tok/s</span></span>
                  </small>
                  <small style={{ display: "block" }} data-tooltip="已计入的模型请求逐次相加。应用排队、本地处理与保存另计，并发请求的耗时可能重叠。">请求耗时合计 <span className="game-flow-metric">{gameDuration(model.requestMs)}</span> · <span className="game-flow-metric">{model.requests} 次</span></small>
                </div>;
              }) : <><span>{showingBenchmark ? "等待模型统计" : step.summary}</span><small style={{ display: "block" }}>纯生成 — tok/s · 请求平均 — tok/s</small></>}
              {(measured.wallTiming || measured.timing) && <small className="game-flow-model-rates" aria-label="非模型分项用时" data-tooltip="同一分项中重叠的时段只计一次。不同分项之间仍可能重叠。">
                <span>{measured.wallTiming ? "非模型用时" : "历史累计"}</span>
                <span>排队 <span className="game-flow-metric">{formatTiming((measured.wallTiming || measured.timing)?.queueMs)}</span></span>
                <span>处理与校验 <span className="game-flow-metric">{formatTiming((measured.wallTiming || measured.timing)?.processingMs)}</span></span>
                <span>保存 <span className="game-flow-metric">{formatTiming((measured.wallTiming || measured.timing)?.saveMs)}</span></span>
              </small>}
              {measured.wallTiming?.modelRequestMs !== undefined && <small className="game-flow-model-rates"
                data-tooltip="从模型请求发出到返回，重叠请求只计一次；没有在途请求的时间单独显示。">
                <span>模型请求占用 <span className="game-flow-metric">{formatTiming(measured.wallTiming.modelRequestMs)}</span></span>
                {measured.requestTimingComplete && <span>无在途模型请求 <span className="game-flow-metric">{formatTiming(Math.max(0, measured.elapsedMs - measured.wallTiming.modelRequestMs))}</span></span>}
              </small>}
            </div>
            <div className="game-flow-actions">
              {(step.run || step.stop) && <button type="button" className="unity-btn unity-btn-primary game-flow-start"
                aria-label={`${actionLabel}${step.title}`} disabled={step.stop ? step.stopDisabled : step.runDisabled || savingConfiguration}
                onClick={step.stop || (()=>void withConfiguration(step.run, step.id))}>{actionLabel}</button>}
              <button type="button" className="unity-btn game-flow-clear" disabled={!clearAllowed||savingConfiguration} aria-label={`清理${step.title}`} onClick={step.clear}>清理</button>
            </div>
          </div>
          </div>
          {hasConfiguration && <div ref={panel} className="game-flow-config" role="region" aria-label={`${step.title}设置`}>
            <div ref={content} className="game-flow-config-content">
              <GameConcurrencyDraft.Provider value={draftForStep(step.id)}>{children}</GameConcurrencyDraft.Provider>
              {onSaveConfiguration && <div className="game-flow-config-save">
                <button type="button" className="unity-btn unity-btn-primary" disabled={savingConfiguration || configurationLocked(step) || !changed(step.id)} onClick={() => void withConfiguration(undefined, step.id, true)}>{savingConfiguration ? "保存中…" : "保存配置"}</button>
                <button type="button" className="unity-btn" disabled={savingConfiguration || configurationLocked(step)} onClick={() => cancelConfiguration(step.id)}>取消</button>
              </div>}
            </div>
          </div>}
        </li>;
      })}</ol>
    </div>
    {configurationError&&<p className="unity-offline-error" role="alert">配置保存失败：{configurationError}</p>}
    {activity?.progress && <div className="game-flow-progress">{activity.progress}</div>}
  </div>;
}
