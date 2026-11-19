import type { KeyboardEvent, ReactNode } from "react";

export type GameWorkflowStep = { id: string; number: string; label: ReactNode; state: string; selected: boolean; running?: boolean; paused?: boolean; title?: string; onSelect: () => void };

function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const current = tabs.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
    (current + (event.key === "ArrowDown" ? 1 : tabs.length - 1)) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
}

export function GameWorkflowSteps({ steps, idPrefix, panelId }: { steps: GameWorkflowStep[]; idPrefix?: string; panelId?: string }) {
  return <nav className="game-workflow-steps" role="tablist" aria-label="处理步骤" aria-orientation="vertical" onKeyDown={moveFocus}>
    {steps.map(item => <div className={`game-workflow-node ${item.state}`} key={item.id} role="presentation">
      <button id={idPrefix ? `${idPrefix}-${item.id}` : undefined} type="button" role="tab"
        tabIndex={item.selected ? 0 : -1} aria-selected={item.selected} aria-controls={panelId}
        aria-current={item.running ? "step" : undefined} data-tooltip={item.title} aria-label={item.title}
        className={`unity-step-tab${item.selected ? " is-selected" : item.running ? " is-active-task" : ""}${item.paused ? " is-paused-task" : ""}`}
        onClick={item.onSelect}>
        <span className="unity-step-number" aria-hidden="true">{item.number}</span>
        <span className="game-workflow-label">{item.label}</span>
      </button>
    </div>)}
  </nav>;
}
