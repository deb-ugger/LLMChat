import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getOutputDirectory, saveOutputFile } from "../outputFiles";
import { showAppNotice } from "./AppNotice";
import { SearchableSelect } from "./SearchableSelect";
import { ComfyWorkflowEditor } from "./ComfyWorkflowEditor";
import { api } from "../api";
import { savedVisualRedrawParameters, type ComfyRedrawParameters } from "../comfySavedWorkflow";
import { loadStyleRedrawProfiles as savedProfiles, styleRedrawDirectoryKey as directoryKey, styleRedrawProfilesKey as profilesKey,
  styleRedrawLabels as labels, type StyleRedrawProfile as Profile, type StyleRedrawProfileId as ProfileId } from "../gameImagePlacement";
import "../styleRedraw.css";

type Box = [number, number, number, number];
type Region = { box: Box; translation: string };
const writingModes = {
  auto: "自动",
  horizontal: "横排字",
  "horizontal-reverse": "横排字（反向）",
  vertical: "竖排字",
  "vertical-reverse": "竖排字（反向）",
} as const;
type WritingMode = keyof typeof writingModes;
type GameInput = {
  name: string; regions: Region[]; load: () => Promise<Blob>;
  apply: (file: File) => Promise<unknown>; failure: (message: string) => Promise<void>;
};
const comfyUrl = "http://127.0.0.1:8188";
const openPreferenceKey = "llmchat-comfy-open-preference";
const savedWorkflowKey = "llmchat-comfy-saved-workflow";
type WebTarget = "embedded" | "browser";
const webTargetLabels: Record<WebTarget, string> = { embedded: "软件内打开", browser: "默认浏览器" };
const modelFields = [["model", "扩散模型"], ["clip", "文本编码器"], ["vae", "VAE"]] as const;
type ModelField = typeof modelFields[number][0];
type Inventory = { directory: string } & Record<ModelField, string[]>;
type QueueImage = { filename: string; subfolder: string; type: string };
type EditorBounds = { x: number; y: number; width: number; height: number };
type QueueRow = { id: string; number: number; time?: number | null; duration?: number | null; state?: "done" | "failed" | "interrupted"; image?: QueueImage | null; parameters?: ComfyRedrawParameters | null };
type ComfyQueue = { online: boolean; running?: QueueRow[]; waiting?: QueueRow[]; history?: QueueRow[] };
type SavedWorkflow = { path: string; modified?: number | null };
type WorkflowPreview = { revision: string; parameters: ComfyRedrawParameters | null; error?: string };

function modelChoices(inventory: Inventory | null, id: ProfileId, field: ModelField) {
  return (inventory?.[field] || []).filter(name => {
    if (id === "custom") return true;
    const gguf = /\.gguf$/i.test(name);
    return gguf === (id === "2511" && field === "model");
  });
}

function usesWeight(profile: Profile, id: ProfileId, field: ModelField) {
  return id !== "custom" || !!profile.graph?.includes(`"{{${field}}}"`);
}

function compatibleTaskWeights(inventory: Inventory | null, parameters: ComfyRedrawParameters) {
  const weights: Partial<Profile> = {};
  const missing: string[] = [];
  const normalized = (name: string) => name.replace(/\\/g, "/");
  for (const [field, title] of modelFields) {
    const value = parameters[field];
    if (!value) continue;
    const file = modelChoices(inventory, parameters.profile, field).find(name => normalized(name) === normalized(value));
    if (file) weights[field] = file;
    else missing.push(title);
  }
  return { weights, missing };
}

function RedrawThumbnail({ filename, subfolder, type, onOpen }: QueueImage & { onOpen: () => void }) {
  const preview = useRef<HTMLButtonElement>(null);
  const [source, setSource] = useState("");
  useEffect(() => {
    const holder = preview.current;
    if (!holder) return;
    let current = true;
    let url = "";
    setSource("");
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void invoke<ArrayBuffer>("read_redraw_thumbnail", { filename, subfolder, kind: type }).then(bytes => {
        if (!current) return;
        url = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
        setSource(url);
      }).catch(() => {});
    });
    observer.observe(holder);
    return () => { current = false; observer.disconnect(); if (url) URL.revokeObjectURL(url); };
  }, [filename, subfolder, type]);
  return <button type="button" className="style-redraw-thumbnail" ref={preview} aria-label={`预览原图：${filename}`}
    data-tooltip="点击预览原图" onClick={onOpen}>
    {source ? <img src={source} alt="" /> : <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="m3 16 5-5 4 4 3-3 6 6" /><circle cx="16" cy="9" r="1" />
    </svg>}
  </button>;
}

