export type WorkflowControlKind = "image" | "prompt" | "fast" | "steps" | "strength" | "output";
export type WorkflowControl = {
  kind: WorkflowControlKind;
  label: string;
  pointer: string;
  value: string | number | boolean;
  namedPointer?: string;
  condition?: { pointer: string; initial: boolean; value: boolean };
};
type Row = Record<string, unknown>;

const labels: Record<WorkflowControlKind, string> = {
  image: "输入图片", prompt: "重绘说明", fast: "速度优先",
  steps: "采样步数", strength: "改动幅度", output: "输出文件名",
};
const order: WorkflowControlKind[] = ["image", "prompt", "fast", "steps", "strength", "output"];

function row(value: unknown): Row | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
}
function entries(value: unknown): Row[] {
  return Array.isArray(value) ? value.flatMap(item => { const result = row(item); return result ? [result] : []; }) : [];
}
function segment(value: string) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
function enabled(node: Row) {
  return node.mode == null || node.mode === 0;
}

type Found = WorkflowControl & { explicitPrompt?: boolean; sampler?: string };
const samplerTypes = ["KSampler", "KSamplerAdvanced", "BasicScheduler"];

function field(type: string, nodeTitle: string, name: string, pointer: string, value: unknown, role?: "positive" | "negative"): Found | undefined {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const title = [nodeTitle, key].join(" ");
  let kind: WorkflowControlKind;
  let explicitPrompt = false;
  if (type === "LoadImage" && key === "image" && typeof value === "string") kind = "image";
  else if (key === "filename_prefix" && type === "SaveImage" && typeof value === "string") kind = "output";
  else if (["enable_turbo_mode", "turbo", "fast_mode"].includes(key) && typeof value === "boolean") kind = "fast";
  else if (samplerTypes.includes(type) && key === "steps" && typeof value === "number") kind = "steps";
  else if (["KSampler", "BasicScheduler"].includes(type) && key === "denoise" && typeof value === "number") kind = "strength";
  else if (typeof value === "string" && role !== "negative" && !/negative|负面|反向/i.test(title) &&
      (key === "positive_prompt" || key === "prompt" || key === "text" && type.startsWith("CLIPTextEncode"))) {
    kind = "prompt";
    explicitPrompt = role === "positive" || key === "positive_prompt" || /positive|正向|重绘说明/i.test(title);
  } else return undefined;
  const label = kind === "image" && /reference|参考/i.test(nodeTitle) ? "参考图" : labels[kind];
  return { kind, label, pointer, value: value as string | number | boolean, explicitPrompt };
}

const namesByType: Record<string, string[]> = {
  LoadImage: ["image", "upload"],
  SaveImage: ["filename_prefix"],
  CLIPTextEncode: ["text"],
  TextEncodeQwenImageEditPlus: ["prompt"],
  TextEncodeQwenImageEdit: ["prompt"],
  TextEncodeQwenImage21: ["prompt", "negative_prompt"],
  BasicScheduler: ["scheduler", "steps", "denoise"],
  PrimitiveInt: ["value"],
  PrimitiveBoolean: ["value"],
  ComfySwitchNode: ["switch"],
};

type VisualScope = { graph: Row; nodes: unknown[]; prefix: string; parent?: { scope: VisualScope; index: number } };

function visualWidgets(node: Row, path: string) {
  const ports = entries(node.inputs);
  const widgets = ports.filter(port => row(port.widget));
  const values = node.widgets_values;
  const named = row(node.widgets_values_named);
  const stored = (key: string, name: string, value: unknown, port?: Row, namedOnly = false) => {
    const widget = String(row(port?.widget)?.name || port?.name || name);
    const namedPointer = `${path}/widgets_values_named/${segment(widget)}`;
    return { name: String(port?.label || port?.name || name), widget, value, port,
      pointer: `${path}/${namedOnly ? "widgets_values_named" : "widgets_values"}/${segment(key)}`,
      namedPointer: !namedOnly && named && Object.hasOwn(named, widget) ? namedPointer : undefined };
  };
  if (!Array.isArray(values)) {
    const positional = row(values);
    return Object.entries(positional || named || {}).map(([key, value]) => stored(key, key, value,
      ports.find(port => port.name === key || port.label === key || row(port.widget)?.name === key), !positional));
  }
  let names = namesByType[String(node.type)] || [];
  if (node.type === "KSampler") {
    names = ["seed", ...(typeof values[1] === "string" ? ["seed_mode"] : []), "steps", "cfg", "sampler_name", "scheduler", "denoise"];
  } else if (node.type === "KSamplerAdvanced") {
    names = ["add_noise", "seed", ...(typeof values[2] === "string" ? ["seed_mode"] : []), "steps"];
  }
  return values.map((value, position) => stored(String(position), names[position] || "", value,
    widgets.length === values.length ? widgets[position] :
      ports.find(port => port.name === names[position] || row(port.widget)?.name === names[position])));
}

