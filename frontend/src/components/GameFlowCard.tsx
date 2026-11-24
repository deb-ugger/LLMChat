import { useEffect, useId, useState, type ReactNode } from "react";
import type { BenchmarkState } from "../benchmark/benchmarkRunner";
import type { BenchmarkParameter } from "../benchmark/benchmarkParameters";
import { gameDuration } from "../gameModelPerformance";
import { GameProgressBar } from "./GameStepProgress";

export type GameFlowProgress = {
  sample?: string;
  current?: number;
  total?: number;
  completed?: number;
  unit?: string;
  configuration?: { current: number; total: number };
  successRate?: number;
  count?: string;
  percent?: number | null;
  remainingMs?: number;
  details?: ReactNode;
};

export type GameFlowActivity = {
  state: string;
  label?: ReactNode;
  elapsed?: ReactNode;
  actions?: ReactNode;
  progress?: GameFlowProgress;
  details?: ReactNode;
  statusLine?: string;
};

const expandedStorageKey = "llmchat.flow.expanded";
const expandedChangeEvent = "llmchat:flow-expanded";
type ExpandedSteps = Record<string, boolean>;

function readExpandedSteps(): ExpandedSteps {
  try {
    const value = JSON.parse(window.localStorage.getItem(expandedStorageKey) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value) &&
      Object.values(value).every(item => typeof item === "boolean")) return value;
  } catch { /* Fall back to the current workflow step. */ }
  return {};
}

export function useGameFlowExpansion() {
  const [overrides, setOverrides] = useState(readExpandedSteps);
  useEffect(() => {
    const sync = (event: Event) => setOverrides((event as CustomEvent<ExpandedSteps>).detail);
    const storage = (event: StorageEvent) => {
      if (event.key === expandedStorageKey || event.key === null) setOverrides(readExpandedSteps());
    };
    window.addEventListener(expandedChangeEvent, sync);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(expandedChangeEvent, sync);
      window.removeEventListener("storage", storage);
    };
  }, []);
  return {
    isExpanded: (id: string, fallback: boolean) => Object.hasOwn(overrides, id) ? overrides[id] : fallback,
    setExpanded: (id: string, expanded: boolean) => {
      const next = { ...overrides, ...readExpandedSteps(), [id]: expanded };
      setOverrides(next);
      try { window.localStorage.setItem(expandedStorageKey, JSON.stringify(next)); }
      catch { /* Keep the choice in the current window. */ }
      window.dispatchEvent(new CustomEvent(expandedChangeEvent, { detail: next }));
    },
  };
}

type CardProps = GameFlowActivity & {
  title: string;
  current?: boolean;
  benchmark?: BenchmarkState;
  performance?: ReactNode;
  onConfigure?: () => void;
  body?: ReactNode;
  configuration?: ReactNode;
  runningParameters?: readonly BenchmarkParameter[];
  parametersLocked?: boolean;
  saveConfiguration?: { run: () => void; disabled: boolean; saving?: boolean };
  disclosure?: { expanded: boolean; toggle: () => void };
};

export function StandaloneGameFlowCard({ stepId, ...props }: Omit<CardProps, "disclosure"> & { stepId: string }) {
  const expansion = useGameFlowExpansion();
  const expanded = expansion.isExpanded(stepId, true);
  return <GameFlowCard {...props} disclosure={{ expanded, toggle: () => expansion.setExpanded(stepId, !expanded) }} />;
}