function RedrawOriginalPreview({ image, onClose }: { image: QueueImage; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [dimensions, setDimensions] = useState("");
  const { filename, subfolder, type } = image;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => {
    let current = true;
    let url = "";
    void invoke<ArrayBuffer>("read_redraw_thumbnail", { filename, subfolder, kind: type, original: true }).then(bytes => {
      if (!current) return;
      url = URL.createObjectURL(new Blob([bytes]));
      setSource(url);
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : String(error)); });
    return () => { current = false; if (url) URL.revokeObjectURL(url); };
  }, [filename, subfolder, type]);
  return <dialog ref={dialog} className="style-redraw-image-dialog" aria-label="ComfyUI 原图预览"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
    <header><strong title={filename}>{filename}</strong>
      {dimensions && <small>{dimensions} · 100%</small>}
      <button type="button" onClick={onClose}>关闭</button>
    </header>
    {error ? <p className="style-redraw-error" role="status">{error}</p>
      : source ? <div className="style-redraw-image-scroll" tabIndex={0} aria-label="按原始尺寸查看图片">
        <img src={source} alt={filename} draggable={false}
          onLoad={event => setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)}
          onError={() => setError("无法解码这张图片")} />
      </div> : <p className="style-redraw-hint" role="status">正在读取原图…</p>}
  </dialog>;
}

