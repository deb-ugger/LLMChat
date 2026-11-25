import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { readDatasetCatalog } from "../benchmark/trainingDatasets";

type TrainingEvent = { runId: string; state: string; phase: string; current: number; total: number; message: string; outputDir: string };
type EnvReport = { ready: boolean; messages: string[] };
const classifiers = [
  { name: "部位分类器", hint: "根据蒙版区域识别部位", trainable: true },
  { name: "初筛 ONNX", hint: "筛选有码图片与候选区域 · 只读", trainable: false },
  { name: "复筛模型", hint: "复核候选区域与漏检 · 只读", trainable: false },
];

export function TrainingView() {
  const datasets = readDatasetCatalog().filter(item => item.workId);
  const comfy = localStorage.getItem("llmchat-comfy-directory") ?? "";
  const [classifier, setClassifier] = useState(0);
  const [dataset, setDataset] = useState(datasets[0]?.workId ?? "");
  const [limit, setLimit] = useState(0);
  const [env, setEnv] = useState<EnvReport>();
  const [checkedComfy, setCheckedComfy] = useState("");
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [event, setEvent] = useState<TrainingEvent>();
  const [progress, setProgress] = useState({ phase: "", current: 0, total: 160 });
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState("");
  const tail = useRef<HTMLPreElement>(null);
  const channel = useRef<Channel<TrainingEvent> | undefined>(undefined);
  const running = starting || event?.state === "running";
  const state = event ? ({ running: "训练中", complete: "已完成", failed: "失败", cancelled: "已中断" }[event.state] ?? "待开始") : "待开始";
  useEffect(() => { if (tail.current) tail.current.scrollTop = tail.current.scrollHeight; }, [logs]);

  async function probe() {
    setChecking(true);setError("");setEnv(undefined);
    try {
      setEnv(await invoke<EnvReport>("probe_training_env", { comfyDir: comfy }));
      setCheckedComfy(comfy);
    }
    catch (error) { setError(String(error)); }
    finally { setChecking(false); }
  }

  async function start() {
    setStarting(true);setError("");setLogs([]);setProgress({ phase: "prepare", current: 0, total: 160 });
    const events = new Channel<TrainingEvent>();
    channel.current = events;
    events.onmessage = value => {
      setEvent(value);
      if (value.phase === "fit" || value.phase === "features") setProgress(value);
      setLogs(logs => [...logs.slice(-499), value.message]);
    };
    try { await invoke<string>("start_training", { datasetWorkId: dataset, options: { comfyDir: comfy, limit }, events }); }
    catch (error) { setError(String(error)); }
    finally { setStarting(false); }
  }

  return <div className="training-run-workspace">
    <aside className="training-dataset-library">
      <h3>分类器</h3>
      <ul className="training-dataset-library-list">{classifiers.map((item, index) => <li key={item.name}>
        <button type="button" className="training-dataset-entry" aria-pressed={classifier === index} onClick={() => setClassifier(index)}>
          <strong>{item.name}</strong><span className="hint">{item.hint}</span>
        </button>
      </li>)}</ul>
    </aside>
    <section className="training-run-main">
      <h3>{classifiers[classifier].name}</h3>
      {classifier !== 0 ? <p className="hint">此模型用于{classifier === 1 ? "初筛检测" : "视觉复筛"}，当前仅支持查看用途。</p> : <>
        <fieldset disabled={running || checking} className="training-run-fields">
          <label>数据集<select value={dataset} onChange={e => setDataset(e.target.value)}>
            {!datasets.length && <option value="">请先创建数据集工作副本</option>}
            {datasets.map(item => <option key={item.workId} value={item.workId}>{item.title}</option>)}
          </select></label>
          <label>验证集策略<span>按场景留出约 25%</span></label>
          <label>样本上限<input type="number" min="0" max="100000" value={limit} onChange={e => setLimit(Number(e.target.value))} /></label>
          <p className="hint">0 表示使用全部已确认蒙版。人工确认需包含男、女两类与至少三个场景。</p>
          <label>ComfyUI<span className="training-run-path">{comfy || "请先在设置中指定 ComfyUI 路径"}</span></label>
        </fieldset>
        <div className="training-dataset-actions">
          <button type="button" className="unity-btn" disabled={!comfy || checking || running} onClick={() => void probe()}>{checking ? "正在检查…" : "检查环境"}</button>
          <button type="button" className="unity-btn unity-btn-primary" disabled={!env?.ready || checkedComfy !== comfy || !dataset || running || checking || !Number.isInteger(limit) || limit < 0 || limit > 100000} onClick={() => void start()}>开始训练</button>
          {running && <button type="button" className="unity-btn" disabled={!event?.runId} onClick={() => {
            void invoke("cancel_training", { runId: event?.runId }).catch(error => setError(String(error)));
          }}>中断</button>}
        </div>
        {env && <p role="status" className="hint">{env.ready ? "Python、训练依赖、权重与输出目录检查通过" : env.messages.join("\n")}</p>}
        {error && <p role="alert" className="training-dataset-error">{error}</p>}
        <div className="training-run-progress" role="status">
          <span>{progress.phase === "features" ? "正在提取特征" : state}</span><strong>{progress.phase === "features" ? "" : `${progress.current} / 160`}</strong>
          <progress max={progress.total} value={progress.current} aria-label="训练进度" />
        </div>
        <h3>日志</h3>
        <pre ref={tail} className="training-run-log" aria-label="训练日志">{logs.join("\n") || "等待训练开始"}</pre>
      </>}
    </section>
    <aside className="training-dataset-details"><h3>本次运行</h3><p>{state}</p>
      <p className="hint">产物目录</p><p className="training-run-path">{event?.outputDir || "开始训练后生成"}</p>
      <p className="hint">训练完成后保留模型和验证报告，结果与启用将在下一阶段接入。</p>
    </aside>
  </div>;
}
