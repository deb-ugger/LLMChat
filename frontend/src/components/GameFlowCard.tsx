import type { ReactNode, Ref } from "react";

export function GameFlowCard({ title, state, current, benchmark, status, summary, actions, expanded, onToggle,
  toggleTooltip, configuration, configurationRef }: {
  title: string;
  state: string;
  current?: boolean;
  benchmark?: boolean;
  status: ReactNode;
  summary: ReactNode;
  actions: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  toggleTooltip?: string;
  configuration?: ReactNode;
  configurationRef?: Ref<HTMLDivElement>;
}) {
  return <li className={`game-flow-item is-${state}${benchmark ? " is-benchmark" : ""}${current ? " is-current-step" : ""}${configuration ? " is-configured" : ""}`}>
    <div className="game-flow-step">
      <div className="game-flow-row">
        <button type="button" className="game-flow-step-toggle" aria-label={`${expanded ? "收起" : "展开"}${title}设置`}
          aria-expanded={expanded} data-tooltip={toggleTooltip} onClick={onToggle} />
        <div className="game-flow-step-main"><strong>{title}</strong><small>{status}</small></div>
        <div className="game-flow-summary" style={{ display: "block", overflow: "visible", WebkitLineClamp: "unset" }}>{summary}</div>
        <div className="game-flow-actions">{actions}</div>
      </div>
    </div>
    {configuration && <div ref={configurationRef} className="game-flow-config" role="region" aria-label={`${title}设置`}>
      {configuration}
    </div>}
  </li>;
}
