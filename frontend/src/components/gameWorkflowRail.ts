export type RailStep = {
  id: string;
  state: string;
  selected?: boolean;
  running?: boolean;
  disconnected?: boolean;
};

type RailEdge = { from: string; to: string };

export type RailView = {
  nodes: { id: string; className: string }[];
  connectors: { index: number; className: string }[];
  beam: { from: number; to: number; active: boolean; isStatic: boolean };
  lanes: { index: number; count: number }[];
};

export function deriveRailView(
  steps: readonly RailStep[],
  edges?: readonly RailEdge[],
  enabled?: readonly string[],
  skipped?: readonly string[],
  flowingStep?: number,
): RailView {
  const graphMode = edges !== undefined;
  const enabledIds = new Set(enabled ?? steps.map(step => step.id));
  const skippedIds = new Set(skipped);
  const isSkipped = (step: RailStep) => step.state === "skipped" || skippedIds.has(step.id);
  const isEnabled = (step: RailStep) => enabledIds.has(step.id) && !isSkipped(step);
  const order = new Map(steps.map((step, index) => [step.id, index]));
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  const crossings = Array<number>(Math.max(0, steps.length - 1)).fill(0);

  // The canvas supplies effective edges with skipped intermediates already contracted.
  for (const { from, to } of edges ?? []) {
    const a = order.get(from), b = order.get(to);
    if (a === undefined || b === undefined || a === b || !isEnabled(steps[a]) || !isEnabled(steps[b])) continue;
    const targets = outgoing.get(from) ?? new Set<string>();
    if (targets.has(to)) continue;
    const sources = incoming.get(to) ?? new Set<string>();
    targets.add(to);
    sources.add(from);
    outgoing.set(from, targets);
    incoming.set(to, sources);
    for (let index = Math.min(a, b); index < Math.max(a, b); ++index) crossings[index]++;
  }

  const isUnlinked = (step: RailStep) => isEnabled(step) && step.disconnected;
  const isFanOut = (id: string) => (outgoing.get(id)?.size ?? 0) >= 2;
  const isFanIn = (id: string) => (incoming.get(id)?.size ?? 0) >= 2;
  const selectedRunning = steps.findIndex(step => isEnabled(step) && step.selected && step.running);
  const firstRunning = steps.findIndex(step => isEnabled(step) && step.running);
  const running = flowingStep !== undefined && steps[flowingStep] && isEnabled(steps[flowingStep])
    ? flowingStep : selectedRunning >= 0 ? selectedRunning : firstRunning;
  const selected = steps.findIndex(step => step.selected);
  const highlightedTrack = Math.min(Math.max(0, selected), steps.length - 2);
  const enabledSteps = steps.flatMap((step, index) => isEnabled(step) ? [index] : []);
  const unfinished = enabledSteps.filter(index => steps[index].state !== "complete");
  const lastEnabled = enabledSteps.at(-1) ?? -1;
  const from = unfinished[0] ?? lastEnabled;
  const limit = graphMode || running < 0 ? lastEnabled : Math.max(from, running);
  const errorStep = unfinished.find(index => steps[index].state === "error");
  const to = unfinished.length <= 1 ? from : Math.min(limit, errorStep ?? limit);

  const nodes = steps.map(step => ({
    id: step.id,
    className: [
      "game-workflow-node", isSkipped(step) ? "skipped" : step.state, isSkipped(step) && "is-skipped",
      isUnlinked(step) && "is-unlinked", isFanOut(step.id) && "is-fan-out", isFanIn(step.id) && "is-fan-in",
    ].filter(Boolean).join(" "),
  }));
  const lanes: RailView["lanes"] = [];
  const connectors = steps.slice(0, -1).map((step, index) => {
    const next = steps[index + 1];
    const skippedConnector = isSkipped(step) || isSkipped(next);
    const parallel = !graphMode && !skippedConnector && step.running && next.running;
    lanes.push({ index, count: graphMode ? crossings[index] : parallel ? 2 : 1 });
    return { index, className: [
      "game-workflow-connector", (step.selected || next.selected) && "is-linked",
      !isSkipped(step) && running >= 0 && index >= running && "is-flowing",
      index === highlightedTrack && "is-flow-highlight",
      !skippedConnector && step.state === "complete" && (next.state === "complete" ? "is-done" : "is-handed-off"),
      parallel && "is-parallel", isFanOut(step.id) && "is-fan-out", isFanIn(next.id) && "is-fan-in",
      graphMode && crossings[index] === 0 && "is-gap", isUnlinked(next) && "is-unlinked", skippedConnector && "is-skipped",
    ].filter(Boolean).join(" ") };
  });
  const hasSkipped = enabledSteps.length !== steps.length;
  const hasProcessing = enabledSteps.some(index => index > 0 && index < steps.length - 1);
  const active = enabledSteps.length > 1 && (!hasSkipped || unfinished.length > 0 && (!graphMode || hasProcessing));
  return {
    nodes, connectors, lanes,
    beam: { from, to, active, isStatic: from === to },
  };
}
