import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { OutputDirectoryField } from "./OutputDirectoryField";
import { getOutputDirectory, saveOutputFile } from "../outputFiles";
import { showAppNotice } from "./AppNotice";
import "../styleRedraw.css";

type Box = [number, number, number, number];
type Region = { box: Box; translation: string };
type GameInput = {
  name: string; regions: Region[]; load: () => Promise<Blob>;
  apply: (file: File) => Promise<unknown>; failure: (message: string) => Promise<void>;
};
type ProfileId = "2511" | "turbo" | "custom";
type Profile = { model: string; clip: string; vae: string; graph?: string; output?: string };
const profilesKey = "llmchat-redraw-profiles";
const defaults: Record<ProfileId, Profile> = {
  "2511": { model:"qwen-image-edit-2511-Q4_K_M.gguf", clip:"qwen_2.5_vl_7b_fp8_scaled.safetensors", vae:"qwen_image_vae.safetensors" },
  turbo: { model:"qwen_image_2.1_turbo_int8_convrot.safetensors", clip:"qwen3vl_8b_int8_convrot.safetensors", vae:"qwen_image_2.1_vae_bf16.safetensors" },
  custom: { model:"", clip:"", vae:"", graph:"", output:"" },
};
const labels: Record<ProfileId,string> = {"2511":"Qwen Image Edit 2511", turbo:"Qwen Image 2.1 Turbo · INT8 ConvRot", custom:"自定义 API 工作流"};
function savedProfiles(): typeof defaults {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(profilesKey) || "{}") }; } catch { return defaults; }
}
const directoryKey = "llmchat-comfy-directory";

