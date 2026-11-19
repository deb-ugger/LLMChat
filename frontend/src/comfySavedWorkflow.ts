export type ComfyRedrawParameters = { profile: "2511" | "turbo"; model: string; clip?: string | null; vae?: string | null; steps?: number | null };

type Slot = { name: string; link?: number | string | null; widget?: { name: string } };
type VisualNode = { id: number | string; type: string; mode?: number; inputs?: Slot[]; widgets_values?: unknown[] | Record<string, unknown> };
type Link = { id: number | string; origin_id: number | string; origin_slot: number } | [number, number, number, ...unknown[]];
type Graph = { nodes: VisualNode[]; links?: Link[]; inputs?: Slot[]; inputNode?: { id: number | string } };
type Definition = Graph & { id: string };
type VisualWorkflow = Graph & { definitions?: { subgraphs?: Definition[] } };
type Scope = Graph & { instance?: VisualNode };

function enabled(node: VisualNode) { return node.mode == null || node.mode === 0; }

function instanceValue(scope: Scope, slot: number): unknown {
  const port = scope.inputs?.[slot];
  const outer = port && scope.instance?.inputs?.find(input => input.name === port.name);
  if (!outer?.widget || outer.link != null) return undefined;
  const values = scope.instance?.widgets_values;
  if (!Array.isArray(values)) return values?.[outer.name];
  const widgets = scope.instance?.inputs?.filter(input => input.widget) ?? [];
  return widgets.length === values.length ? values[widgets.indexOf(outer)] : undefined;
}

function readInput(scope: Scope, node: VisualNode, name: string, depth = 0): unknown {
  if (depth >= 8 || !enabled(node)) return undefined;
  const input = node.inputs?.find(port => port.name === name);
  if (input?.link != null) {
    const link = scope.links?.find(link => (Array.isArray(link) ? link[0] : link.id) === input.link);
    if (!link) return undefined;
    const origin = Array.isArray(link) ? link[1] : link.origin_id;
    const slot = Array.isArray(link) ? link[2] : link.origin_slot;
    if (origin === scope.inputNode?.id) return instanceValue(scope, slot);
    if (slot !== 0) return undefined;
    const source = scope.nodes.find(node => node.id === origin);
    if (!source || !enabled(source)) return undefined;
    if (["PrimitiveInt", "PrimitiveFloat", "PrimitiveString", "PrimitiveBoolean"].includes(source.type)) {
      return readInput(scope, source, "value", depth + 1);
    }
    if (source.type === "ComfySwitchNode") {
      const selected = readInput(scope, source, "switch", depth + 1);
      if (typeof selected === "boolean") return readInput(scope, source, selected ? "on_true" : "on_false", depth + 1);
    }
    return undefined;
  }
  const values = node.widgets_values;
  if (!Array.isArray(values)) return values?.[name];
  if (name === "steps" && node.type === "KSampler") return values[typeof values[1] === "string" ? 2 : 1];
  if (name === "steps" && node.type === "KSamplerAdvanced") return values[typeof values[2] === "string" ? 3 : 2];
  return values[0];
}

function scopeParameters(scope: Scope): ComfyRedrawParameters | null {
  const nodes = scope.nodes.filter(enabled);
  const one = (types: string[], field: string) => {
    const matches = nodes.filter(node => types.includes(node.type));
    return matches.length === 1 ? readInput(scope, matches[0], field) : undefined;
  };
  const has = (type: string) => nodes.some(node => node.type === type);
  const profile = has("TextEncodeQwenImage21") ? "turbo" : has("TextEncodeQwenImageEditPlus") ? "2511" : null;
  if (!profile) return null;
  const model = one([profile === "turbo" ? "UNETLoader" : "UnetLoaderGGUF"], "unet_name");
  if (typeof model !== "string" || !(profile === "turbo" ? /turbo/i : /2511/).test(model)) return null;
  const clip = one(["CLIPLoader"], "clip_name");
  const vae = one(["VAELoader"], "vae_name");
  const steps = profile === "2511" ? one(["KSampler", "KSamplerAdvanced"], "steps") : undefined;
  return { profile, model, clip: typeof clip === "string" ? clip : undefined,
    vae: typeof vae === "string" ? vae : undefined,
    steps: typeof steps === "number" && Number.isInteger(steps) && steps >= 1 && steps <= 100 ? steps : undefined };
}

export function savedVisualRedrawParameters(value: unknown): ComfyRedrawParameters | null {
  const workflow = value as Partial<VisualWorkflow> | undefined;
  if (!Array.isArray(workflow?.nodes)) return null;
  const scopes: Scope[] = [workflow as VisualWorkflow];
  for (const node of workflow.nodes.filter(enabled)) {
    const definition = workflow.definitions?.subgraphs?.find(graph => graph.id === node.type);
    if (definition && Array.isArray(definition.nodes)) scopes.push({ ...definition, instance: node });
  }
  const recognized = scopes.map(scopeParameters).filter(row => row != null);
  return recognized.length === 1 ? recognized[0] : null;
}