function RedrawQueue({ queue, error, canApply, onApply }: {
  queue: ComfyQueue | null; error: string; canApply?: boolean; onApply?: (item: QueueRow, parameters: ComfyRedrawParameters) => void;
}) {
  const [preview, setPreview] = useState<QueueImage | null>(null);
  const row = (item: QueueRow) => {
    return <li key={item.id}>
      {item.image && <RedrawThumbnail {...item.image} onOpen={() => setPreview(item.image || null)} />}
      <div><strong title={item.image?.filename || item.id}>{item.image?.filename || `任务 #${item.number}`}</strong>
        <small title={item.id}>{[`#${item.number} · ${item.id.slice(0, 8)}`,
          item.state === "done" ? "已完成" : item.state === "failed" ? "失败" : item.state === "interrupted" ? "已中止" : "",
          item.time && new Date(item.time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
          item.duration != null ? `${(item.duration / 1000).toFixed(1)} 秒` : ""].filter(Boolean).join(" · ")}</small>
        {item.parameters && <small title={item.parameters.model}>{item.parameters.model}{item.parameters.steps != null ? ` · ${item.parameters.steps} 步` : ""}</small>}
      </div>
      {item.parameters && onApply && <button type="button" disabled={!canApply} data-tooltip="套用已安装的权重和受支持的采样步数，不更改节点"
        onClick={() => { if (item.parameters) onApply(item, item.parameters); }}>套用参数</button>}
    </li>;
  };
  return <section className="style-redraw-card style-redraw-queue" aria-label="ComfyUI 任务队列">
    <h3>任务队列</h3>
    {error ? <p className="style-redraw-error" role="status">{error}</p> : queue?.online ? <>
      <p className="style-redraw-hint">{queue.running?.length || 0} 个运行中 · {queue.waiting?.length || 0} 个等待</p>
      <div className="style-redraw-queue-list">
        {([["运行中", queue.running], ["等待中", queue.waiting], ["最近历史", queue.history]] as const).map(([label, rows]) =>
          !!rows?.length && <section key={label}><h4>{label}</h4><ul>{rows.map(row)}</ul></section>)}
        {!queue.running?.length && !queue.waiting?.length && !queue.history?.length && <p className="style-redraw-hint">暂无任务</p>}
      </div>
    </> : <p className="style-redraw-hint">{queue ? "ComfyUI 尚未连接。" : "正在连接本机 ComfyUI…"}</p>}
    {preview && <RedrawOriginalPreview image={preview} onClose={() => setPreview(null)} />}
  </section>;
}

function SharedWorkflows({ files, selected, preview, error, select, apply, canApply }: {
  files: SavedWorkflow[] | null; selected: SavedWorkflow | undefined; preview: WorkflowPreview | null; error: string;
  select: (path: string) => void; apply: (parameters: ComfyRedrawParameters) => void; canApply: boolean;
}) {
  const parameters = preview?.parameters;
  return <section className="style-redraw-card" aria-label="ComfyUI 已保存工作流">
    <h3>已保存工作流</h3>
    {error ? <p className="style-redraw-error" role="status">{error}</p> : files?.length ? <>
      <SearchableSelect aria-label="ComfyUI 已保存工作流" value={selected?.path || ""} placeholder="选择 ComfyUI 中保存的工作流"
        onChange={event => select(event.target.value)}>
        {files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}
      </SearchableSelect>
      {selected && <>
        {selected.modified != null && <small className="style-redraw-hint">保存时间：{new Date(selected.modified).toLocaleString("zh-CN")}</small>}
        {!preview ? <small role="status">正在读取已保存内容…</small>
          : preview.error ? <small className="style-redraw-error" role="status">{preview.error}</small>
          : !parameters ? <small className="style-redraw-hint">未识别到可套用的重绘参数，可在 ComfyUI 编辑器中打开此工作流。</small>
          : <>
            <dl className="style-redraw-workflow-parameters">
              <div><dt>预设</dt><dd>{labels[parameters.profile]}</dd></div>
              {modelFields.map(([field, title]) => parameters[field] && <div key={field}><dt>{title}</dt><dd title={parameters[field] || ""}>{parameters[field]}</dd></div>)}
              {parameters.steps != null && <div><dt>采样步数</dt><dd>{parameters.steps}</dd></div>}
            </dl>
            <button type="button" disabled={!canApply} onClick={() => apply(parameters)}>套用已保存参数</button>
          </>}
      </>}
    </> : <p className="style-redraw-hint">{files == null ? "连接 ComfyUI 后显示共享工作流。" : "暂无工作流。请先在 ComfyUI 中保存。"}</p>}
  </section>;
}

function readImage(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

function Editor({ active, game, onBusy }: { active: boolean; game?: GameInput; onBusy?: (busy: boolean) => void }) {
  const [directory, setDirectory] = useState(() => localStorage.getItem(directoryKey) || "");
  const [output, setOutput] = useState("");
  const [source, setSource] = useState("");
  const [name, setName] = useState(game?.name || "");
  const [box, setBox] = useState<Box>([0, 0, 0, 0]);
  const [translation, setTranslation] = useState("");
  const [regionWritingModes, setRegionWritingModes] = useState<Partial<Record<number, WritingMode>>>({});
  const [steps, setSteps] = useState(8);
  const [program, setProgram] = useState("");
  const [layer, setLayer] = useState("");
  const [layerView, setLayerView] = useState(false);
  const [zoomRegion, setZoomRegion] = useState(-1);
  const [candidates, setCandidates] = useState<Record<string, string>>({});
  const [measurements, setMeasurements] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState("program");
  const result = choice === "program" ? program : candidates[choice] || "";
  const setResult = (value: string) => { setProgram(value); setLayer(""); setLayerView(false); setZoomRegion(-1); setCandidates({}); setChoice("program"); };
  const [profiles,setProfiles] = useState(savedProfiles);
  const [profileId,setProfileId] = useState<ProfileId>("turbo");
  const profile = profiles[profileId];
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [directories, setDirectories] = useState<string[]>([]);
  const [directoryStatus, setDirectoryStatus] = useState("");
  const [checkingDirectory, setCheckingDirectory] = useState(false);
  const directoryCheck = useRef(0);
  const [queue, setQueue] = useState<ComfyQueue | null>(null);
  const [queueError, setQueueError] = useState("");
  const [workflowFiles, setWorkflowFiles] = useState<SavedWorkflow[] | null>(null);
  const [workflowError, setWorkflowError] = useState("");
  const [selectedWorkflowPath, setSelectedWorkflowPath] = useState(() => localStorage.getItem(savedWorkflowKey) || "");
  const [workflowPreview, setWorkflowPreview] = useState<WorkflowPreview | null>(null);
  const savedWorkflow = workflowFiles?.find(file => file.path === selectedWorkflowPath);
  const workflowRevision = savedWorkflow && JSON.stringify([savedWorkflow.path, savedWorkflow.modified]);
  const editor = useRef<HTMLElement>(null);
  const missing = modelFields.filter(([field]) => usesWeight(profile, profileId, field) &&
    !modelChoices(inventory, profileId, field).includes(profile[field])).map(([field, title]) => profile[field] || title);
  const selectProfile = (id: ProfileId) => { setProfileId(id); setSteps(id === "turbo" ? 8 : 20); };
  const selectControl = <select aria-label="模型工作流" value={profileId} onChange={e => selectProfile(e.target.value as ProfileId)}>
    {(Object.keys(labels) as ProfileId[]).map(id => <option key={id} value={id}>{labels[id]}</option>)}</select>;
  const changeProfile = (id: ProfileId, patch: Partial<Profile>) => {
    setProfiles(previous => {
      const next = { ...previous, [id]: { ...previous[id], ...patch } };
      localStorage.setItem(profilesKey, JSON.stringify(next));
      return next;
    });
    setCandidates(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)));
    setChoice(previous => previous === id ? "program" : previous);
  };
  const applyParameters = (origin: string, parameters: ComfyRedrawParameters) => {
    if (!inventory || processing.current) return;
    const { weights, missing } = compatibleTaskWeights(inventory, parameters);
    if (!weights.model) {
      showAppNotice("扩散模型未安装，未更改当前配置", "error");
      return;
    }
    changeProfile(parameters.profile, weights);
    selectProfile(parameters.profile);
    if (parameters.profile === "2511" && parameters.steps != null) setSteps(parameters.steps);
    showAppNotice(`已套用${origin}的参数${missing.length ? `，未安装：${missing.join("、")}` : ""}`);
  };
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const alive = useRef(true);
  const selection = useRef(0);
  const drag = useRef<[number, number] | null>(null);
  const processing = useRef(false);
  const [dimensions, setDimensions] = useState([0, 0]);
  const regionList = (game?.regions ?? [{ box, translation }]).map((region, index) => ({
    ...region, writingMode: regionWritingModes[index] ?? "auto",
  }));
  const writingModeControl = (index: number) => (
    <label>字形方向<select aria-label={game ? `区域 ${index + 1} 字形方向` : "字形方向"}
      title="字形沿原文行的角度排放，反向可旋转 180°"
      value={regionList[index].writingMode} onChange={event => {
        const mode = event.target.value as WritingMode;
        setRegionWritingModes(previous => ({ ...previous, [index]: mode }));
        setResult("");
      }}>
      {Object.entries(writingModes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
  );
  const zoom = result && regionList[zoomRegion]?.box;
  const cropPreview = (url: string, label: string) => zoom && <svg className="style-redraw-detail" role="img" aria-label={label}
    viewBox={`${zoom[0]} ${zoom[1]} ${zoom[2]-zoom[0]} ${zoom[3]-zoom[1]}`}
    style={{ aspectRatio: `${zoom[2]-zoom[0]} / ${zoom[3]-zoom[1]}` }}>
    <image href={url} width={dimensions[0]} height={dimensions[1]} />
  </svg>;
  const report = (e: unknown) => showAppNotice(e instanceof Error ? e.message : String(e), "error");
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!game) return;
    let current = true;
    game.load().then(readImage).then(value => { if (current) setSource(value); })
      .catch(error => { if (current) report(error); });
    return () => { current = false; };
  }, [game]);
  useEffect(() => {
    if (!game) void getOutputDirectory("redraw").then(setOutput).catch(report);
  }, [game]);

  const loadDirectory = async (path: string, announce: boolean) => {
    const token = ++directoryCheck.current;
    setCheckingDirectory(true);
    try {
      const next = await invoke<Inventory>("inspect_redraw_directory", { directory: path });
      if (!alive.current || token !== directoryCheck.current) return;
      localStorage.setItem(directoryKey, next.directory);
      setInventory(next);
      if (next.directory !== directory) { setCandidates({}); setChoice("program"); }
      setDirectory(next.directory);
      setDirectoryStatus("");
      if (announce) showAppNotice("已识别 ComfyUI 便携版并读取模型目录");
    } catch (error) {
      if (!alive.current || token !== directoryCheck.current) return;
      if (!inventory || path === directory) { setInventory(null); setDirectoryStatus(String(error)); }
      if (announce) report(error);
    } finally { if (alive.current && token === directoryCheck.current) setCheckingDirectory(false); }
  };
  const discoverDirectories = async () => {
    const found = await invoke<string[]>("find_redraw_directories");
    if (alive.current) setDirectories(found);
    return found;
  };
  useEffect(() => {
    let current = true;
    const initial = directoryCheck.current;
    const found = discoverDirectories().catch(() => [] as string[]);
    void (async () => {
      const saved = localStorage.getItem(directoryKey);
      const path = saved || (await found)[0];
      if (current && initial === directoryCheck.current && path) await loadDirectory(path, false);
    })();
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (!active) return;
    let current = true;
    let timer: number | undefined;
    const poll = async () => {
      if (!document.hidden && editor.current?.getClientRects().length) {
        await Promise.all([
          invoke<ComfyQueue>("read_redraw_queue").then(result => {
            if (current) { setQueue(result); setQueueError(""); }
          }, error => { if (current) setQueueError(String(error)); }),
          invoke<SavedWorkflow[] | null>("list_redraw_workflows").then(result => {
            if (current) { setWorkflowFiles(result); setWorkflowError(""); }
          }, error => { if (current) setWorkflowError(String(error)); }),
        ]);
      }
      if (current) timer = window.setTimeout(poll, 3000);
    };
    void poll();
    return () => { current = false; window.clearTimeout(timer); };
  }, [active]);
  useEffect(() => {
    if (!active || !workflowRevision) return;
    let current = true;
    setWorkflowPreview(null);
    void invoke<{ workflow: unknown; parameters: ComfyRedrawParameters | null }>("read_redraw_workflow", { path: selectedWorkflowPath })
      .then(result => {
        if (current) setWorkflowPreview({ revision: workflowRevision, parameters: result.parameters ?? savedVisualRedrawParameters(result.workflow) });
      }).catch(error => {
        if (current) setWorkflowPreview({ revision: workflowRevision, parameters: null, error: String(error) });
      });
    return () => { current = false; };
  }, [active, workflowRevision, selectedWorkflowPath]);
  const choose = async (value: string) => {
    const path = value === "__manual__"
      ? await open({ directory: true, multiple: false, title: "选择 ComfyUI 便携版目录", defaultPath: directory || undefined })
      : value;
    if (typeof path === "string") await loadDirectory(path, true);
  };
  const refreshDirectory = async () => {
    const found = await discoverDirectories();
    const path = directory || found[0];
    if (path) await loadDirectory(path, true);
    else showAppNotice("未检测到 ComfyUI 便携版，请手动选择目录", "error");
  };
  const select = async (file: File) => {
    const token = ++selection.current;
    setResult(""); setSource(""); setStatus("");
    const image = await createImageBitmap(file);
    try {
      const url = await readImage(file);
      if (selection.current !== token || !alive.current) return;
      setName(file.name); setSource(url); setDimensions([image.width, image.height]); setBox([0, 0, image.width, image.height]);
      setRegionWritingModes({});
    } finally { image.close(); }
  };
  const run = async (mode: "program" | "model") => {
    if (processing.current) return;
    processing.current = true; setBusy(true); onBusy?.(true); setStatus(mode === "program" ? "正在生成透明字层" : "准备模型候选");
    try {
      const started = performance.now();
      const progress = new Channel<string>();
      progress.onmessage = message => { if (alive.current) setStatus(message); };
      const png = await invoke<{image:string; layer?:string}>("run_style_redraw", {
        directory, steps: mode === "program" ? 20 : steps, mode, profile: { ...profile, kind: profileId }, image: source.slice(source.indexOf(",") + 1), regions: regionList, progress,
      });
      if (alive.current) {
        const url = "data:image/png;base64," + png.image;
        setLayerView(false);
        if (png.layer) setLayer("data:image/png;base64," + png.layer);
        if (mode === "program") { setProgram(url); setChoice("program"); setZoomRegion(0); }
        else {
          setCandidates(previous => ({ ...previous, [profileId]: url })); setChoice(profileId);
          setMeasurements(previous => ({ ...previous, [profileId]: `${steps} 步 · 含排队 ${Math.round((performance.now()-started)/1000)} 秒` }));
        }
        setStatus("");
      }
    } catch (error) {
      if (alive.current) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(message); report(message);
        if (game) await game.failure("AI 风格重绘失败：" + message);
      }
    } finally {
      processing.current = false;
      if (alive.current) { setBusy(false); onBusy?.(false); }
    }
  };
  const save = async () => {
    if (processing.current || !result) return;
    processing.current = true; setBusy(true); onBusy?.(true);
    try {
      const blob = await (await fetch(result)).blob();
      const filename = name.replace(/\.[^.]+$/, "") + "-重绘.png";
      if (game) {
        const accepted = await game.apply(new File([blob], filename, { type: "image/png" }));
        if (accepted === false) throw new Error("译图未能采用，请查看当前图片的处理结果");
        setStatus("已采用译图"); setResult("");
      } else {
        const path = await saveOutputFile(filename, new Uint8Array(await blob.arrayBuffer()), ["png"], "PNG 图片", "redraw");
        if (path) { setStatus(path); showAppNotice("重绘图片已保存"); }
      }
    } finally { processing.current = false; if (alive.current) { setBusy(false); onBusy?.(false); } }
  };
  const valid = regionList.length > 0 && regionList.every(r => r.translation.trim() && r.box.every(Number.isInteger) &&
    r.box[0] >= 0 && r.box[1] >= 0 && r.box[2] > r.box[0] && r.box[3] > r.box[1] &&
    (game || r.box[2] <= dimensions[0] && r.box[3] <= dimensions[1]));
  const canApply = !!inventory && !busy && !checkingDirectory;
  const sidebar = <div className="style-redraw-config">
    <SharedWorkflows files={workflowFiles} selected={savedWorkflow} preview={workflowPreview?.revision === workflowRevision ? workflowPreview : null}
      error={workflowError} canApply={canApply} select={path => {
        setSelectedWorkflowPath(path); localStorage.setItem(savedWorkflowKey, path);
      }} apply={parameters => applyParameters("已保存工作流", parameters)} />
    <RedrawQueue queue={queue} error={queueError} canApply={canApply} onApply={(item, parameters) => applyParameters(`任务 #${item.number}`, parameters)} />
  </div>;
  return <section ref={editor} className="style-redraw">
    <div className="style-redraw-settings">
      <div className="style-redraw-config">
      <fieldset disabled={busy} className="style-redraw-card style-redraw-run">
        {!game && <label>原图<input type="file" accept="image/*" onChange={e => { const file = e.target.files?.[0]; if (file) void select(file).catch(report); }} /></label>}
        {!game && source && <div className="style-redraw-box">{["左", "上", "右", "下"].map((label, i) =>
          <label key={label}>{label}<input type="number" value={box[i]} min={0} max={dimensions[i % 2]} onChange={e => {
            const next: Box = [...box]; next[i] = e.target.valueAsNumber || 0; setBox(next); setResult("");
          }} /></label>)}</div>}
        {game ? <details><summary>已勾选 {regionList.length} 个区域 · 字形方向</summary>
          <ol>{regionList.map((region, index) => <li key={index}><div className="style-redraw-tools">
            <span>{region.translation}</span>{writingModeControl(index)}
          </div></li>)}</ol>
        </details> : <>
          <label>目标译文<textarea rows={2} value={translation} onChange={e => { setTranslation(e.target.value); setResult(""); }} /></label>
          <div className="style-redraw-tools">{writingModeControl(0)}</div>
        </>}
        <div className="style-redraw-tools"><label>模型工作流{selectControl}</label><label>采样步数<input type="number" min={1} max={100} disabled={profileId === "turbo"} value={steps || ""} onChange={e => { setSteps(e.target.valueAsNumber || 0); }} /></label>
          <button disabled={!source || !valid || !inventory || checkingDirectory} onClick={() => void run("program").catch(report)}>生成中文字层</button>
          <button className="style-redraw-primary" disabled={!program || !inventory || checkingDirectory || missing.length > 0 || steps < 1 || steps > 100 || !Number.isInteger(steps) || (profileId === "custom" && !profile.graph)} onClick={() => void run("model").catch(report)}>生成模型候选</button>
          {program && <label>采用版本<select value={choice} onChange={e => setChoice(e.target.value)}>
            <option value="program">程序中文字层</option>{Object.keys(candidates).map(key => <option key={key} value={key}>{labels[key as ProfileId]} · {measurements[key]}</option>)}
          </select></label>}
          {result && <button onClick={() => void save().catch(report)}>{game ? "采用译图" : "保存 PNG"}</button>}
        </div>
      </fieldset>
      {game && !valid && <small>请先确认每个勾选区域的坐标和译文。</small>}
      {!inventory && directoryStatus && <small className="style-redraw-error">{directoryStatus}</small>}
      {inventory && missing.length > 0 && <small className="style-redraw-error">请在「重绘所需文件」选择已安装的模型：{missing.join("、")}</small>}
      <details className="style-redraw-game-files">
        <summary>重绘所需文件</summary>
        <section className="style-redraw-card">
          <div className="style-redraw-card-head"><h3>ComfyUI</h3>
            <button type="button" onClick={() => void refreshDirectory().catch(report)} disabled={checkingDirectory}>重新检测</button>
          </div>
          <label>便携版目录
            <SearchableSelect aria-label="ComfyUI 便携版目录" value={directory} disabled={checkingDirectory}
              placeholder="选择检测到的目录或手动浏览" onChange={e => void choose(e.target.value).catch(report)}>
              {[...new Set([...directories, directory].filter(Boolean))].map(path => <option key={path} value={path}>{path}</option>)}
              <option value="__manual__">手动选择目录…</option>
            </SearchableSelect>
          </label>
          <span role="status" className={directoryStatus && !checkingDirectory ? "style-redraw-error" : "style-redraw-hint"}>
            {checkingDirectory ? "正在读取目录…" : directoryStatus || (inventory ? "已识别便携版" : "尚未选择目录")}
          </span>
        </section>
        <section className="style-redraw-card">
          <h3>工作流模型</h3>
          {profileId === "custom" && <>
            <div className="style-redraw-model-grid">
              <label>导入 API 格式工作流<input type="file" accept=".json" onChange={e => {
                const file = e.target.files?.[0]; if (!file) return;
                void file.text().then(text => {
                  const graph = JSON.parse(text);
                  if (!graph || !Object.keys(graph).length || !Object.values(graph).every(n => n && typeof n === "object" && "class_type" in n)) throw Error("请从 ComfyUI 导出 API 格式工作流");
                  changeProfile("custom", { graph: text });
                }).catch(report);
              }} /></label>
              <label>输出节点 ID<input placeholder="只有一个图像输出时可留空" value={profile.output || ""} onChange={e => changeProfile("custom", { output: e.target.value })} /></label>
            </div>
            <p className="style-redraw-hint"><code>{"{{draft}}"}</code> 为中文底稿，<code>{"{{original}}"}</code> 为原花字，提示词用 <code>{"{{prompt}}"}</code> 或 <code>{"{{translation}}"}</code>。用 <code>{"{{model}}, {{clip}}, {{vae}}"}</code> 的权重在下方选择。</p>
            <small>{profile.graph ? "工作流已导入" : "尚未导入工作流"}</small>
          </>}
          <div className="style-redraw-model-grid">
            {modelFields.filter(([field]) => usesWeight(profile, profileId, field)).map(([field, title]) => {
              const files = modelChoices(inventory, profileId, field);
              const selected = files.includes(profile[field]);
              return <div key={field}><label>{title}
                <SearchableSelect aria-label={title} value={selected ? profile[field] : ""}
                  disabled={!inventory || checkingDirectory} placeholder={files.length ? "请选择模型" : inventory ? "没有找到可用模型" : "请先选择 ComfyUI 目录"}
                  onChange={e => changeProfile(profileId, { [field]: e.target.value })}>
                  {files.map(path => <option key={path} value={path}>{path}</option>)}
                </SearchableSelect>
              </label>
              {inventory && !selected && profile[field] && <small className="style-redraw-error">未找到：{profile[field]}</small>}
              </div>;
            })}
          </div>
        </section>
      </details>
      {result && <div className="style-redraw-tools"><label>预览范围<select value={zoomRegion} onChange={e => setZoomRegion(Number(e.target.value))}>
        <option value={-1}>整幅画布</option>{regionList.map((_,i) => <option key={i} value={i}>区域 {i+1}</option>)}
      </select></label>{choice === "program" && <label><span><input type="checkbox" checked={layerView} onChange={e => setLayerView(e.target.checked)} />仅预览透明字层</span></label>}</div>}
      {!game && <small>输出位置　{output}</small>}
      {status && <p role="status">{status}</p>}
      {source && <div className="style-redraw-previews">
        <figure><figcaption>{game || zoom ? "原图" : "原图 · 拖选文字区域"}</figcaption>
          {zoom ? cropPreview(source,"原图文字区域") : <div className="style-redraw-canvas"><img src={source} alt="重绘原图" draggable={false}
            onLoad={e => setDimensions([e.currentTarget.naturalWidth,e.currentTarget.naturalHeight])} />
          {!game && <svg viewBox={`0 0 ${dimensions[0]} ${dimensions[1]}`} preserveAspectRatio="none" aria-label="拖选重绘范围"
            onPointerDown={e => {
              if (busy || e.button !== 0) return;
              const r = e.currentTarget.getBoundingClientRect();
              drag.current = [Math.floor((e.clientX-r.left)*dimensions[0]/r.width), Math.floor((e.clientY-r.top)*dimensions[1]/r.height)];
              e.currentTarget.setPointerCapture(e.pointerId);
            }} onPointerMove={e => {
              if (!drag.current) return;
              const r = e.currentTarget.getBoundingClientRect();
              const x = Math.max(0,Math.min(dimensions[0],Math.round((e.clientX-r.left)*dimensions[0]/r.width)));
              const y = Math.max(0,Math.min(dimensions[1],Math.round((e.clientY-r.top)*dimensions[1]/r.height)));
              const [a,b] = drag.current;
              setBox([Math.min(a,x),Math.min(b,y),Math.max(a,x),Math.max(b,y)]); setResult("");
            }} onLostPointerCapture={() => { drag.current = null; }}>
            <rect x={box[0]} y={box[1]} width={Math.max(0,box[2]-box[0])} height={Math.max(0,box[3]-box[1])} />
          </svg>}</div>}</figure>
        <figure><figcaption>译图预览</figcaption>{!result ? <p className="style-redraw-hint">尚未生成译图</p> : zoom
          ? cropPreview(choice === "program" && layerView && layer ? layer : result, "译图文字区域")
          : <img src={choice === "program" && layerView && layer ? layer : result} alt="重绘后的文字与透明背景" />}</figure>
      </div>}
      </div>
      {sidebar}
    </div>
  </section>;
}

