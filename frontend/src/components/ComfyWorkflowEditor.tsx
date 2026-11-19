import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { SearchableSelect } from "./SearchableSelect";
import { showAppNotice } from "./AppNotice";
import { workflowControls, workflowEdits, type WorkflowControl } from "../comfyWorkflowFields";
import { useGameActionConfirm } from "./GameActionConfirm";

type WorkflowFile = { path: string; modified?: number | null };
type Saved = { workflow: unknown; revision: string };
type Snapshot = Saved & { path: string; modified?: number | null };
type Inventory = { directory: string; model: string[]; clip: string[]; vae: string[] };
const directoryKey = "llmchat-comfy-directory";
const workflowKey = "llmchat-comfy-saved-workflow";

function filePayload(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(new Error("无法读取所选图片"));
    reader.readAsDataURL(file);
  });
}

function Control({ field, text, change, upload, canUpload }: {
  field: WorkflowControl; text: string; change: (text: string) => void; upload: (file: File) => void; canUpload: boolean;
}) {
  if (field.kind === "image") return <div className="style-redraw-input-image">
    <span data-tooltip={text}>{text.split(/[\\/]/).at(-1) || "未选择图片"}</span>
    <label className="style-redraw-image-pick">更换图片
      <input type="file" aria-label={`更换${field.label}`} accept="image/png,image/jpeg,image/webp,image/bmp"
        disabled={!canUpload} onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) upload(file);
        }} />
    </label>
  </div>;
  if (field.kind === "prompt") return <textarea rows={3} aria-label={field.label} value={text} onChange={event => change(event.target.value)} />;
  if (field.kind === "fast") return <label className="style-redraw-toggle">
    <input type="checkbox" aria-label={field.label} checked={text === "true"} onChange={event => change(String(event.target.checked))} />
    <span>减少生成时间</span>
  </label>;
  if (field.kind === "strength") {
    const percent = Math.round(Number(text) * 100);
    return <div className="style-redraw-strength">
      <input type="range" aria-label={field.label} min={0} max={100} value={percent}
        onChange={event => change(String(event.currentTarget.valueAsNumber / 100))} />
      <output>{percent}%</output>
    </div>;
  }
  if (field.kind === "steps") return <input type="number" aria-label={field.label} min={1} step={1}
    value={text} onChange={event => change(event.target.value)} />;
  return <input type="text" aria-label={field.label} value={text} onChange={event => change(event.target.value)} />;
}

export function ComfyWorkflowEditor<Queue>({ active, renderQueue }: {
  active: boolean; renderQueue: (queue: Queue | null, error: string) => ReactNode;
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
  const [working, setWorking] = useState<"run" | "save" | "upload" | "connect" | null>(null);
  const [directories, setDirectories] = useState<string[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const { dialog, confirm } = useGameActionConfirm();
  const file = files?.find(file => file.path === selected);
  const current = snapshot?.path === selected ? snapshot : null;
  const dirty = Object.keys(changes).length > 0;
  const outdated = !!current && (!file || current.modified !== file.modified);
  const controls = useMemo(() => workflowControls(current?.workflow), [current?.workflow]);

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
    setSelected(path); setChanges({}); setError(""); setLoading(false);
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
      const edits = workflowEdits(changes, controls);
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

  const setField = (field: WorkflowControl, value: string) => {
    setChanges(previous => {
      const next = { ...previous };
      if (value === String(field.value)) delete next[field.pointer];
      else next[field.pointer] = value;
      return next;
    });
  };

  const upload = async (field: WorkflowControl, file: File) => {
    if (!inventory || working || !current || outdated) return;
    setWorking("upload"); setError("");
    try {
      const result = await invoke<{ name: string }>("run_style_redraw", {
        directory: inventory.directory, image: await filePayload(file), steps: 1, regions: [],
        mode: "workflow-input", profile: { name: file.name }, progress: new Channel<string>(),
      });
      setField(field, result.name);
    } catch (cause) { setError(String(cause)); }
    finally { setWorking(null); }
  };

  const connect = async () => {
    if (!inventory || working) return;
    setWorking("connect"); setListError("");
    try {
      await invoke("prepare_redraw_ui", { directory: inventory.directory, progress: new Channel<string>() });
      setFiles(await invoke<WorkflowFile[] | null>("list_redraw_workflows"));
    } catch (cause) { setListError(String(cause)); }
    finally { setWorking(null); }
  };

  return <section className="style-redraw style-redraw-native-workflows">
    {dialog}
    <div className="style-redraw-settings">
      <div className="style-redraw-config">
        <section className="style-redraw-card style-redraw-connection">
          <label>ComfyUI 目录
          <SearchableSelect aria-label="ComfyUI 便携版目录" value={inventory?.directory || ""} placeholder="选择便携版目录"
            disabled={!!working}
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
          </label>
          {files === null && inventory && <button type="button" disabled={!!working} onClick={() => void connect()}>
            {working === "connect" ? "正在连接…" : "连接 ComfyUI"}
          </button>}
        </section>
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
              <button type="button" className="style-redraw-primary" disabled={!!working || loading || outdated} onClick={() => void act("run")}>{working === "run" ? "正在提交…" : "开始重绘"}</button>
              <button type="button" disabled={!dirty || !!working || loading || outdated} onClick={() => void act("save")}>{working === "save" ? "正在保存…" : "保存修改"}</button>
              <button type="button" disabled={!file || !!working || loading} onClick={() => void reload()}>重新读取</button>
            </div>
            {outdated && <p className="style-redraw-error" role="status">工作流已更新或不再可用。重新读取后再运行或保存。</p>}
            {dirty && !outdated && <small className="style-redraw-hint">有未保存的修改，可直接运行。保存只更新当前工作流。</small>}
          </>}
          {error && <p className="style-redraw-error" role="status">{error}</p>}
        </section>
        {current && (controls.length ? <section className="style-redraw-card style-redraw-workflow-config">
          <h3>重绘参数</h3>
          {working === "upload" && <small role="status">正在上传图片…</small>}
          <fieldset disabled={loading || !!working || outdated}>
            {controls.map(field => <div className={"style-redraw-field style-redraw-field-" + field.kind} key={field.pointer}>
              <span data-tooltip={field.kind === "strength" ? "数值越高，生成结果可以与原图差别越大。" : field.kind === "steps" ? "增加步数通常会延长生成时间。" : undefined}>{field.label}</span>
              <Control field={field} text={changes[field.pointer] ?? String(field.value)} canUpload={!!inventory}
                change={value => setField(field, value)} upload={file => void upload(field, file)} />
            </div>)}
          </fieldset>
        </section> : <p className="style-redraw-hint">这个工作流的参数可在 ComfyUI 编辑器中调整。</p>)}
      </div>
      {renderQueue(queue, queueError)}
    </div>
  </section>;
}
