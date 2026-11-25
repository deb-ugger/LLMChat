import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { readDatasetCatalog } from "../benchmark/trainingDatasets";
import { TrainingResults } from "./TrainingResults";
import { readableTrainingLog, type TrainingRun } from "../benchmark/trainingResults";
import { loadAnnotatedSampleSet } from "../benchmark/imageSampleSet";

type TrainingEvent = { runId: string; state: string; phase: string; current: number; total: number; message: string; outputDir: string };
type EnvReport = { ready: boolean; messages: string[] };
const classifiers = [
  { name: "部位分类器", hint: "根据蒙版区域识别部位", trainable: true },
  { name: "初筛 ONNX", hint: "筛选有码图片与候选区域", trainable: false },
  { name: "复筛模型", hint: "复核候选区域与漏检", trainable: false },
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
  const [expandedLogs, setExpandedLogs] = useState(false);
  const [selectedRun, setSelectedRun] = useState<TrainingRun>();
  const [maskCounts, setMaskCounts] = useState<Record<string, number>>({});
  const datasetPaths = datasets.map(item => item.path).join("\n");
  useEffect(() => {
    let active = true;
    const paths = datasetPaths.split("\n").filter(Boolean);
    void Promise.all(paths.map(async path => {
      try {
        const data = await loadAnnotatedSampleSet(path, { includeUnannotated: true });
        return [path, data.images.reduce((count, image) => count + (image.annotation.mosaic?.boxes?.length ?? 0), 0)] as const;
      } catch { return [path, -1] as const; }
    })).then(counts => { if (active) setMaskCounts(Object.fromEntries(counts)); });
    return () => { active = false; };
  }, [datasetPaths]);
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

  const report = selectedRun?.report;
  const historicalComplete = !event && selectedRun?.state === "complete";
  const statusLine = starting ? "正在启动训练" : event?.state === "cancelled" ? `已中断 · 停在 ${progress.current}/160`
    : running ? progress.phase === "features" ? "训练中 · 提取特征" : `训练中 · ${progress.current}/160`
    : report && (event?.state === "complete" || !event) ? `已完成 · ${report.training_samples} 训练 / ${report.validation_samples} 验证`
    : state;

  return <div className="training-run-workspace">
    <aside className="training-run-config">
      <h3>分类器</h3>
      <ul className="training-classifiers">{classifiers.map((item, index) => <li key={item.name}>
        <button type="button" aria-pressed={classifier === index} onClick={() => setClassifier(index)}>
          <strong>{item.name}</strong><span className="training-dataset-badge">{item.trainable ? "可训练" : "只读"}</span>
          <span className="hint">{item.hint}</span>
        </button>
      </li>)}</ul>
      {classifier !== 0 ? <p className="hint">此模型用于{classifier === 1 ? "初筛检测" : "视觉复筛"}，当前仅支持查看用途。</p> : <>
        <fieldset disabled={running || checking} className="training-run-fields">
          <label>数据集<select value={dataset} onChange={e => setDataset(e.target.value)}>
            {!datasets.length && <option value="">请先创建数据集工作副本</option>}
            {datasets.map(item => <option key={item.workId} value={item.workId}>
              {item.title} · {item.count} 张 · {maskCounts[item.path] === undefined ? "读取中" : maskCounts[item.path] < 0 ? "蒙版读取失败" : `${maskCounts[item.path]} 蒙版`}
            </option>)}
          </select></label>
          <label>验证集策略<span>按场景留出约 25%</span></label>
          <label>样本上限<input type="number" min="0" max="100000" value={limit} onChange={e => setLimit(Number(e.target.value))} /></label>
          <p className="hint">0 表示全部已确认蒙版，需含男、女两类和至少三个场景。</p>
          <label>ComfyUI<span className="training-run-path">{comfy || "请先在设置中指定 ComfyUI 路径"}</span></label>
        </fieldset>
        {env && <p role="status" className="training-env-status" data-ready={env.ready}>
          {env.ready ? "环境检查通过" : env.messages.join("；")}
        </p>}
        {error && <p role="alert" className="training-env-status" data-ready="false">{error}</p>}
        <div className="training-dataset-actions">
          <button type="button" className="unity-btn" disabled={!comfy || checking || running} onClick={() => void probe()}>{checking ? "正在检查…" : "检查环境"}</button>
          <button type="button" className="unity-btn unity-btn-primary" disabled={!env?.ready || checkedComfy !== comfy || !dataset || running || checking || !Number.isInteger(limit) || limit < 0 || limit > 100000} onClick={() => void start()}>开始训练</button>
          {running && <button type="button" className="unity-btn" disabled={!event?.runId} onClick={() => {
            void invoke("cancel_training", { runId: event?.runId }).catch(error => setError(String(error)));
          }}>中断</button>}
        </div>
      </>}
    </aside>
    <div className="training-run-output">
      <section className="training-run-status">
        <div className="training-run-status-head"><strong role="status">{statusLine}</strong>
          <button className="unity-btn" type="button" aria-expanded={expandedLogs} onClick={() => setExpandedLogs(!expandedLogs)}>{expandedLogs ? "收起日志" : "展开日志"}</button>
        </div>
        <progress max={progress.total} value={historicalComplete ? progress.total : progress.current} aria-label="训练进度" />
        <pre ref={tail} className="training-run-log" data-expanded={expandedLogs} aria-label="训练日志">{(expandedLogs ? logs : logs.slice(-3)).map(readableTrainingLog).join("\n") || (historicalComplete ? "训练已完成" : "等待训练开始")}</pre>
        {expandedLogs && <details><summary>原始输出</summary><pre className="training-run-log" data-expanded="true">{logs.join("\n")}</pre></details>}
      </section>
      <TrainingResults datasetId={dataset} finishedRun={event?.state === "complete" ? event.runId : undefined} comfy={comfy}
        onRunChange={setSelectedRun} onRetrain={() => document.querySelector<HTMLSelectElement>(".training-run-fields select")?.focus()} />
    </div>
  </div>;
}
