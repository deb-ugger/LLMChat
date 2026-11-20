import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { deriveRailView } from "./gameWorkflowRail";

export type GameWorkflowStep = { id: string; label: ReactNode; state: string; selected: boolean; running?: boolean; paused?: boolean; title?: string; onSelect: () => void };

type Props = {
  steps: GameWorkflowStep[];
  idPrefix?: string;
  panelId?: string;
  edges?: { from: string; to: string }[];
  enabled?: string[];
  skipped?: string[];
  disconnected?: string[];
};

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

export function GameWorkflowSteps({ steps, idPrefix, panelId, edges, enabled, skipped, disconnected }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [beamPosition, setBeamPosition] = useState<{ from: number; to: number } | null>(null);
  const disconnectedIds = new Set(disconnected);
  const railSteps = steps.map(step => ({ ...step, disconnected: disconnectedIds.has(step.id) }));
  const { nodes, connectors, lanes, beam } = deriveRailView(railSteps, edges, enabled, skipped);
  const { from: beamFrom, to: beamTo, active: beamActive, isStatic: beamStatic } = beam;
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
      {beamActive && <span aria-hidden="true" className={beamStatic ? "game-workflow-beam is-static" : "game-workflow-beam"} style={{
        "--beam-from": beamPosition?.from ?? (beamFrom + 0.5) / steps.length,
        "--beam-to": beamPosition?.to ?? (beamTo + 0.5) / steps.length,
        "--beam-anchor-tone": `var(--workflow-tone-${steps[beamFrom].state}, var(--workflow-tone-current))`,
        "--beam-span": Math.max(1, beamTo - beamFrom),
      } as CSSProperties} />}
      {steps.map((item, index) => {
        const node = nodes[index], connector = connectors[index], next = steps[index + 1];
        const skippedStep = node.className.includes(" is-skipped");
        const skippedNext = nodes[index + 1]?.className.includes(" is-skipped");
        const missingInput = node.className.includes(" is-unlinked");
        const notice = skippedStep ? "已跳过" : missingInput ? "依赖路径不完整" : undefined;
        const title = notice ? `${item.title ?? (typeof item.label === "string" ? item.label : item.id)}（${notice}）` : item.title;
        return <div className={node.className} key={item.id} role="presentation">
          <button id={idPrefix ? `${idPrefix}-${item.id}` : undefined} type="button" role="tab"
            tabIndex={item.selected ? 0 : -1} aria-selected={item.selected} aria-controls={panelId}
            aria-current={!skippedStep && item.running ? "step" : undefined} data-tooltip={title} aria-label={title} title={notice ? title : undefined}
            className={`unity-step-tab${item.selected ? " is-selected" : ""}${!skippedStep && item.running ? " is-active-task" : ""}${!skippedStep && item.paused ? " is-paused-task" : ""}`}
            onClick={item.onSelect}>
            <span className="game-workflow-marker" aria-hidden="true" />
            {missingInput && <span className="game-workflow-alert" aria-hidden="true" />}
            <span className="game-workflow-label">{item.label}</span>
          </button>
          {next && connector && <span aria-hidden="true"
            className={connector.parallelLane ? `${connector.className} is-parallel-lane` : connector.className} data-lanes={lanes[index].count}
            style={{
              "--track-flow-order": index,
              "--track-flow-count": connectors.length,
              "--track-flow-to-tone": `var(--workflow-tone-${skippedNext ? "skipped" : next.state}, var(--workflow-tone-pending))`,
            } as CSSProperties}>
            {connector.className.includes(" is-parallel") && <span className="game-workflow-bypass" aria-hidden="true" />}
            <span className="game-workflow-flow" aria-hidden="true" />
            <span className="game-workflow-glint" aria-hidden="true" />
          </span>}
        </div>;
      })}
    </div>
  </nav>;
}