export function GameFlowCard({ title, state, current, benchmark, label, elapsed, progress, details, statusLine, performance,
  actions, onConfigure, body, configuration, runningParameters, parametersLocked, saveConfiguration, disclosure }: CardProps) {
  const detailsId = useId();
  const settingsId = useId();
  const statusId = useId();
  const expanded = disclosure?.expanded ?? true;
  const benchmarkActive = benchmark?.state === "running";
  const active = state === "running" || benchmarkActive;
  const locked = active || parametersLocked;
  const configured = expanded && !locked && !!configuration;
  const actualParameters = benchmarkActive ? (benchmark.phase === "prepare" ? undefined : benchmark.parameters) : runningParameters;
  const showActualParameters = active && (benchmarkActive || !!(runningParameters || configuration || onConfigure));
  const position = benchmark && benchmark.round != null && benchmark.rounds != null &&
    benchmark.configIndex != null && benchmark.configCount != null
    ? `第 ${benchmark.round}/${benchmark.rounds} 轮 · 配置 ${benchmark.configIndex}/${benchmark.configCount}` : undefined;
  const configCurrent = benchmark?.sampleCurrent;
  const configTotal = benchmark?.sampleTotal;
  const configElapsed = benchmark?.configElapsedMs;
  const configCounts = configCurrent != null && configTotal != null;
  const failures = benchmark?.performance?.failures;
  const successful = configCurrent != null && failures != null ? Math.max(0, configCurrent - failures) : undefined;
  const activeProgress: GameFlowProgress | undefined = benchmark ? {
    sample: benchmark.sample,
    current: configCounts ? configCurrent : undefined,
    total: configCounts ? configTotal : undefined,
    completed: successful,
    percent: configCounts && configTotal > 0 ? 100 * configCurrent / configTotal : undefined,
    configuration: benchmark.configIndex != null && benchmark.configCount != null
      ? { current: benchmark.configIndex, total: benchmark.configCount } : undefined,
    successRate: successful != null && configTotal != null && configTotal > 0 ? 100 * successful / configTotal : undefined,
    remainingMs: configCurrent != null && configCurrent > 0 && configTotal != null && configElapsed != null && configElapsed > 0
      ? configElapsed / configCurrent * Math.max(0, configTotal - configCurrent) : undefined,
    details: progress?.details,
  } : state === "running" ? progress ?? {} : undefined;
  const percent = activeProgress?.percent == null ? undefined : Math.min(100, Math.max(0, activeProgress.percent));
  const summaryProgress = activeProgress ?? progress;
  const summaryValue = summaryProgress?.percent ?? (summaryProgress?.current != null &&
    summaryProgress.total != null && summaryProgress.total > 0 ? 100 * summaryProgress.current / summaryProgress.total : undefined);
  const summaryPercent = !benchmark && state === "done" ? 100 : summaryValue != null && Number.isFinite(summaryValue)
    ? Math.round(Math.min(100, Math.max(0, summaryValue))) : state === "pending" || state === "waiting" ? 0 : undefined;
  const sample = summaryProgress?.sample;
  const elapsedLabel = benchmark ? gameDuration(configElapsed ?? benchmark.elapsedMs) : elapsed;
  const completed = summaryProgress?.completed ?? summaryProgress?.current;
  const foldedCount = completed != null
    ? completed.toLocaleString() + " " + (progress?.unit ?? "项")
    : state === "done" && elapsedLabel != null ? "已完成" : undefined;
  const cardStateLine = statusLine || benchmark?.detail;
  const progressConfig = activeProgress?.configuration;
  const successRate = activeProgress?.successRate;
  const remainingMs = activeProgress?.remainingMs;
  const hasCounts = activeProgress?.current != null && activeProgress.total != null;
  const status = benchmark ? benchmark.state === "paused" ? "测试已暂停" : "测试中" : label;
  return <article className={`game-flow-item is-${state}${benchmark ? " is-benchmark" : ""}${benchmark?.state === "running" ? " is-benchmark-running" : ""}${current ? " is-current-step" : ""}${configured ? " is-configured" : ""}`} data-benchmark={benchmark?.state}>
    <div className="game-flow-step">
      <header className={"game-flow-head" + (disclosure ? " is-collapsible" : "")}>
        {disclosure && <button type="button" className="game-flow-head-toggle" onClick={disclosure.toggle}
          aria-label={(expanded ? "折叠" : "展开") + title + "详情"} aria-expanded={expanded} aria-controls={detailsId}
          data-tooltip={expanded ? "折叠详情" : "展开详情"} />}
        <span className="game-flow-dot" aria-hidden="true" />
        {!disclosure && onConfigure && !locked ? <button type="button" className="game-flow-title" aria-expanded={configured}
          aria-controls={settingsId} aria-describedby={statusId}
          style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer" }}
          onClick={onConfigure}>{title}</button> : <strong className="game-flow-title">{title}</strong>}
        {position && <span className="game-flow-position">{position}</span>}
        <span id={statusId} className="game-flow-state" role="status">{status}</span>
        {expanded && elapsedLabel != null && <span className="game-flow-elapsed">已用 {elapsedLabel}</span>}
        {actions && <div className="game-flow-actions">{actions}</div>}
      </header>
      {!expanded && <div className="game-flow-progress-main game-flow-collapsed-summary">
        {sample && <span className="game-flow-sample" title={sample}>{sample}</span>}
        <span>{foldedCount != null || elapsedLabel != null ? <>
          {foldedCount && <b>{foldedCount}</b>}{foldedCount && elapsedLabel != null && " · "}{elapsedLabel}
        </> : summaryPercent === undefined ? "进度 —" : summaryPercent + "%"}</span>
      </div>}
      <div id={detailsId} hidden={!expanded}>
        {activeProgress && <div className="game-flow-progress">
          {(activeProgress.sample || hasCounts || activeProgress.count) && <div className="game-flow-progress-main">
            {activeProgress.sample && <span className="game-flow-sample" data-tooltip={activeProgress.sample}>{activeProgress.sample}</span>}
            {activeProgress.current != null && activeProgress.total != null
              ? <span className="game-flow-progress-count">{activeProgress.current.toLocaleString()} <small>/ {activeProgress.total.toLocaleString()}</small></span>
              : activeProgress.count && <span className="game-flow-progress-count">{activeProgress.count}</span>}
          </div>}
          {percent === undefined ? <GameProgressBar label={title + "进度"} /> :
            <div className="game-flow-progress-bar" role="progressbar" aria-label={title + "进度"}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ inlineSize: percent + "%" }} /></div>}
          {(progressConfig || successRate != null || remainingMs != null) && <div className="game-flow-progress-meta">
            {progressConfig && <span>本配置 <b>{progressConfig.current}/{progressConfig.total}</b></span>}
            {successRate != null && <span data-tooltip="已成功样本占本配置样本总数的比例。">成功率 <b>{successRate.toLocaleString(undefined, { maximumFractionDigits: 1 })}%</b></span>}
            {remainingMs != null && <span>预计剩余 <b>{gameDuration(remainingMs)}</b></span>}
          </div>}
        </div>}
        {activeProgress?.details}
        {details}
        {performance}
        {body}
        {showActualParameters && <section id={settingsId} className="game-step-metrics-group game-flow-performance" role="region"
          aria-label={title + "运行参数"}>
          <h5 className="game-step-metrics-label">运行参数</h5>
          {actualParameters?.length ? <dl className="game-flow-parameter-list">
            {actualParameters.map(({ label, value, scope }, index) =>
              <div key={scope + ":" + label + ":" + index}><dt title={label}>{label}</dt><dd>{value}</dd></div>)}
          </dl> : <p className="hint">{benchmarkActive && benchmark.phase === "prepare" ? "正在准备本配置参数…" : "暂无本次运行参数"}</p>}
        </section>}
        {!locked && (onConfigure || configuration) && <section id={settingsId} className="game-flow-editable" role="region"
          aria-label={`${title}运行参数`} hidden={!configured}>
          <h5 className="game-flow-editable-title">运行参数<span className="game-flow-tag">可改</span>
            {saveConfiguration && <button type="button" disabled={saveConfiguration.disabled}
              onClick={saveConfiguration.run}>{saveConfiguration.saving ? "保存中…" : "保存"}</button>}
          </h5>
          <div className="game-flow-editable-fields">{configuration}</div>
        </section>}
        {cardStateLine && <div className="game-flow-state-line" role="status" data-active={active || undefined}>
          <span aria-hidden="true" /><span>{cardStateLine}</span>
        </div>}
      </div>
    </div>
  </article>;
}