function RedrawWorkspace({ active, game, onBusy }: { active: boolean; game?: GameInput; onBusy?: (busy: boolean) => void }) {
  const [view, setView] = useState<"native" | "embedded">("native");
  const [visited, setVisited] = useState(false);
  const [target, setTarget] = useState<WebTarget>(() => localStorage.getItem(openPreferenceKey) === "browser" ? "browser" : "embedded");
  const [opening, setOpening] = useState(false);
  const [status, setStatus] = useState("");
  const [menuVisible, setMenuVisible] = useState(false);
  const openMenu = useRef<HTMLDivElement>(null);
  const openMenuId = useId();
  const [surfaceError, setSurfaceError] = useState("");
  const editorHost = useRef<HTMLDivElement>(null);
  const surfaceQueue = useRef<Promise<void>>(Promise.resolve());
  const gameSurface = !!game;
  const starting = useRef(false);
  const syncEditor = (bounds: EditorBounds | null, close = false) => {
    const next = surfaceQueue.current.then(() => invoke<void>("sync_redraw_editor", { game: gameSurface, bounds, close }));
    surfaceQueue.current = next.catch(() => {});
    return next;
  };
  useLayoutEffect(() => {
    const host = editorHost.current;
    if (!active || view !== "embedded" || menuVisible || !host) return;
    let current = true;
    let frame: number | undefined;
    let previous = "";
    const measure = () => {
      frame = undefined;
      const rect = host.getBoundingClientRect();
      const bounds = rect.width > 0 && rect.height > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
      const key = JSON.stringify(bounds);
      if (key === previous) return;
      previous = key;
      void syncEditor(bounds).then(() => {
        if (current) setSurfaceError("");
      }).catch(error => { if (current) setSurfaceError(String(error)); });
    };
    const schedule = () => { if (frame == null) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      current = false;
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (frame != null) cancelAnimationFrame(frame);
      void syncEditor(null).catch(() => {});
    };
  }, [active, view, gameSurface, menuVisible]);
  useEffect(() => {
    if (!visited) return;
    return () => { void syncEditor(null, true).catch(() => {}); };
  }, [visited, gameSurface]);
  useEffect(() => { if (!active) openMenu.current?.hidePopover(); }, [active]);
  const openWeb = async (destination: WebTarget) => {
    if (starting.current) return;
    if (destination === "embedded" && visited) { setView("embedded"); return; }
    starting.current = true;
    setOpening(true);
    try {
      const progress = new Channel<string>();
      setStatus("正在连接 ComfyUI…");
      progress.onmessage = setStatus;
      await invoke("prepare_redraw_ui", { directory: localStorage.getItem(directoryKey) || "", progress });
      if (destination === "browser") await api.openPath(comfyUrl);
      else { setVisited(true); setView("embedded"); }
    } catch (error) { showAppNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { starting.current = false; setOpening(false); setStatus(""); }
  };
  return <div className="style-redraw-workspace">
    <header className="style-redraw-workspace-bar">
      <div className="style-redraw-tabs" role="group" aria-label="重绘工作区">
        <button type="button" aria-pressed={view === "native"} onClick={() => setView("native")}>软件重绘</button>
        <div className="style-redraw-open-split">
          <button type="button" className="style-redraw-open-main" aria-pressed={view === "embedded"}
            disabled={opening} data-tooltip={webTargetLabels[target]} onClick={() => void openWeb(target)}>ComfyUI 编辑器</button>
          <button type="button" className="style-redraw-open-arrow" disabled={opening} aria-label="ComfyUI 打开方式"
            aria-haspopup="menu" aria-expanded={menuVisible} popoverTarget={openMenuId} popoverTargetAction="toggle" onClick={event => {
              const rect = event.currentTarget.getBoundingClientRect();
              const menu = openMenu.current;
              if (menu) Object.assign(menu.style, {
                left: `${Math.max(8, rect.right - 144)}px`,
                top: `${rect.bottom + 4}px`,
              });
            }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
          </button>
          <div ref={openMenu} id={openMenuId} className="style-redraw-open-menu" popover="auto" role="menu"
            aria-label="ComfyUI 打开方式" onToggle={event => setMenuVisible(event.currentTarget.matches(":popover-open"))}>
            {(["embedded", "browser"] as const).map(value =>
              <button key={value} type="button" role="menuitemradio" aria-checked={value === target} onClick={() => {
                setTarget(value);
                localStorage.setItem(openPreferenceKey, value);
                openMenu.current?.hidePopover();
              }}><span aria-hidden="true">{value === target ? "✓" : ""}</span>{webTargetLabels[value]}</button>)}
          </div>
        </div>
      </div>
      {status && <small role="status">{status}</small>}
    </header>
    <div className="style-redraw-workspace-pane" hidden={view !== "native"}>
      {game ? <Editor active={active && view === "native"} game={game} onBusy={onBusy} />
        : <ComfyWorkflowEditor<ComfyQueue> active={active && view === "native"}
          renderQueue={(queue, error) => <RedrawQueue queue={queue} error={error} />} />}
    </div>
    {visited && <div ref={editorHost} className="style-redraw-workspace-pane style-redraw-comfy-pane" hidden={view !== "embedded"}>
      <p role="status" className={surfaceError ? "style-redraw-error" : "style-redraw-hint"}>{surfaceError || "正在加载 ComfyUI 节点编辑器…"}</p>
    </div>}
  </div>;
}

export default function StyleRedraw({ active = true }: { active?: boolean }) { return <RedrawWorkspace active={active} />; }

function RedrawDialog({ game, close }: { game: GameInput; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return createPortal(<dialog ref={dialog} aria-label="重绘当前图" className="style-redraw-dialog"
    onCancel={e => { e.preventDefault(); if (!busy) close(); }}>
    <RedrawWorkspace active game={game} onBusy={setBusy} /><footer><button disabled={busy} onClick={close}>关闭</button></footer>
  </dialog>, document.body);
}

export function GameStyleRedrawButton({ input, disabled }: { input: GameInput; disabled: boolean }) {
  const [snapshot, setSnapshot] = useState<GameInput | null>(null);
  return <><button className="unity-btn unity-image-text-action" disabled={disabled}
    data-tooltip="保存已勾选区域的译文后，可预览中文字层和模型候选" onClick={() => setSnapshot(input)}>重绘当前图</button>
    {snapshot && <RedrawDialog game={snapshot} close={() => setSnapshot(null)} />}</>;
}
