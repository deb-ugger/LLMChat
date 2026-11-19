import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { SearchableSelect } from "./SearchableSelect";
import { showAppNotice } from "./AppNotice";
import { useGameActionConfirm } from "./GameActionConfirm";

type RecordValue = Record<string, unknown>;
type Field = { name: string; pointer: string; value: unknown; readOnly?: boolean };
type Group = { key: string; title: string; fields: Field[] };
type WorkflowFile = { path: string; modified?: number | null };
type Saved = { workflow: unknown; revision: string };
type Snapshot = Saved & { path: string; modified?: number | null };
type Inventory = { directory: string; model: string[]; clip: string[]; vae: string[] };
type Edit = { pointer: string; value: unknown };
const directoryKey = "llmchat-comfy-directory";
const workflowKey = "llmchat-comfy-saved-workflow";

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function pointerPart(key: string) { return key.replace(/~/g, "~0").replace(/\//g, "~1"); }
function nodeName(node: RecordValue, fallback = "") {
  return String(node.title || record(node._meta)?.title || node.type || node.class_type || fallback);
}

const knownWidgets: Record<string, string[]> = {
  UNETLoader: ["unet_name", "weight_dtype"], UnetLoaderGGUF: ["unet_name"],
  CLIPLoader: ["clip_name", "type", "device"], VAELoader: ["vae_name"],
  KSampler: ["seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
  KSamplerAdvanced: ["add_noise", "noise_seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "start_at_step", "end_at_step", "return_with_leftover_noise"],
  LoadImage: ["image", "upload"], SaveImage: ["filename_prefix"], ManualSigmas: ["sigmas"],
  PrimitiveInt: ["value", "control_after_generate"], PrimitiveFloat: ["value"], PrimitiveBoolean: ["value"], PrimitiveString: ["value"],
};

function configGroups(document: unknown): Group[] {
  const graph = record(document);
  if (!graph) return [];
  if (!Array.isArray(graph.nodes)) return Object.entries(graph).flatMap(([id, item]) => {
    const node = record(item), inputs = record(node?.inputs);
    if (!node || !inputs || typeof node.class_type !== "string") return [];
    return [{ key: id, title: `#${id} · ${nodeName(node)}`, fields: Object.entries(inputs).map(([name, value]) => ({
      name, value, pointer: `/${pointerPart(id)}/inputs/${pointerPart(name)}`,
      readOnly: Array.isArray(value) && value.length === 2 && typeof value[0] === "string" &&
        Number.isInteger(value[1]) && Object.hasOwn(graph, value[0]),
    })) }];
  });
  const visual = (nodes: unknown[], root: string, prefix: string): Group[] => nodes.flatMap((item, index) => {
    const node = record(item);
    if (!node) return [];
    const inputs = (Array.isArray(node.inputs) ? node.inputs : []).flatMap(port => record(port) ? [record(port)!] : []);
    const widgets = node.widgets_values;
    const namedInputs = inputs.filter(port => record(port.widget)).map(port => String(port.label || port.name));
    const names = Array.isArray(widgets) && namedInputs.length === widgets.length ? namedInputs : knownWidgets[String(node.type)] || [];
    const values = Array.isArray(widgets) ? Object.entries(widgets) : Object.entries(record(widgets) || {});
    const base = `${root}/nodes/${index}`;
    const fields: Field[] = values.map(([key, value]) => {
      const name = Array.isArray(widgets) ? names[Number(key)] || `参数 ${Number(key) + 1}` : key;
      return { name, value, pointer: `${base}/widgets_values/${pointerPart(key)}`,
        readOnly: inputs.some(port => (port.label === name || port.name === name) && port.link != null) };
    });
    for (const input of inputs.filter(port => port.link != null)) {
      fields.push({ name: String(input.label || input.name), value: `连线 #${input.link}`, pointer: `${base}/link/${input.name}`, readOnly: true });
    }
    return [{ key: base, title: `${prefix}#${node.id ?? index + 1} · ${nodeName(node)}`, fields }];
  });
  const groups = visual(graph.nodes, "", "");
  const subgraphs = record(graph.definitions)?.subgraphs;
  if (Array.isArray(subgraphs)) subgraphs.forEach((item, index) => {
    const sub = record(item);
    if (Array.isArray(sub?.nodes)) groups.push(...visual(sub.nodes, `/definitions/subgraphs/${index}`, `${sub.name || "子图"} / `));
  });
  return groups;
}

const fieldText = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value) ?? "null";
const valueType = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
function workflowEdits(changes: Record<string, string>, groups: Group[]): Edit[] {
  const fields = new Map(groups.flatMap(group => group.fields.map(field => [field.pointer, field] as const)));
  return Object.entries(changes).flatMap(([pointer, text]) => {
    const field = fields.get(pointer);
    if (!field || field.readOnly) return [];
    let value: unknown;
    try { value = typeof field.value === "string" ? text : JSON.parse(text); }
    catch { throw Error(`${field.name} 的参数格式无效`); }
    if (valueType(value) !== valueType(field.value) || typeof value === "number" && !Number.isFinite(value)) throw Error(`${field.name} 必须保持原参数类型`);
    return fieldText(field.value) === fieldText(value) ? [] : [{ pointer, value }];
  });
}

function ConfigControl({ field, text, change, inventory }: { field: Field; text: string; change: (text: string) => void; inventory: Inventory | null }) {
  if (field.readOnly || field.value == null) return <output className="style-redraw-config-value">{text} <small>只读</small></output>;
  if (typeof field.value === "boolean") return <input type="checkbox" checked={text === "true"} onChange={event => change(String(event.target.checked))} />;
  const modelType = /^unet_name(?:_|$)/.test(field.name) ? "model" : /^clip_name(?:_|$)/.test(field.name) ? "clip" : /^vae_name(?:_|$)/.test(field.name) ? "vae" : null;
  if (modelType && inventory && typeof field.value === "string") {
    const choices = inventory[modelType];
    const current = choices.find(name => name.replace(/\\/g, "/") === text.replace(/\\/g, "/"));
    return <SearchableSelect aria-label={field.name} value={current || text} placeholder="没有可用模型" onChange={event => change(event.target.value)}>
      {!current && <option value={text} disabled>{text}（未在目录中找到）</option>}
      {choices.map(name => <option key={name} value={name}>{name}</option>)}
    </SearchableSelect>;
  }
  if (typeof field.value === "number") return <input type="number" step="any" value={text} onChange={event => change(event.target.value)} />;
  if (typeof field.value !== "string" || field.name.includes("prompt") || text.includes("\n")) {
    return <textarea rows={3} spellCheck={false} value={text} onChange={event => change(event.target.value)} />;
  }
  return <input type="text" value={text} onChange={event => change(event.target.value)} />;
}

export function ComfyWorkflowEditor<Queue>({ active, showDirectory, renderQueue }: {
  active: boolean; showDirectory: boolean; renderQueue: (queue: Queue | null, error: string) => ReactNode;
}) {
  const [files, setFiles] = useState<WorkflowFile[] | null>(null);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [queueError, setQueueError] = useState("");
  const [listError, setListError] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(() => localStorage.getItem(workflowKey) || "");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<"run" | "save" | null>(null);
  const [query, setQuery] = useState("");
  const [directories, setDirectories] = useState<string[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const { dialog, confirm } = useGameActionConfirm();
  const file = files?.find(file => file.path === selected);
  const current = snapshot?.path === selected ? snapshot : null;
  const dirty = Object.keys(changes).length > 0;
  const outdated = !!current && (!file || current.modified !== file.modified);
  const groups = useMemo(() => configGroups(current?.workflow), [current?.workflow]);
  const search = query.trim().toLowerCase();

  const inspect = async (path: string, announce = false) => {
    try {
      const value = await invoke<Inventory>("inspect_redraw_directory", { directory: path });
      setInventory(value);
      localStorage.setItem(directoryKey, value.directory);
      if (announce) showAppNotice("已识别 ComfyUI 目录");
    } catch (error) { if (announce) showAppNotice(String(error), "error"); }
  };
  useEffect(() => {
    void invoke<string[]>("find_redraw_directories").then(found => {
      setDirectories(found);
      const path = localStorage.getItem(directoryKey) || found[0];
      if (path) void inspect(path);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!active) return;
    let watching = true;
    let timer: number | undefined;
    const poll = async () => {
      await Promise.all([
        invoke<WorkflowFile[] | null>("list_redraw_workflows").then(value => {
          if (watching) { setFiles(value); setListError(""); }
        }, error => { if (watching) setListError(String(error)); }),
        invoke<Queue>("read_redraw_queue").then(value => {
          if (watching) { setQueue(value); setQueueError(""); }
        }, error => { if (watching) setQueueError(String(error)); }),
      ]);
      if (watching) timer = window.setTimeout(poll, 3000);
    };
    void poll();
    return () => { watching = false; window.clearTimeout(timer); };
  }, [active]);

  useEffect(() => {
    if (!active || !file || dirty) { setLoading(false); return; }
    let reading = true;
    setLoading(true); setError("");
    void invoke<Saved>("read_redraw_workflow", { path: selected }).then(value => {
      if (reading) setSnapshot({ ...value, path: selected, modified: file.modified });
    }).catch(error => { if (reading) setError(String(error)); })
      .finally(() => { if (reading) setLoading(false); });
    return () => { reading = false; };
  }, [active, file?.path, file?.modified, dirty, refresh]);

  const choose = async (path: string) => {
    if (path === selected || working) return;
    if (dirty && !await confirm("放弃当前尚未保存的参数修改并切换工作流？", { title: "切换工作流", okLabel: "放弃并切换", cancelLabel: "继续编辑", kind: "warning" })) return;
    setSelected(path); setChanges({}); setQuery(""); setError(""); setLoading(false);
    localStorage.setItem(workflowKey, path);
  };
  const reload = async () => {
    if (dirty && !await confirm("重新读取会放弃当前尚未保存的参数修改，是否继续？", { title: "读取已保存版本", okLabel: "重新读取", cancelLabel: "继续编辑", kind: "warning" })) return;
    setChanges({}); setRefresh(value => value + 1);
  };
  const act = async (action: "run" | "save") => {
    if (!current || !file || working || loading || outdated) return;
    setWorking(action); setError("");
    try {
      const edits = workflowEdits(changes, groups);
      const args = { path: current.path, revision: current.revision, edits };
      if (action === "save") {
        if (!edits.length) { setChanges({}); return; }
        const saved = await invoke<Saved>("save_redraw_workflow", args);
        setSnapshot({ ...saved, path: current.path, modified: file.modified });
        setChanges({});
        showAppNotice("已保存到原工作流");
      } else {
        const job = await invoke<{ prompt_id: string; number?: number }>("submit_redraw_workflow", args);
        showAppNotice(`已加入 ComfyUI 队列 · ${job.number == null ? job.prompt_id.slice(0, 8) : `任务 #${job.number}`}`);
      }
    } catch (error) { setError(String(error)); }
    finally { setWorking(null); }
  };

  return <section className="style-redraw style-redraw-native-workflows">
    {dialog}
    <div className="style-redraw-settings">
      <div className="style-redraw-config">
        <header><h2>软件重绘</h2></header>
        {showDirectory && <section className="style-redraw-card"><label>ComfyUI 便携版目录
          <SearchableSelect aria-label="ComfyUI 便携版目录" value={inventory?.directory || ""} placeholder="选择检测到的目录或手动浏览"
            onChange={event => {
              const value = event.target.value;
              if (value !== "__manual__") void inspect(value, true);
              else void open({ directory: true, multiple: false, title: "选择 ComfyUI 便携版目录" })
                .then(path => { if (typeof path === "string") void inspect(path, true); })
                .catch(error => showAppNotice(String(error), "error"));
            }}>
            {[...new Set([...directories, inventory?.directory].filter((dir): dir is string => !!dir))].map(dir => <option key={dir} value={dir}>{dir}</option>)}
            <option value="__manual__">手动选择目录…</option>
          </SearchableSelect>
        </label></section>}
        <section className="style-redraw-card">
          <h3>已保存工作流</h3>
          {listError ? <p className="style-redraw-error" role="status">{listError.includes("not allowed by ACL")
            ? "当前程序未授权读取工作流，请更新 LLMChat 后重试。" : listError}</p>
            : files?.length ? <SearchableSelect aria-label="已保存工作流" value={file ? selected : ""} disabled={!!working} placeholder="选择工作流"
            onChange={event => void choose(event.target.value)}>
            {files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}
          </SearchableSelect> : <p className="style-redraw-hint">{files == null ? "请连接本机 ComfyUI 后选择工作流。" : "请先在 ComfyUI 编辑器或浏览器中新增并保存工作流。"}</p>}
          {loading && <small role="status">正在读取工作流…</small>}
          {current && <>
            <div className="style-redraw-tools">
              <button type="button" className="style-redraw-primary" disabled={!!working || loading || outdated} onClick={() => void act("run")}>{working === "run" ? "正在提交…" : "运行当前配置"}</button>
              <button type="button" disabled={!dirty || !!working || loading || outdated} onClick={() => void act("save")}>{working === "save" ? "正在保存…" : "保存修改"}</button>
              <button type="button" disabled={!file || !!working || loading} onClick={() => void reload()}>重新读取</button>
            </div>
            {outdated && <p className="style-redraw-error" role="status">工作流已更新或不再可用。重新读取后再运行或保存。</p>}
            {dirty && !outdated && <small className="style-redraw-hint">有未保存的修改，可直接运行。保存只更新当前工作流。</small>}
          </>}
          {error && <p className="style-redraw-error" role="status">{error}</p>}
        </section>
        {current && <section className="style-redraw-card style-redraw-workflow-config">
          <div className="style-redraw-card-head"><h3>节点参数</h3>
            <input type="search" aria-label="搜索节点参数" placeholder="搜索节点或参数" value={query} onChange={event => setQuery(event.target.value)} />
          </div>
          <fieldset disabled={loading || !!working}>
            {groups.filter(group => !search || group.title.toLowerCase().includes(search) || group.fields.some(field => field.name.toLowerCase().includes(search))).map(group =>
              <details key={group.key} open={search ? true : undefined}>
                <summary>{group.title}</summary>
                {group.fields.length ? <div className="style-redraw-model-grid">{group.fields.map(field =>
                  <label key={field.pointer}>{field.name}<ConfigControl field={field} text={changes[field.pointer] ?? fieldText(field.value)} inventory={inventory}
                    change={value => setChanges(previous => {
                      const next = { ...previous };
                      if (value === fieldText(field.value)) delete next[field.pointer]; else next[field.pointer] = value;
                      return next;
                    })} /></label>)}</div> : <small className="style-redraw-hint">无已保存参数</small>}
              </details>)}
          </fieldset>
          <details><summary>原始工作流 JSON（只读）</summary><pre>{JSON.stringify(current.workflow, null, 2)}</pre></details>
        </section>}
      </div>
      {renderQueue(queue, queueError)}
    </div>
  </section>;
}
