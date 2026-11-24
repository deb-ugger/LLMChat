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
  foldedSummary?: { completed?: number; failed?: number; models?: readonly string[]; concurrency?: number };
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
  actions, onConfigure, body, configuration, runningParameters, foldedSummary, parametersLocked, saveConfiguration, disclosure }: CardProps) {
  const detailsId = useId();
  const settingsId = useId();
  const statusId = useId();
  const expanded = disclosure?.expanded ?? true;
  const benchmarkActive = benchmark?.state === "running";
  const active = state === "running" || benchmarkActive;
  const locked = active || parametersLocked;
  const configured = expanded && (!locked || active) && !!configuration;
  const readOnlyParameters = !active && !configuration ? benchmark?.parameters ?? runningParameters : undefined;
  const showReadOnlyParameters = !!readOnlyParameters?.length;
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
  const elapsedLabel = benchmark ? gameDuration(configElapsed ?? benchmark.elapsedMs) : elapsed;
  const completed = summaryProgress?.completed ?? (benchmark ? undefined : foldedSummary?.completed) ?? summaryProgress?.current;
  const unit = progress?.unit ?? "项";
  const cardStateLine = statusLine || benchmark?.detail;
  const progressConfig = activeProgress?.configuration;
  const successRate = activeProgress?.successRate;
  const remainingMs = activeProgress?.remainingMs;
  const hasCounts = activeProgress?.current != null && activeProgress.total != null;
  const recordedModels = Object.values(benchmark?.performance?.models ?? {});
  const modelValues = benchmark ? (recordedModels.length ? recordedModels.map(model => model.model)
    : benchmark.parameters?.filter(p => p.label.endsWith("模型")).map(p => p.value)) : foldedSummary?.models;
  const modelNames = [...new Set(modelValues?.filter(value => value && value !== "—").map(value => value.split("/").at(-1)))];
  const concurrency = benchmark ? Math.max(0, ...recordedModels.map(model => model.concurrency),
    ...(benchmark.parameters ?? []).filter(p => p.label.endsWith("并发")).map(p => Number.parseInt(p.value, 10) || 0))
    : foldedSummary?.concurrency;
  const failed = benchmark ? benchmark.performance?.failures : foldedSummary?.failed;
  const total = summaryProgress?.total;
  const summaryCount = completed != null ? completed.toLocaleString() + (total != null
    ? " / " + total.toLocaleString() : "") + " " + unit : undefined;
  const modelsText = modelNames.join(" → ");
  const summaryRows = [
    { key: "count", text: summaryCount },
    { key: "failure", text: failed != null && failed > 0 ? "失败 " + failed.toLocaleString() + " " + unit : undefined },
    { key: "models", text: modelsText },
    { key: "concurrency", text: concurrency != null && concurrency > 1 ? "并发 " + concurrency : undefined },
    { key: "round", text: active ? position : undefined },
  ].filter(row => row.text);
  const status = benchmark ? benchmark.state === "paused" ? "测试已暂停" : "测试中" : label;
  return <article className={`game-flow-item is-${state}${benchmark ? " is-benchmark" : ""}${benchmark?.state === "running" ? " is-benchmark-running" : ""}${current ? " is-current-step" : ""}${configured ? " is-configured" : ""}`} data-benchmark={benchmark?.state}>
    <div className="game-flow-step">
      <header className={"game-flow-head" + (disclosure ? " is-collapsible" : "") + (expanded ? "" : " is-folded")}>
        {disclosure && <button type="button" className="game-flow-head-toggle" onClick={disclosure.toggle}
          aria-label={(expanded ? "折叠" : "展开") + title + "详情"} aria-expanded={expanded} aria-controls={detailsId}
          data-tooltip={expanded ? "折叠详情" : "展开详情"} />}
        <span className="game-flow-dot" aria-hidden="true" />
        {!disclosure && onConfigure && !locked ? <button type="button" className="game-flow-title" aria-expanded={configured}
          aria-controls={settingsId} aria-describedby={statusId}
          style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer" }}
          onClick={onConfigure}>{title}</button> : <strong className="game-flow-title">{title}</strong>}
        {expanded && position && <span className="game-flow-position">{position}</span>}
        <span id={statusId} className="game-flow-state" role="status">{status}</span>
        {elapsedLabel != null && <span className="game-flow-elapsed">{(expanded || active) && "已用 "}{elapsedLabel}</span>}
        {actions && <div className="game-flow-actions">{actions}</div>}
      </header>
      {!expanded && summaryRows.length > 0 && <div className="game-flow-collapsed-summary">
        {summaryRows.map(({ key, text }, index) => <span key={key} className={"game-flow-folded-" + key}>
          {index > 0 && <span aria-hidden="true"> · </span>}
          <span className="game-flow-folded-value" data-tooltip={key === "models" ? text : undefined}>{text}</span>
        </span>)}
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
        {(configured || showReadOnlyParameters || !locked && onConfigure) && <section id={settingsId}
          className="game-flow-editable" role="region" aria-label={title + "运行参数"} hidden={!configured && !showReadOnlyParameters}>
          <h5 className="game-flow-editable-title">运行参数
            {configured && <span className="game-flow-tag">{active ? "运行中，不可改" : "可改"}</span>}
            {configured && saveConfiguration && <button type="button" disabled={locked || saveConfiguration.disabled}
              onClick={saveConfiguration.run}>{saveConfiguration.saving ? "保存中…" : "保存"}</button>}
          </h5>
          {configured && <fieldset className="game-flow-parameter-fields" disabled={locked}>
            <div className="game-flow-editable-fields">{configuration}</div>
          </fieldset>}
          {showReadOnlyParameters && <dl className="game-flow-parameter-list" aria-label="本次实际运行参数">
            {readOnlyParameters.map(({ label, value, scope }, index) =>
              <div key={scope + ":" + label + ":" + index}><dt title={label}>{label}</dt><dd>{value}</dd></div>)}
          </dl>}
        </section>}
        {cardStateLine && <div className="game-flow-state-line" role="status" data-active={active || undefined}>
          <span aria-hidden="true" /><span>{cardStateLine}</span>
        </div>}
      </div>
    </div>
  </article>;
}
