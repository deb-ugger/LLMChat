import type { BenchmarkConfig } from "../gameTextBenchmark";

export type BenchmarkRoundPlan = {
  configs: BenchmarkConfig[];
  roundConfigs?: Record<number, BenchmarkConfig[]>;
};

export function configsForRound(plan: BenchmarkRoundPlan, round: number) {
  return plan.roundConfigs?.[round] ?? plan.configs;
}

export function earlierRoundConfigs(plan: BenchmarkRoundPlan, round: number) {
  return round > 1 ? [plan.configs, ...Object.entries(plan.roundConfigs ?? {}).flatMap(
    ([number, configs]) => Number(number) < round ? [configs] : [])] : [];
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => [key, ordered(nested)]));
}

function signature(step: string, config: BenchmarkConfig, executionOnly = false) {
  const { label, mosaic, prompts, ...fields } = config;
  const normalized = {
    ...fields, label: executionOnly ? undefined : label, enabled: config.enabled !== false,
    prompts: Object.fromEntries(Object.entries(prompts ?? {}).filter(([scene, value]) => value && value !== "builtin:" + scene)),
    ...(mosaic && { mosaic: { ...mosaic, ...(step === "mosaicScreen" && {
      concurrency: mosaic.concurrency ?? 2, screenVisionModel: mosaic.screenVisionModel || undefined,
    }), ...(step === "mosaicRefine" && {
      refineModel: mosaic.refineModel || "qwen3.5:latest",
      refineGuardModel: mosaic.refineGuardModel || "qwen3-vl:8b-instruct",
      refineConcurrency: mosaic.refineConcurrency ?? 1,
    }) } }),
  };
  return JSON.stringify(ordered(normalized));
}

export function sameBenchmarkConfig(step: string, left: BenchmarkConfig, right: BenchmarkConfig) {
  return left === right || signature(step, left) === signature(step, right);
}

export function benchmarkRoundChanges(step: string, draft: readonly BenchmarkConfig[],
  saved: readonly BenchmarkConfig[], earlier: readonly BenchmarkConfig[][] = []) {
  const indexed = new Map(saved.map((config, index) => [config.id, { config, index }]));
  const prior = new Map<string, Set<string>>();
  for (const configs of earlier) for (const config of configs) {
    const versions = prior.get(config.id) ?? new Set<string>();
    versions.add(signature(step, config, true));
    prior.set(config.id, versions);
  }
  const draftIds = new Set(draft.map(config => config.id));
  const removed = saved.filter(config => !draftIds.has(config.id)).length;
  const changed = new Set<string>();
  const different = new Set<string>();
  const needsConfirmation = new Set<string>();
  draft.forEach((config, index) => {
    const baseline = indexed.get(config.id);
    if (!baseline || baseline.index !== index || !sameBenchmarkConfig(step, baseline.config, config)) changed.add(config.id);
    const versions = prior.get(config.id);
    if (!versions) return;
    const value = signature(step, config, true);
    if (versions.size === 1 && versions.has(value)) return;
    different.add(config.id);
    if (!baseline || signature(step, baseline.config, true) !== value) needsConfirmation.add(config.id);
  });
  return { dirty: changed.size > 0 || removed > 0, changed, different, needsConfirmation, removed };
}