function visualSource(scope: VisualScope, linkId: unknown) {
  const link = (Array.isArray(scope.graph.links) ? scope.graph.links : [])
    .find(link => (Array.isArray(link) ? link[0] : row(link)?.id) === linkId);
  const id = Array.isArray(link) ? link[1] : row(link)?.origin_id;
  const slot = Array.isArray(link) ? link[2] : row(link)?.origin_slot;
  if (id == null || typeof slot !== "number") return;
  return { id, slot, index: scope.nodes.findIndex(item => row(item)?.id === id) };
}

type VisualWidget = ReturnType<typeof visualWidgets>[number];

function visualInputWidget(scope: VisualScope, index: number, name: string, depth = 0): VisualWidget | undefined {
  const node = row(scope.nodes[index]);
  if (!node || !enabled(node) || depth >= 8) return;
  const linkId = entries(node.inputs).find(port => port.name === name)?.link;
  if (linkId == null)
    return visualWidgets(node, `${scope.prefix}/nodes/${index}`).find(widget => widget.widget === name);
  const source = visualSource(scope, linkId);
  if (!source) return;
  if (scope.parent && source.id === row(scope.graph.inputNode)?.id && Array.isArray(scope.graph.inputs)) {
    const input = row(scope.graph.inputs[source.slot])?.name;
    if (typeof input === "string") return visualInputWidget(scope.parent.scope, scope.parent.index, input, depth + 1);
  }
  const type = row(scope.nodes[source.index])?.type;
  if (source.slot === 0 && (type === "PrimitiveInt" || type === "PrimitiveBoolean"))
    return visualInputWidget(scope, source.index, "value", depth + 1);
}

function linkedVisualSteps(scope: VisualScope, node: Row, index: number): Found[] {
  const linkId = entries(node.inputs).find(port => port.name === "steps")?.link;
  if (!samplerTypes.includes(String(node.type)) || linkId == null) return [];
  const sampler = `${scope.prefix}/nodes/${index}`;
  const control = (widget: VisualWidget | undefined): Found[] =>
    typeof widget?.value === "number" ? [{ kind: "steps", label: labels.steps, sampler, value: widget.value,
      pointer: widget.pointer, namedPointer: widget.namedPointer }] : [];
  const direct = visualInputWidget(scope, index, "steps");
  if (direct) return control(direct);
  const source = visualSource(scope, linkId);
  const switchNode = source && row(scope.nodes[source.index]);
  if (!source || source.slot !== 0 || switchNode?.type !== "ComfySwitchNode" || !enabled(switchNode)) return [];
  const toggle = visualInputWidget(scope, source.index, "switch");
  if (!toggle || typeof toggle.value !== "boolean") return [];
  const initial = toggle.value;
  const editable = field("", "", toggle.name, toggle.pointer, initial)?.kind === "fast";
  return (editable ? [false, true] : [initial]).flatMap(value =>
    control(visualInputWidget(scope, source.index, value ? "on_true" : "on_false")).map(step =>
      editable ? { ...step, condition: { pointer: toggle.pointer, initial, value } } : step));
}

function visualImageLabel(source: Row, nodes: Row[], links: unknown, types: Map<unknown, string>) {
  if (!Array.isArray(links) || source.id == null) return undefined;
  const roles = new Set<string | undefined>();
  for (const item of links) {
    const link = row(item);
    const origin = link?.origin_id ?? (Array.isArray(item) ? item[1] : undefined);
    if (origin !== source.id) continue;
    const targetId = link?.target_id ?? (Array.isArray(item) ? item[3] : undefined);
    const slot = link?.target_slot ?? (Array.isArray(item) ? item[4] : undefined);
    const target = nodes.find(node => node.id === targetId);
    if (!target || !enabled(target) || !Array.isArray(target.inputs) || typeof slot !== "number") continue;
    const input = String(row(target.inputs[slot])?.name || "");
    const type = (types.get(target.type) || String(target.type)).replace(/[-_ ]/g, "");
    if (/reference/i.test(input)) roles.add("参考图");
    else if (/qwenimage/i.test(type)) roles.add(/^image[2-9]$/.test(input) ? "参考图" : /^image1?$/.test(input) ? "原图" : undefined);
    else roles.add(undefined);
  }
  return roles.size === 1 ? roles.values().next().value : undefined;
}

