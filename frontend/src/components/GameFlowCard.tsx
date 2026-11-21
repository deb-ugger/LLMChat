import type { ReactNode, Ref } from "react";
import type { BenchmarkState } from "../benchmark/benchmarkRunner";
import { gameDuration } from "../gameModelPerformance";
import { GameProgressBar } from "./GameStepProgress";

export function GameFlowCard({ title, state, current, benchmark, status, summary, actions, expanded, onToggle,
  toggleTooltip, configuration, configurationRef }: {
  title: string;
  state: string;
  current?: boolean;
  benchmark?: BenchmarkState;
  status: ReactNode;
  summary: ReactNode;
  actions: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  toggleTooltip?: string;
  configuration?: ReactNode;
  configurationRef?: Ref<HTMLDivElement>;
}) {
  return <li className={`game-flow-item is-${state}${benchmark ? " is-benchmark is-benchmark-running" : ""}${current ? " is-current-step" : ""}${configuration ? " is-configured" : ""}${expanded ? " is-expanded" : ""}`} data-benchmark={benchmark?.state}>
    <div className="game-flow-step">
      <div className="game-flow-row">
        <button type="button" className="game-flow-step-toggle" aria-label={`${expanded ? "收起" : "展开"}${title}设置`}
          aria-expanded={expanded} data-tooltip={toggleTooltip} onClick={onToggle} />
        <div className="game-flow-step-main"><strong>{title}</strong><small>
          {benchmark && state !== "running" ? <>性能测试中 · <span className="game-flow-metric">{gameDuration(benchmark.elapsedMs)}</span></> : status}
        </small></div>
        <div className="game-flow-summary">
          {benchmark && <div className="game-benchmark-live" role="status">
            <span>{benchmark.label}</span>
            {benchmark.sample && <> · <span className="game-benchmark-sample" data-tooltip={benchmark.sample}>当前样本：{benchmark.sample}</span></>}
            <small className="game-flow-model-rates">
              <span>{benchmark.current} / {benchmark.total}</span>
              {benchmark.failed > 0 && <span>失败 {benchmark.failed}</span>}
              {state === "running" && <span>测试用时 {gameDuration(benchmark.elapsedMs)}</span>}
            </small>
            <GameProgressBar label={title + "测试进度"} value={benchmark.percent ?? undefined} />
          </div>}
          {summary}
        </div>
        <div className="game-flow-actions">{actions}</div>
      </div>
    </div>
    {configuration && <div ref={configurationRef} className="game-flow-config" role="region" aria-label={`${title}设置`}>
      {configuration}
    </div>}
  </li>;
}
