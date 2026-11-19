export type WorkflowControlKind = "image" | "prompt" | "fast" | "steps" | "strength" | "output";
export type WorkflowControl = { kind: WorkflowControlKind; label: string; pointer: string; value: string | number | boolean };
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

type Found = WorkflowControl & { explicitPrompt?: boolean };

function field(type: string, nodeTitle: string, name: string, pointer: string, value: unknown, role?: "positive" | "negative"): Found | undefined {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const title = [nodeTitle, key].join(" ");
  let kind: WorkflowControlKind;
  let explicitPrompt = false;
  if (type === "LoadImage" && key === "image" && typeof value === "string") kind = "image";
  else if (key === "filename_prefix" && type === "SaveImage" && typeof value === "string") kind = "output";
  else if (["enable_turbo_mode", "turbo", "fast_mode"].includes(key) && typeof value === "boolean") kind = "fast";
  else if (["KSampler", "KSamplerAdvanced", "BasicScheduler"].includes(type) && key === "steps" && typeof value === "number") kind = "steps";
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
};

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

function controlsFromVisual(nodes: unknown[], prefix: string, links: unknown, types: Map<unknown, string>): Found[] {
  const graphNodes = entries(nodes);
  return nodes.flatMap((item, index) => {
    const node = row(item);
    if (!node || !enabled(node) || typeof node.type !== "string") return [];
    const type = node.type;
    const ports = entries(node.inputs);
    const widgets = ports.filter(port => row(port.widget));
    const values = node.widgets_values;
    const nameOf = (port: Row) => String(port.label || port.name || "");
    const pointed = (key: string, name: string, value: unknown, port?: Row) => {
      if (port?.link != null) return [];
      const result = field(type, String(node.title || ""), name, `${prefix}/nodes/${index}/widgets_values/${segment(key)}`, value);
      if (!result) return [];
      if (result.kind === "image") result.label = visualImageLabel(node, graphNodes, links, types) || result.label;
      return [result];
    };
    if (!Array.isArray(values)) return Object.entries(row(values) || {}).flatMap(([key, value]) => {
      const port = ports.find(p => p.name === key || p.label === key || row(p.widget)?.name === key);
      return pointed(key, port ? nameOf(port) : key, value, port);
    });
    let names = namesByType[type] || [];
    if (type === "KSampler") {
      names = ["seed", ...(typeof values[1] === "string" ? ["seed_mode"] : []), "steps", "cfg", "sampler", "scheduler", "denoise"];
    } else if (type === "KSamplerAdvanced") {
      names = ["add_noise", "seed", ...(typeof values[2] === "string" ? ["seed_mode"] : []), "steps"];
    }
    return values.flatMap((value, position) => {
      const port = widgets.length === values.length ? widgets[position] :
        ports.find(input => input.name === names[position] || row(input.widget)?.name === names[position]);
      return pointed(String(position), port ? nameOf(port) : names[position] || "", value, port);
    });
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
    controls = controlsFromVisual(graph.nodes, "", graph.links, types);
    const instances = entries(graph.nodes).filter(enabled);
    const definitionsByIndex = row(graph.definitions)?.subgraphs;
    if (Array.isArray(definitionsByIndex)) definitionsByIndex.forEach((item, index) => {
      const definition = row(item);
      if (Array.isArray(definition?.nodes) && instances.filter(node => node.type === definition.id).length === 1)
        controls.push(...controlsFromVisual(definition.nodes, `/definitions/subgraphs/${index}`, definition.links, types));
    });
  } else controls = controlsFromApi(graph);
  return order.flatMap(kind => {
    const fields = controls.filter(item => item.kind === kind);
    const visible = kind === "prompt" && fields.length > 1 ? fields.filter(item => item.explicitPrompt) : fields;
    return visible.map(item => {
      const peers = visible.filter(field => field.label === item.label);
      return peers.length > 1 ? { ...item, label: `${item.label} ${peers.indexOf(item) + 1}` } : item;
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
      if (!Number.isFinite(value) || control.kind === "steps" && (!Number.isInteger(value) || value < 1) ||
        control.kind === "strength" && (value < 0 || value > 1)) throw new Error(`${control.label}的数值无效`);
    } else if (typeof control.value === "boolean") value = text === "true";
    if ((control.kind === "image" || control.kind === "output") && typeof value === "string" && !value.trim())
      throw new Error(`请填写${control.label}`);
    return value === control.value ? [] : [{ pointer: control.pointer, value }];
  });
}