function controlsFromVisual(scope: VisualScope, types: Map<unknown, string>): Found[] {
  const { nodes, prefix, graph } = scope;
  const graphNodes = entries(nodes);
  return nodes.flatMap((item, index) => {
    const node = row(item);
    if (!node || !enabled(node) || typeof node.type !== "string") return [];
    const type = node.type;
    const controls = visualWidgets(node, `${prefix}/nodes/${index}`).flatMap(({ name, value, port, pointer, namedPointer }) => {
      if (port?.link != null) return [];
      const result = field(type, String(node.title || ""), name, pointer, value);
      if (!result) return [];
      if (result.kind === "image") result.label = visualImageLabel(node, graphNodes, graph.links, types) || result.label;
      return [{ ...result, namedPointer }];
    });
    return [...controls, ...linkedVisualSteps(scope, node, index)];
  });
}

function isLink(value: unknown, graph: Row): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" &&
    Number.isInteger(value[1]) && Object.hasOwn(graph, value[0]);
}

function ancestry(graph: Row, key: "positive" | "negative") {
  const reached = new Set<string>();
  const values = Object.values(graph).map(node => row(row(node)?.inputs)?.[key]);
  while (values.length) {
    const link = values.pop();
    if (!isLink(link, graph) || reached.has(link[0])) continue;
    reached.add(link[0]);
    values.push(...Object.values(row(row(graph[link[0]])?.inputs) || {}));
  }
  return reached;
}

function controlsFromApi(graph: Row): Found[] {
  const positive = ancestry(graph, "positive");
  const negative = ancestry(graph, "negative");
  return Object.entries(graph).flatMap(([id, entry]) => {
    const node = row(entry);
    if (typeof node?.class_type !== "string") return [];
    const type = node.class_type;
    const role = negative.has(id) ? "negative" : positive.has(id) ? "positive" : undefined;
    return Object.entries(row(node.inputs) || {}).flatMap(([name, value]) => {
      if (isLink(value, graph)) return [];
      const result = field(type, String(row(node._meta)?.title || ""), name, `/${segment(id)}/inputs/${segment(name)}`, value, role);
      return result ? [result] : [];
    });
  });
}

export function workflowControls(document: unknown): WorkflowControl[] {
  const graph = row(document);
  if (!graph) return [];
  let controls: Found[];
  if (Array.isArray(graph.nodes)) {
    const definitions = entries(row(graph.definitions)?.subgraphs);
    const types = new Map(definitions.map(definition => [definition.id, String(definition.name || "")]));
    const scope = { graph, nodes: graph.nodes, prefix: "" };
    controls = controlsFromVisual(scope, types);
    const definitionsByIndex = row(graph.definitions)?.subgraphs;
    if (Array.isArray(definitionsByIndex)) definitionsByIndex.forEach((item, index) => {
      const definition = row(item);
      if (!Array.isArray(definition?.nodes)) return;
      const instances = scope.nodes.flatMap((item, index) => {
        const node = row(item);
        return node && enabled(node) && node.type === definition.id ? [index] : [];
      });
      if (instances.length === 1) controls.push(...controlsFromVisual({
        graph: definition, nodes: definition.nodes, prefix: `/definitions/subgraphs/${index}`,
        parent: { scope, index: instances[0] },
      }, types));
    });
  } else controls = controlsFromApi(graph);
  return order.flatMap(kind => {
    const fields = controls.filter(item => item.kind === kind);
    const visible = kind === "prompt" && fields.length > 1 ? fields.filter(item => item.explicitPrompt) :
      fields.filter((item, index) => fields.findIndex(field =>
        field.pointer === item.pointer && field.condition?.pointer === item.condition?.pointer &&
        field.condition?.value === item.condition?.value) === index);
    return visible.map(item => {
      const peers = [...new Set(visible.filter(field => field.label === item.label).map(field => field.sampler || field.pointer))];
      return peers.length > 1 ? { ...item, label: `${item.label} ${peers.indexOf(item.sampler || item.pointer) + 1}` } : item;
    });
  });
}

export function workflowEdits(changes: Record<string, string>, controls: WorkflowControl[]) {
  return controls.flatMap(control => {
    const text = changes[control.pointer];
    if (text === undefined) return [];
    let value: WorkflowControl["value"] = text;
    if (typeof control.value === "number") {
      value = text.trim() ? Number(text) : NaN;
      if (control.kind === "steps" && (!Number.isInteger(value) || value < 1)) {
        const mode = control.condition ? (control.condition.value ? "加速模式的" : "普通模式的") : "";
        throw new Error(`${mode}${control.label}必须是大于 0 的整数`);
      }
      if (!Number.isFinite(value) || control.kind === "strength" && (value < 0 || value > 1))
        throw new Error(`${control.label}的数值无效`);
    } else if (typeof control.value === "boolean") value = text === "true";
    if ((control.kind === "image" || control.kind === "output") && typeof value === "string" && !value.trim())
      throw new Error(`请填写${control.label}`);
    if (value === control.value) return [];
    const edit = { pointer: control.pointer, value };
    return control.namedPointer ? [edit, { ...edit, pointer: control.namedPointer }] : [edit];
  });
}
