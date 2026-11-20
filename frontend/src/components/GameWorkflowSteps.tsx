import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

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
  const graphMode = edges !== undefined;
  const enabledIds = new Set(enabled ?? steps.map(step => step.id));
  const skippedIds = new Set(skipped);
  const isEnabled = (step: GameWorkflowStep) => enabledIds.has(step.id) && !skippedIds.has(step.id);
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const { from, to } of edges ?? []) {
    const targets = outgoing.get(from) ?? new Set<string>();
    const sources = incoming.get(to) ?? new Set<string>();
    targets.add(to);
    sources.add(from);
    outgoing.set(from, targets);
    incoming.set(to, sources);
  }
  const disconnectedIds = new Set(disconnected);
  const unlinked = (index: number) => isEnabled(steps[index]) && disconnectedIds.has(steps[index].id);
  const order = new Map(steps.map((step, index) => [step.id, index]));
  // A vertical rail segment represents every dependency that crosses that boundary.
  const crossings = (edges ?? []).flatMap(({ from, to }) => {
    const a = order.get(from), b = order.get(to);
    return a === undefined || b === undefined ? [] : [{ first: Math.min(a, b), last: Math.max(a, b) }];
  });
  const selectedRunning = steps.findIndex(step => isEnabled(step) && step.selected && step.running);
  const flowingStep = selectedRunning >= 0 ? selectedRunning : steps.findIndex(step => isEnabled(step) && step.running);
  const flowTrackCount = steps.length - 1;
  const selectedStep = steps.findIndex(step => step.selected);
  const highlightedTrack = Math.min(Math.max(0, selectedStep), flowTrackCount - 1);
  const enabledSteps = steps.flatMap((step, index) => isEnabled(step) ? [index] : []);
  const unfinished = enabledSteps.filter(index => steps[index].state !== "complete");
  const lastEnabled = enabledSteps.at(-1) ?? -1;
  const beamFrom = unfinished[0] ?? lastEnabled;
  const limit = graphMode || flowingStep < 0 ? lastEnabled : Math.max(beamFrom, flowingStep);
  const errorStep = unfinished.find(index => steps[index].state === "error");
  const beamTo = unfinished.length <= 1 ? beamFrom : Math.min(limit, errorStep ?? limit);
  const beamStatic = beamFrom === beamTo;
  const beamActive = enabledSteps.length > 1 && (unfinished.length > 0 || enabledSteps.length === steps.length);
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
        const next = steps[index + 1];
        const skippedStep = skippedIds.has(item.id);
        const skippedNext = next && skippedIds.has(next.id);
        const state = skippedStep ? "skipped" : item.state;
        const flow = !skippedStep && flowingStep >= 0 && index >= flowingStep;
        const linked = item.selected || next?.selected;
        const missingInput = unlinked(index);
        const gap = graphMode && next && !crossings.some(({ first, last }) => first <= index && index < last);
        const fanOut = (outgoing.get(item.id)?.size ?? 0) >= 2;
        const fanIn = next && (incoming.get(next.id)?.size ?? 0) >= 2;
        const parallel = !graphMode && !skippedStep && !skippedNext && item.running && next?.running;
        const notice = skippedStep ? "已跳过" : missingInput ? "依赖路径不完整" : undefined;
        const title = notice ? `${item.title ?? (typeof item.label === "string" ? item.label : item.id)}（${notice}）` : item.title;
        return <div className={`game-workflow-node ${state}${missingInput ? " is-unlinked" : ""}`} key={item.id} role="presentation">
          <button id={idPrefix ? `${idPrefix}-${item.id}` : undefined} type="button" role="tab"
            tabIndex={item.selected ? 0 : -1} aria-selected={item.selected} aria-controls={panelId}
            aria-current={!skippedStep && item.running ? "step" : undefined} data-tooltip={title} aria-label={title} title={notice ? title : undefined}
            className={`unity-step-tab${item.selected ? " is-selected" : ""}${!skippedStep && item.running ? " is-active-task" : ""}${!skippedStep && item.paused ? " is-paused-task" : ""}`}
            onClick={item.onSelect}>
            <span className="game-workflow-marker" aria-hidden="true" />
            {missingInput && <span className="game-workflow-alert" aria-hidden="true" />}
            <span className="game-workflow-label">{item.label}</span>
          </button>
          {next && <span aria-hidden="true"
            className={[
              "game-workflow-connector", linked && "is-linked", flow && "is-flowing",
              index === highlightedTrack && "is-flow-highlight",
              state === "complete" && !skippedNext && (next.state === "complete" ? "is-done" : "is-handed-off"),
              parallel && "is-parallel", fanOut && "is-fan-out", fanIn && "is-fan-in",
              gap && "is-gap", unlinked(index + 1) && "is-unlinked",
            ].filter(Boolean).join(" ")}
            style={{
              "--track-flow-order": index,
              "--track-flow-count": flowTrackCount,
              "--track-flow-to-tone": `var(--workflow-tone-${skippedNext ? "skipped" : next.state}, var(--workflow-tone-pending))`,
            } as CSSProperties}>
            {parallel && <span className="game-workflow-bypass" aria-hidden="true" />}
            <span className="game-workflow-flow" aria-hidden="true" />
            <span className="game-workflow-glint" aria-hidden="true" />
          </span>}
        </div>;
      })}
    </div>
  </nav>;
}