function readImage(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

function Editor({ game, onBusy }: { game?: GameInput; onBusy?: (busy: boolean) => void }) {
  const [directory, setDirectory] = useState(() => localStorage.getItem(directoryKey) || "");
  const [settings, setSettings] = useState(!directory);
  const [output, setOutput] = useState("");
  const [source, setSource] = useState("");
  const [name, setName] = useState(game?.name || "");
  const [box, setBox] = useState<Box>([0, 0, 0, 0]);
  const [translation, setTranslation] = useState("");
  const [steps, setSteps] = useState(20);
  const [program, setProgram] = useState("");
  const [layer, setLayer] = useState("");
  const [layerView, setLayerView] = useState(false);
  const [candidates, setCandidates] = useState<Record<string, string>>({});
  const [measurements, setMeasurements] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState("program");
  const result = choice === "program" ? program : candidates[choice] || "";
  const setResult = (value: string) => { setProgram(value); setLayer(""); setLayerView(false); setCandidates({}); setChoice("program"); };
  const [profiles,setProfiles] = useState(savedProfiles);
  const [profileId,setProfileId] = useState<ProfileId>("2511");
  const profile = profiles[profileId];
  const [missing, setMissing] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    if (directory) void invoke<string[]>("missing_redraw_weights", { directory, model:profile.model, clip:profile.clip, vae:profile.vae }).then(files => { if (current) setMissing(files); }).catch(reportWeightError);
    function reportWeightError(error: unknown) { if (current) showAppNotice(String(error),"error"); }
    return () => { current = false; };
  }, [directory,profile]);
  const selectProfile = (id: ProfileId) => { setProfileId(id); setSteps(id === "turbo" ? 8 : 20); };
  const selectControl = <select aria-label="模型工作流" value={profileId} onChange={e => selectProfile(e.target.value as ProfileId)}>
    {(Object.keys(labels) as ProfileId[]).map(id => <option key={id} value={id}>{labels[id]}</option>)}</select>;
  const changeProfile = (patch: Partial<Profile>) => {
    const next = { ...profiles, [profileId]: { ...profile, ...patch } };
    setProfiles(next); localStorage.setItem(profilesKey,JSON.stringify(next));
    setCandidates(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== profileId))); setChoice("program");
  };
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const alive = useRef(true);
  const selection = useRef(0);
  const drag = useRef<[number, number] | null>(null);
  const processing = useRef(false);
  const [dimensions, setDimensions] = useState([0, 0]);
  const regionList: Region[] = game?.regions ?? [{ box, translation }];
  const report = (e: unknown) => showAppNotice(e instanceof Error ? e.message : String(e), "error");
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!game || settings) return;
    let current = true;
    game.load().then(readImage).then(value => { if (current) setSource(value); })
      .catch(error => { if (current) report(error); });
    return () => { current = false; };
  }, [game, settings]);
  useEffect(() => {
    if (!game && !settings) void getOutputDirectory("redraw").then(setOutput).catch(report);
  }, [settings, game]);

  const choose = async () => {
    const path = await open({ directory: true, multiple: false, title: "选择 ComfyUI 便携版目录" });
    if (typeof path === "string") { localStorage.setItem(directoryKey, path); setDirectory(path); }
  };
  const select = async (file: File) => {
    const token = ++selection.current;
    setResult(""); setSource(""); setStatus("");
    const image = await createImageBitmap(file);
    try {
      const url = await readImage(file);
      if (selection.current !== token || !alive.current) return;
      setName(file.name); setSource(url); setDimensions([image.width, image.height]); setBox([0, 0, image.width, image.height]);
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
        if (mode === "program") { setProgram(url); setChoice("program"); }
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
  return <section className="style-redraw">
    <header><h2>AI 风格重绘</h2><button disabled={busy} onClick={() => setSettings(!settings)}>{settings ? "返回重绘" : "模块设置"}</button></header>
    {settings ? <div className="style-redraw-settings">
      <label>ComfyUI 便携版目录<input readOnly value={directory} placeholder="选择含 ComfyUI 和 python_embeded 的目录" /></label>
      <button onClick={() => void choose().catch(report)}>选择目录</button>
      <label>模型工作流{selectControl}</label>
      {([["model","扩散模型"],["clip","文本编码器"],["vae","VAE"]] as const).map(([field,title]) =>
        <label key={field}>{title}<input value={profile[field]} onChange={e => changeProfile({[field]:e.target.value})} /></label>)}
      {profileId === "custom" && <>
        <label>导入 ComfyUI API 格式 JSON<input type="file" accept=".json" onChange={e => {
          const file = e.target.files?.[0]; if (!file) return;
          void file.text().then(text => {
            const graph = JSON.parse(text);
            if (!Object.keys(graph).length || !Object.values(graph).every(n => n && typeof n === "object" && "class_type" in n)) throw Error("请从 ComfyUI 导出 API 格式工作流");
            changeProfile({graph:text});
          }).catch(report);
        }} /></label>
        <p>将图像节点的 image 值设为 <code>{"{{draft}}"}</code>（中文底稿）和 <code>{"{{original}}"}</code>（原花字）。提示词用 <code>{"{{prompt}}"}</code> 或 <code>{"{{translation}}"}</code>；可选参数为 <code>{"{{steps}}, {{model}}, {{clip}}, {{vae}}"}</code>。</p>
        <label>输出节点 ID<input placeholder="仅有一个图像输出时可留空" value={profile.output || ""} onChange={e => changeProfile({output:e.target.value})} /></label>
        <small>{profile.graph ? "工作流已导入" : "尚未导入工作流"}</small>
      </>}
      {!game && <OutputDirectoryField module="redraw" label="独立重绘输出目录" />}
    </div> : <>
      <fieldset disabled={busy}>
        {!game && <label>原图<input type="file" accept="image/*" onChange={e => { const file = e.target.files?.[0]; if (file) void select(file).catch(report); }} /></label>}
        {!game && source && <div className="style-redraw-box">{["左", "上", "右", "下"].map((label, i) =>
          <label key={label}>{label}<input type="number" value={box[i]} min={0} max={dimensions[i % 2]} onChange={e => {
            const next: Box = [...box]; next[i] = e.target.valueAsNumber || 0; setBox(next); setResult("");
          }} /></label>)}</div>}
        {game ? <details><summary>已勾选 {regionList.length} 个区域</summary><ol>{regionList.map((r, i) => <li key={i}>{r.translation}</li>)}</ol></details> :
          <label>目标译文<textarea rows={2} value={translation} onChange={e => { setTranslation(e.target.value); setResult(""); }} /></label>}
        <div className="style-redraw-tools"><label>模型工作流{selectControl}</label><label>采样步数<input type="number" min={1} max={100} disabled={profileId === "turbo"} value={steps || ""} onChange={e => { setSteps(e.target.valueAsNumber || 0); }} /></label>
          <button disabled={!source || !valid || !directory} onClick={() => void run("program").catch(report)}>生成中文字层</button>
          <button disabled={!program || !directory || steps < 1 || steps > 100 || !Number.isInteger(steps) || (profileId === "custom" && !profile.graph)} onClick={() => void run("model").catch(report)}>生成模型候选</button>
          {program && <label>采用版本<select value={choice} onChange={e => setChoice(e.target.value)}>
            <option value="program">程序中文字层</option>{Object.keys(candidates).map(key => <option key={key} value={key}>{labels[key as ProfileId]} · {measurements[key]}</option>)}
          </select></label>}
          {result && <button onClick={() => void save().catch(report)}>{game ? "采用译图" : "保存 PNG"}</button>}
        </div>
      </fieldset>
      {game && !valid && <small>请先确认每个勾选区域的坐标和译文。</small>}
      {missing.length > 0 && <small>模型目录内未找到　{missing.join("、")}</small>}
      {program && choice === "program" && <label><span><input type="checkbox" checked={layerView} onChange={e => setLayerView(e.target.checked)} />仅预览透明字层</span></label>}
      {!game && <small>输出位置　{output}</small>}
      {status && <p role="status">{status}</p>}
      {source && <div className="style-redraw-previews">
        <figure><figcaption>{game ? "原图" : "原图 · 拖选文字区域"}</figcaption>
          <div className="style-redraw-canvas"><img src={source} alt="重绘原图" draggable={false} />
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
          </svg>}</div></figure>
        {result && <figure><figcaption>译图预览</figcaption><img src={choice === "program" && layerView && layer ? layer : result} alt="重绘后的文字与透明背景" /></figure>}
      </div>}
    </>}
  </section>;
}

export default function StyleRedraw() { return <Editor />; }

function RedrawDialog({ game, close }: { game: GameInput; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return createPortal(<dialog ref={dialog} aria-label="重绘当前图" className="style-redraw-dialog"
    onCancel={e => { e.preventDefault(); if (!busy) close(); }}>
    <Editor game={game} onBusy={setBusy} /><footer><button disabled={busy} onClick={close}>关闭</button></footer>
  </dialog>, document.body);
}

export function GameStyleRedrawButton({ input, disabled }: { input: GameInput; disabled: boolean }) {
  const [snapshot, setSnapshot] = useState<GameInput | null>(null);
  return <><button className="unity-btn unity-image-text-action" disabled={disabled}
    data-tooltip="保存已勾选区域的译文后，可预览中文字层和模型候选" onClick={() => setSnapshot(input)}>重绘当前图</button>
    {snapshot && <RedrawDialog game={snapshot} close={() => setSnapshot(null)} />}</>;
}
