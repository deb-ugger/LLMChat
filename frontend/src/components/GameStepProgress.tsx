import type { ReactNode } from "react";

export const gameProgressLabels = {
  pending: "待开始", running: "正在处理", done: "已完成",
  stopped: "已中止", skipped: "已跳过", error: "失败",
};
export type GameProgressState = keyof typeof gameProgressLabels;

export function GameProgressBar({ label, value }: { label: string; value?: number }) {
  return <div className={`unity-progress-track${value === undefined ? " is-indeterminate" : ""}`}
    role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
    <div className="unity-progress-fill" style={value === undefined ? undefined : { width: `${value}%` }} />
  </div>;
}

export function GameStepProgress({ title, state, label, percent, elapsed, count, actions, children }: {
  title: string;
  state: GameProgressState;
  label?: string;
  percent?: number | null;
  elapsed?: string;
  count?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const value = state === "done" ? 100 : percent == null
    ? state === "running" ? undefined : 0
    : Math.min(100, Math.max(0, percent));
  return <div className={`unity-current-task game-step-progress is-${state}`}>
    <div className="unity-generation-status">
      <strong role="status">{title} · {label ?? gameProgressLabels[state]}</strong>
      {(elapsed || count) && <div className="game-step-progress-metrics">
        {elapsed && <span>用时 <b>{elapsed}</b></span>}
        {count && <span>{count}{value === undefined ? "" : ` · ${Math.round(value)}%`}</span>}
      </div>}
      {actions && <div className="unity-status-actions">{actions}</div>}
    </div>
    <GameProgressBar label={`${title}进度`} value={value} />
    {children && <div className="game-step-progress-details">{children}</div>}
  </div>;
}
