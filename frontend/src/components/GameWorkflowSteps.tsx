import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

export type GameWorkflowStep = { id: string; label: ReactNode; state: string; selected: boolean; running?: boolean; paused?: boolean; title?: string; onSelect: () => void };

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
  const trackRef = useRef<HTMLDivElement>(null);
  const [beamPosition, setBeamPosition] = useState<{ from: number; to: number } | null>(null);
  const selectedRunning = steps.findIndex(step => step.selected && step.running);
  const flowingStep = selectedRunning >= 0 ? selectedRunning : steps.findIndex(step => step.running);
  const flowTrackCount = steps.length - 1;
  const selectedStep = steps.findIndex(step => step.selected);
  const highlightedTrack = Math.min(Math.max(0, selectedStep), flowTrackCount - 1);
  // 连续光带：只从「第一处未完成」跑向「正在跑的那一步」，已完成段不再有光。
  const firstIncomplete = steps.findIndex(step => step.state !== "complete");
  const beamFrom = firstIncomplete >= 0 ? firstIncomplete : steps.length - 1;
  const beamTo = flowingStep;
  const beamActive = steps.length > 1 && beamTo >= beamFrom;
  const stepOrder = JSON.stringify(steps.map(step => step.id));

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!beamActive || !track) return;

    const measure = () => {
      const markers = track.querySelectorAll<HTMLElement>(".game-workflow-marker");
      const bounds = track.getBoundingClientRect();
      const position = (index: number) => {
        const marker = markers[index]?.getBoundingClientRect();
        if (!marker || marker.height <= 0 || bounds.height <= 0) return undefined;
        // The track and its markers scroll together, so their viewport offsets cancel out.
        const ratio = (marker.top + marker.height / 2 - bounds.top) / bounds.height;
        return ratio >= 0 && ratio <= 1 ? ratio : undefined;
      };
      const from = position(beamFrom);
      const to = position(beamTo);
      const next = from !== undefined && to !== undefined && from <= to ? { from, to } : null;
      setBeamPosition(current => current?.from === next?.from && current?.to === next?.to ? current : next);
    };

    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(track);
    track.querySelectorAll(".game-workflow-node, .unity-step-tab").forEach(node => observer?.observe(node));
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [beamActive, beamFrom, beamTo, stepOrder]);

  return <nav className="game-workflow-steps" role="tablist" aria-label="处理步骤" aria-orientation="vertical" onKeyDown={moveFocus}>
    <div className="game-workflow-track" role="presentation" ref={trackRef}>
      {beamActive && <span aria-hidden="true" className={beamFrom === beamTo ? "game-workflow-beam is-static" : "game-workflow-beam"} style={{
        "--beam-from": beamPosition?.from ?? (beamFrom + 0.5) / steps.length,
        "--beam-to": beamPosition?.to ?? (beamTo + 0.5) / steps.length,
        "--beam-span": Math.max(1, beamTo - beamFrom),
      } as CSSProperties} />}
      {steps.map((item, index) => {
        const next = steps[index + 1];
        const flow = flowingStep >= 0 && index >= flowingStep;
        const linked = item.selected || next?.selected;
        return <div className={`game-workflow-node ${item.state}`} key={item.id} role="presentation">
          <button id={idPrefix ? `${idPrefix}-${item.id}` : undefined} type="button" role="tab"
            tabIndex={item.selected ? 0 : -1} aria-selected={item.selected} aria-controls={panelId}
            aria-current={item.running ? "step" : undefined} data-tooltip={item.title} aria-label={item.title}
            className={`unity-step-tab${item.selected ? " is-selected" : ""}${item.running ? " is-active-task" : ""}${item.paused ? " is-paused-task" : ""}`}
            onClick={item.onSelect}>
            <span className="game-workflow-marker" aria-hidden="true" />
            <span className="game-workflow-label">{item.label}</span>
          </button>
          {next && <span aria-hidden="true"
            className={`game-workflow-connector${linked ? " is-linked" : ""}${flow ? " is-flowing" : ""}${index === highlightedTrack ? " is-flow-highlight" : ""}${item.state === "complete" && next.state === "complete" ? " is-done" : ""}${item.state === "complete" && next.state !== "complete" ? " is-handed-off" : ""}${item.running && next.running ? " is-parallel" : ""}`}
            style={{
              "--track-flow-order": index,
              "--track-flow-count": flowTrackCount,
              "--track-flow-to-tone": `var(--workflow-tone-${next.state}, var(--workflow-tone-pending))`,
            } as CSSProperties}>
            {item.running && next.running && <span className="game-workflow-bypass" aria-hidden="true" />}
            <span className="game-workflow-flow" aria-hidden="true" />
            <span className="game-workflow-glint" aria-hidden="true" />
          </span>}
        </div>;
      })}
    </div>
  </nav>;
}
