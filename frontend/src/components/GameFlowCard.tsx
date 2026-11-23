import { useEffect, useId, useState, type ReactNode } from "react";
import type { BenchmarkState } from "../benchmark/benchmarkRunner";
import { gameDuration } from "../gameModelPerformance";
import { GameProgressBar } from "./GameStepProgress";

export type GameFlowProgress = {
  sample?: string;
  current?: number;
  total?: number;
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
  saveConfiguration?: { run: () => void; disabled: boolean; saving?: boolean };
  disclosure?: { expanded: boolean; toggle: () => void };
};

export function StandaloneGameFlowCard({ stepId, ...props }: Omit<CardProps, "disclosure"> & { stepId: string }) {
  const expansion = useGameFlowExpansion();
  const expanded = expansion.isExpanded(stepId, true);
  return <GameFlowCard {...props} disclosure={{ expanded, toggle: () => expansion.setExpanded(stepId, !expanded) }} />;
}

export function GameFlowCard({ title, state, current, benchmark, label, elapsed, progress, details, performance,
  actions, onConfigure, body, configuration, saveConfiguration, disclosure }: CardProps) {
  const detailsId = useId();
  const settingsId = useId();
  const statusId = useId();
  const expanded = disclosure?.expanded ?? true;
  const configured = expanded && !!configuration;
  const position = benchmark && benchmark.round != null && benchmark.rounds != null &&
    benchmark.configIndex != null && benchmark.configCount != null
    ? `第 ${benchmark.round}/${benchmark.rounds} 轮 · 配置 ${benchmark.configIndex}/${benchmark.configCount}` : undefined;
  const activeProgress: GameFlowProgress | undefined = benchmark ? {
    sample: benchmark.sample,
    current: benchmark.current,
    total: benchmark.total,
    percent: benchmark.percent,
    remainingMs: benchmark.current > 0 && benchmark.elapsedMs > 0
      ? benchmark.elapsedMs / benchmark.current * Math.max(0, benchmark.total - benchmark.current) : undefined,
    details: progress?.details,
  } : state === "running" ? progress ?? {} : undefined;
  const percent = activeProgress?.percent == null ? undefined : Math.min(100, Math.max(0, activeProgress.percent));
  const summaryProgress = activeProgress ?? progress;
  const summaryValue = summaryProgress?.percent ?? (summaryProgress?.current != null &&
    summaryProgress.total != null && summaryProgress.total > 0 ? 100 * summaryProgress.current / summaryProgress.total : undefined);
  const summaryPercent = !benchmark && state === "done" ? 100 : summaryValue != null && Number.isFinite(summaryValue)
    ? Math.round(Math.min(100, Math.max(0, summaryValue))) : state === "pending" || state === "waiting" ? 0 : undefined;
  const sample = summaryProgress?.sample;
  const elapsedLabel = benchmark ? gameDuration(benchmark.elapsedMs) : elapsed;
  const status = benchmark ? benchmark.state === "paused" ? "测试已暂停" : "测试中" : label;
  return <article className={`game-flow-item is-${state}${benchmark ? " is-benchmark" : ""}${benchmark?.state === "running" ? " is-benchmark-running" : ""}${current ? " is-current-step" : ""}${configured ? " is-configured" : ""}`} data-benchmark={benchmark?.state}>
    <div className="game-flow-step">
      <header className="game-flow-head">
        <span className="game-flow-dot" aria-hidden="true" />
        {onConfigure ? <button type="button" className="game-flow-title" aria-expanded={configured}
          aria-controls={settingsId} aria-describedby={statusId}
          style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer" }}
          onClick={onConfigure}>{title}</button> : <strong className="game-flow-title">{title}</strong>}
        {position && <span className="game-flow-position">{position}</span>}
        <span id={statusId} className="game-flow-state" role="status">{status}</span>
        {elapsedLabel != null && <span className="game-flow-elapsed">已用 {elapsedLabel}</span>}
        {(actions || disclosure) && <div className="game-flow-actions">
          {actions}
          {disclosure && <button type="button" className="unity-btn" onClick={disclosure.toggle}
            aria-label={`${expanded ? "收起" : "展开"}${title}`} aria-expanded={expanded} aria-controls={detailsId}
            style={{ inlineSize: 24, blockSize: 24, minInlineSize: 24, minBlockSize: 24, padding: 0,
              flex: "none", display: "grid", placeItems: "center", boxSizing: "border-box" }}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d={expanded ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4"} stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>}
        </div>}
      </header>
      {!expanded && <div className="game-flow-progress-main"
        style={{ fontSize: "var(--fs-caption)", color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden" }}>
        <span>{summaryPercent === undefined ? "进度 —" : `${summaryPercent}%`}</span>
        {sample && <span className="game-flow-sample" title={sample}>{sample}</span>}
      </div>}
      <div id={detailsId} hidden={!expanded}>
        {activeProgress && <div className="game-flow-progress">
          <div className="game-flow-progress-main">
            {activeProgress.sample && <span className="game-flow-sample" data-tooltip={activeProgress.sample}>{activeProgress.sample}</span>}
            {activeProgress.current != null && activeProgress.total != null
              ? <span className="game-flow-progress-count">{activeProgress.current.toLocaleString()} <small>/ {activeProgress.total.toLocaleString()}</small></span>
              : activeProgress.count && <span className="game-flow-progress-count">{activeProgress.count}</span>}
          </div>
          {percent === undefined ? <GameProgressBar label={title + "进度"} /> :
            <div className="game-flow-progress-bar" role="progressbar" aria-label={title + "进度"}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ inlineSize: percent + "%" }} /></div>}
          {(benchmark?.sampleCurrent != null && benchmark.sampleTotal != null || activeProgress.remainingMs !== undefined) &&
            <div className="game-flow-progress-meta">
              {benchmark?.sampleCurrent != null && benchmark.sampleTotal != null &&
                <span>本配置 <b>{benchmark.sampleCurrent}/{benchmark.sampleTotal}</b></span>}
              {activeProgress.remainingMs !== undefined && <span className="game-flow-eta">预计剩余 <b>{gameDuration(activeProgress.remainingMs)}</b></span>}
            </div>}
          {activeProgress.details}
        </div>}
        {details}
        {performance}
        {body}
        {(onConfigure || configuration) && <section id={settingsId} className="game-flow-editable" role="region"
          aria-label={`${title}运行参数`} hidden={!configured}>
          <h5 className="game-flow-editable-title">运行参数<span className="game-flow-tag">可改</span>
            {saveConfiguration && <button type="button" disabled={saveConfiguration.disabled}
              onClick={saveConfiguration.run}>{saveConfiguration.saving ? "保存中…" : "保存"}</button>}
          </h5>
          <div className="game-flow-editable-fields">{configuration}</div>
        </section>}
      </div>
    </div>
  </article>;
}
