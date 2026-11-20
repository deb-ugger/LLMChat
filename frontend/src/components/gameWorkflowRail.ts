export type RailStep = {
  id: string;
  state: string;
  selected?: boolean;
  running?: boolean;
  disconnected?: boolean;
};

type RailEdge = { from: string; to: string };

export function railOrder(
  steps: readonly RailStep[],
  edges?: readonly RailEdge[],
  enabled?: readonly string[],
  skipped?: readonly string[],
): number[] {
  const indices = steps.map((_, index) => index);
  if (!edges?.length || indices.length < 2) return indices;

  const enabledIds = new Set(enabled ?? steps.map(step => step.id));
  const skippedIds = new Set(skipped);
  const active = steps.map(step => enabledIds.has(step.id) && !skippedIds.has(step.id) && step.state !== "skipped");
  const indexOf = new Map(steps.map(({ id }, index) => [id, index]));
  const outgoing = indices.map(() => new Set<number>());
  const indegree = indices.map(() => 0);
  for (const { from, to } of edges) {
    const source = indexOf.get(from), target = indexOf.get(to);
    if (source === undefined || target === undefined || source === target || outgoing[source].has(target)) continue;
    outgoing[source].add(target);
    indegree[target]++;
  }

  const layers = indices.map(() => 0);
  const reachable = indices.map(() => false);
  const queue = indices.filter(index => indegree[index] === 0);
  if (queue.length === 0) {
    indegree[0] = 0;
    queue.push(0);
  }
  for (const source of queue) {
    for (const target of outgoing[source]) {
      if (indegree[target] === 0) continue;
      // A skipped intermediary passes the dependency on without adding a layer.
      layers[target] = Math.max(layers[target], layers[source] + Number(active[source]));
      reachable[target] ||= active[source] || reachable[source];
      if (--indegree[target] === 0) queue.push(target);
    }
  }

  const rank = new Map(queue.map((index, position) => [index, position]));
  const ordered = queue.filter(index => active[index] || reachable[index])
    .sort((a, b) => layers[a] - layers[b] || Number(active[a]) - Number(active[b])
      || (active[a] ? a - b : rank.get(a)! - rank.get(b)!));
  const placed = new Set(ordered);
  // Keep unanchored skipped steps and any unorderable steps in their original slots.
  for (const index of indices) if (!placed.has(index)) ordered.splice(index, 0, index);
  return ordered;
}

export type RailView = {
  nodes: { id: string; className: string }[];
  connectors: { index: number; className: string; parallelLane: boolean }[];
  parallelRegions: { start: number; end: number; lanes: number }[];
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
  const lastEnabled = enabledSteps.at(-1) ?? -1;
  const parallelLanes = crossings.map(() => false);
  for (const [source, targets] of outgoing) {
    if (targets.size < 2) continue;
    const start = order.get(source)!;
    const visited = new Set([source, ...targets]);
    let frontier = [...targets];
    let end = lastEnabled;
    // Each frontier is one more edge from the fork. Resolve ties by rail order.
    while (frontier.length) {
      const joins = frontier.filter(id => isFanIn(id) && order.get(id)! > start);
      if (joins.length) {
        end = Math.min(...joins.map(id => order.get(id)!));
        break;
      }
      const next: string[] = [];
      for (const id of frontier) {
        for (const target of outgoing.get(id) ?? []) {
          if (visited.has(target)) continue;
          visited.add(target);
          next.push(target);
        }
      }
      frontier = next;
    }
    for (let index = start; index < end; index++) {
      if (isEnabled(steps[index]) && isEnabled(steps[index + 1])) parallelLanes[index] = true;
    }
  }
  const parallelRegions: RailView["parallelRegions"] = [];
  parallelLanes.forEach((parallel, index) => {
    if (!parallel) return;
    const last = parallelRegions.at(-1);
    if (last?.end === index) last.end++;
    else parallelRegions.push({ start: index, end: index + 1, lanes: 2 });
  });

  const unfinished = enabledSteps.filter(index => steps[index].state !== "complete");
  const from = unfinished[0] ?? lastEnabled;
  const limit = graphMode || running < 0 ? lastEnabled : Math.max(from, running);
  const errorStep = unfinished.find(index => steps[index].state === "error");
  let to = unfinished.length <= 1 ? from : Math.min(limit, errorStep ?? limit);
  if (graphMode && to > from) {
    // Animate only through the contiguous dependency interval reachable from the first unfinished step.
    const reached = new Set([from]);
    const pending = isUnlinked(steps[from]) ? [] : [from];
    const segments = new Set<number>();
    for (const index of pending) {
      for (const id of outgoing.get(steps[index].id) ?? []) {
        const target = order.get(id)!;
        if (isUnlinked(steps[target])) continue;
        for (let lane = Math.min(index, target); lane < Math.max(index, target); lane++) segments.add(lane);
        if (!reached.has(target)) {
          reached.add(target);
          pending.push(target);
        }
      }
    }
    let end = from;
    while (end < to && segments.has(end)) end++;
    to = end;
  }

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
    return { index, parallelLane: parallelLanes[index], className: [
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
    nodes, connectors, lanes, parallelRegions,
    beam: { from, to, active, isStatic: from === to },
  };
}
