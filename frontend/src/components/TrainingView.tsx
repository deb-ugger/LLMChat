import { GameDialog, useGameActionConfirm } from "./GameActionConfirm";
import { TrainingPythonSettings, type TrainingStorage } from "./TrainingPythonSettings";
import { useTrainingPython, useTrainingEnvironmentDirectory, readTrainingPython, readTrainingEnvironmentDirectory, saveTrainingPython } from "../trainingPythonSettings";
import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState } from "react";
import { readDatasetCatalog, openTrainingDataset, datasetPartCounts } from "../benchmark/trainingDatasets";
import { TrainingResults } from "./TrainingResults";
import { readableTrainingLog, type TrainingRun } from "../benchmark/trainingResults";

type TrainingEvent = { runId: string; state: string; phase: string; current: number; total: number; message: string; outputDir: string };
type Diagnostic = { message: string; rawOutput: string; logPath: string };
type PythonInfo = { path: string; version: string; torch: string; torchvision: string };
type EnvReport = {
  diagnostic?: Diagnostic; storage?: TrainingStorage;
  ready: boolean; status: "ready" | "needs_install" | "blocked"; messages: string[];
  python: PythonInfo | null; basePython: PythonInfo | null; systemEnvironment: boolean; estimatedBytes: number;
  checks: { name: string; ok: boolean; detail: string }[];
};
const classifiers = [
  { name: "部位分类器", hint: "根据蒙版区域识别部位", trainable: true },
  { name: "初筛 ONNX", hint: "筛选有码图片与候选区域", trainable: false },
  { name: "复筛模型", hint: "复核候选区域与漏检", trainable: false },
];

export function TrainingView({ onOpenDatasets }: { onOpenDatasets: () => void }) {
  const datasets = readDatasetCatalog().filter(item => item.workId);
  const comfy = localStorage.getItem("llmchat-comfy-directory") ?? "";
  const pythonPath = useTrainingPython();
  const environmentDir = useTrainingEnvironmentDirectory();
  const [checkedDirectory, setCheckedDirectory] = useState("");
  const [storageChoice, setStorageChoice] = useState(false);
  const [installDiagnostic, setInstallDiagnostic] = useState<Diagnostic>();
  const confirmation = useGameActionConfirm();

  const [checkedPython, setCheckedPython] = useState("");
  const [installing, setInstalling] = useState(false);
  const [manualPython, setManualPython] = useState(false);
  const installChannel = useRef<Channel<{ state: string; message: string; diagnostic?: Diagnostic }> | undefined>(undefined);
  const [classifier, setClassifier] = useState(0);
  const [dataset, setDataset] = useState(datasets[0]?.workId ?? "");
  const datasetIds = datasets.map(item => item.workId).join("\n");
  useEffect(() => {
    const available = datasetIds.split("\n").filter(Boolean);
    if (!available.includes(dataset)) setDataset(available[0] ?? "");
  }, [datasetIds, dataset]);
  const [limit, setLimit] = useState(0);
  const [env, setEnv] = useState<EnvReport>();
  useEffect(() => { if (env?.storage?.issue && env.status !== "ready") setStorageChoice(true); }, [env]);
  const [showChecks, setShowChecks] = useState(false);
  const checksId = useId();
  const [checkedComfy, setCheckedComfy] = useState("");
  const [checking, setChecking] = useState(false);
  const [slowCheck, setSlowCheck] = useState(false);
  useEffect(() => {
    if (!checking) { setSlowCheck(false); return; }
    const timer = window.setTimeout(() => setSlowCheck(true), 20_000);
    return () => window.clearTimeout(timer);
  }, [checking]);
  const [starting, setStarting] = useState(false);
  const [event, setEvent] = useState<TrainingEvent>();
  const [progress, setProgress] = useState({ phase: "", current: 0, total: 160 });
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { if (error) setShowChecks(true); }, [error]);
  const [expandedLogs, setExpandedLogs] = useState(false);
  const [selectedRun, setSelectedRun] = useState<TrainingRun>();
  const [maskCounts, setMaskCounts] = useState<Record<string, ReturnType<typeof datasetPartCounts> | undefined>>({});
  const [datasetRevision, setDatasetRevision] = useState(0);
  useEffect(() => {
    const changed = () => setDatasetRevision(value => value + 1);
    window.addEventListener("llmchat-training-datasets-changed", changed);
    return () => window.removeEventListener("llmchat-training-datasets-changed", changed);
  }, []);
  const datasetPaths = datasets.map(item => item.path).join("\n");
  useEffect(() => {
    let active = true;
    const paths = datasetPaths.split("\n").filter(Boolean);
    void Promise.all(paths.map(async path => {
      try {
        const reference = datasets.find(item => item.path === path);
        return [path, datasetPartCounts(await openTrainingDataset(path, reference?.workId))] as const;
      } catch { return [path, undefined] as const; }
    })).then(counts => { if (active) setMaskCounts(Object.fromEntries(counts)); });
    return () => { active = false; };
  }, [datasetPaths, datasetRevision]);
  const selectedDataset = datasets.find(item => item.workId === dataset);
  const selectedCounts = selectedDataset ? maskCounts[selectedDataset.path] : undefined;
  const hasBothClasses = !!selectedCounts?.male && !!selectedCounts.female;
  const tail = useRef<HTMLPreElement>(null);
  const channel = useRef<Channel<TrainingEvent> | undefined>(undefined);
  const running = starting || event?.state === "running";
  const state = event ? ({ running: "训练中", complete: "已完成", failed: "失败", cancelled: "已中断" }[event.state] ?? "待开始") : "待开始";
  useEffect(() => { if (tail.current) tail.current.scrollTop = tail.current.scrollHeight; }, [logs]);

  async function probe() {
    setChecking(true);setError("");setEnv(undefined);
    try {
      const selectedPython = readTrainingPython();
      const selectedDirectory = readTrainingEnvironmentDirectory();
      setEnv(await invoke<EnvReport>("probe_training_env", { comfyDir: comfy, pythonPath: selectedPython, environmentDir: selectedDirectory }));
      setCheckedComfy(comfy);setCheckedPython(selectedPython);setCheckedDirectory(selectedDirectory);
    }
    catch (error) { setError(String(error)); }
    finally { setChecking(false); }
  }

  async function prepare(migrate = false) {
    if (migrate) saveTrainingPython(pythonPath, "");
    setInstalling(true);setError("");setLogs([]);setExpandedLogs(true);setInstallDiagnostic(undefined);
    const events = new Channel<{ state: string; message: string; diagnostic?: Diagnostic }>();
    installChannel.current = events;
    events.onmessage = value => {
      setLogs(lines => [...lines.slice(-499), value.message]);
      if (value.diagnostic) setInstallDiagnostic(value.diagnostic);
      if (value.state !== "installing") {
        setInstalling(false);
        void probe().then(() => { if (value.state !== "ready") setError(value.message); });
      }
    };
    try { await invoke("ensure_training_venv", { pythonPath, environmentDir: migrate ? "" : environmentDir, events }); }
    catch (error) { setInstalling(false);setError(String(error)); }
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
    try { await invoke<string>("start_training", { datasetWorkId: dataset, options: { comfyDir: comfy, limit, pythonPath, environmentDir }, events }); }
    catch (error) { setError(String(error)); }
    finally { setStarting(false); }
  }

  const report = selectedRun?.report;
  const storage = env?.storage;
  const softwareEnvironmentReady = env?.ready && storage && storage.directory.replaceAll("\\", "/") === `${storage.softwareDirectory.replaceAll("\\", "/")}/training-venv`;
  const historicalComplete = !event && selectedRun?.state === "complete";
  const statusLine = starting ? "正在启动训练" : event?.state === "cancelled" ? `已中断 · 停在 ${progress.current}/160`
    : running ? progress.phase === "features" ? "训练中 · 提取特征" : `训练中 · ${progress.current}/160`
    : report && (event?.state === "complete" || !event) ? `已完成 · ${report.training_samples} 训练 / ${report.validation_samples} 验证`
    : state;

  return <div className="training-run-workspace">
    <aside className="training-run-config">
      <section className="training-config-group" aria-label="分类器"><h3>分类器</h3>
      <ul className="training-classifiers">{classifiers.map((item, index) => <li key={item.name}>
        <button type="button" aria-pressed={classifier === index} onClick={() => setClassifier(index)}>
          <strong>{item.name}</strong><span className="training-dataset-badge">{item.trainable ? "可训练" : "只读"}</span>
          <span className="hint">{item.hint}</span>
        </button>
      </li>)}</ul></section>
      {classifier !== 0 ? <p className="hint">此模型用于{classifier === 1 ? "初筛检测" : "视觉复筛"}，当前仅支持查看用途。</p> : <>
        <section className="training-config-group" aria-label="数据集配置"><h3>数据集</h3>
        <fieldset disabled={running || checking || installing} className="training-run-fields">
          <label>数据集<select value={dataset} onChange={e => setDataset(e.target.value)}>
            {!datasets.length && <option value="">请先创建数据集工作副本</option>}
            {datasets.map(item => <option key={item.workId} value={item.workId}>
              {item.title} · {item.count} 张 · {maskCounts[item.path] ? String(maskCounts[item.path]?.masks) + " 蒙版" : "读取中或读取失败"}
            </option>)}
          </select></label>
          {selectedCounts && <p className="hint" aria-label="部位标注统计">已标注 {selectedCounts.images} 张 · 男 {selectedCounts.male} / 女 {selectedCounts.female}</p>}
          {!!datasets.length && selectedCounts && !hasBothClasses && <p className="training-dataset-error">至少需要男女两类才能训练</p>}
          {!datasets.length && <div className="training-empty-dataset">
            <p className="hint">训练需要一个已标注的数据集工作副本：在「数据集」里用「从图片集导入」或「复制现有」创建，并至少标注男、女两类。</p>
            <button type="button" className="unity-btn" onClick={onOpenDatasets}>去数据集页创建</button>
          </div>}
          <label>验证集策略<span>按场景留出约 25%</span></label>
          <label>样本上限<input type="number" min="0" max="100000" value={limit} onChange={e => setLimit(Number(e.target.value))} /></label>
          <p className="hint">0 表示全部已确认蒙版，需含男、女两类和至少三个场景。</p>
        </fieldset></section>
        <section className="training-config-group" aria-label="训练环境"><h3>环境</h3>
          <label className="training-config-comfy">ComfyUI<span className="training-run-path">{comfy || "未配置，仅启用模型时需要"}</span></label>
        {env && <div className="training-env-summary"><p role="status" className="training-env-status" data-ready={env.ready}>
          {env.status === "ready" ? `已就绪 · Python ${env.python?.version} · torch ${env.python?.torch}`
            : env.status === "needs_install" ? `需要安装训练依赖（约 ${Math.ceil(env.estimatedBytes / 1_000_000)} MB）`
            : env.python || env.basePython ? "环境检查未通过，请查看明细" : "没有找到可用的 Python（需要 3.10–3.12）"}
        </p><button type="button" className="training-env-toggle" aria-expanded={showChecks} aria-controls={checksId}
          onClick={() => setShowChecks(!showChecks)}>{showChecks ? "收起明细" : "查看明细"}</button></div>}
        {env?.status === "ready" && env.systemEnvironment && <p className="hint">正在使用系统环境，未隔离</p>}
        {env?.status === "needs_install" && <p className="hint">需联网从国内镜像下载。环境解包约 1389 MB，CPU 下载缓存另约 209 MB，跟随所选训练环境目录保存。</p>}
        {env?.status === "blocked" && <p className="hint">请安装 Python 3.10–3.12（含 venv），或指定已有解释器。
          <a href="https://mirrors.aliyun.com/python-release/windows/" target="_blank" rel="noreferrer">国内下载镜像</a></p>}
        {env?.status === "blocked" && <button type="button" className="unity-btn" onClick={() => { setManualPython(true);setShowChecks(true); }}>手动指定路径</button>}
        {env?.storage?.legacyDirectory && <>
          <p className="hint">检测到旧训练环境，约 {(env.storage.legacyBytes / 1e9).toFixed(2)} GB</p>
          <div className="training-dataset-actions">
            <button className="unity-btn" type="button" disabled={installing || running || !!softwareEnvironmentReady} onClick={() => void prepare(true)}>{softwareEnvironmentReady ? "软件目录已就绪" : "迁移到软件目录"}</button>
            <button className="unity-btn" type="button" disabled={installing || running} onClick={() => {
              void confirmation.confirm("删除旧训练环境将释放磁盘空间，之后需要重新准备才能使用。", { title: "删除旧训练环境", okLabel: "删除" }).then(async accepted => {
                if (!accepted) return;
                try { await invoke("remove_legacy_training_environment");void probe(); } catch (error) { setError(String(error)); }
              });
            }}>删除旧环境</button>
          </div>
        </>}
        {error && <p role="alert" className="training-env-status" data-ready="false">操作失败，请查看右侧日志或明细</p>}
        <div className="training-dataset-actions">
          <button type="button" className="unity-btn" data-tooltip="检查训练用的 Python、torch/torchvision、预训练权重和输出目录；不通过时开始训练会被禁用" disabled={checking || running || installing} onClick={() => void probe()}>{checking ? slowCheck ? "仍在检查…" : "正在检查…" : "检查环境"}</button>
          <button type="button" className="unity-btn unity-btn-primary" disabled={!hasBothClasses || !env?.ready || installing || checkedPython !== pythonPath || checkedDirectory !== environmentDir || checkedComfy !== comfy || !dataset || running || checking || !Number.isInteger(limit) || limit < 0 || limit > 100000} onClick={() => void start()}>开始训练</button>
          {env?.status === "needs_install" && !installing && <button type="button" className="unity-btn" data-tooltip="从国内镜像下载 CPU 训练依赖，准备约 1.4 GB 的训练环境；可中断。" disabled={running || checking} onClick={() => void prepare()}>准备训练环境</button>}
          {installing && <button type="button" className="unity-btn" onClick={() => void invoke("cancel_training_environment").catch(error => setError(String(error)))}>中断准备</button>}
          {running && <button type="button" className="unity-btn" disabled={!event?.runId} onClick={() => {
            void invoke("cancel_training", { runId: event?.runId }).catch(error => setError(String(error)));
          }}>中断</button>}
        </div>
        </section>
      </>}
    </aside>
    <div className="training-run-output">
      <section className="training-run-status">
        <div className="training-run-status-head"><strong role="status">{installing ? "正在准备训练环境" : statusLine}</strong>
          <button className="unity-btn" type="button" aria-expanded={expandedLogs} onClick={() => setExpandedLogs(!expandedLogs)}>{expandedLogs ? "收起日志" : "展开日志"}</button>
        </div>
        <progress max={progress.total} value={historicalComplete ? progress.total : progress.current} aria-label="训练进度" />
        <pre ref={tail} className="training-run-log" data-expanded={expandedLogs} aria-label="训练日志">{(expandedLogs ? logs : logs.slice(-3)).map(readableTrainingLog).join("\n") || (historicalComplete ? "训练已完成" : "等待训练开始")}</pre>
        {expandedLogs && <details><summary>原始输出</summary><pre className="training-run-log" data-expanded="true">{logs.join("\n")}</pre></details>}
      </section>
      <section id={checksId} className="training-env-panel" hidden={!showChecks || (!env && !error && !manualPython)} aria-label="环境检查明细">

        {error && <p role="alert" className="training-run-path">{error}</p>}
        {manualPython && <TrainingPythonSettings />}
        {env?.storage && <p className="training-run-path">训练环境目录 {env.storage.directory}</p>}
        {env?.storage?.legacyDirectory && <p className="training-run-path">检测到旧训练环境在 {env.storage.legacyDirectory}（约 {(env.storage.legacyBytes / 1e9).toFixed(2)} GB）。{softwareEnvironmentReady ? "软件目录中的环境已就绪，可确认后删除旧环境释放空间。" : "可通过重建迁移到软件目录，成功前保留原目录。"}</p>}
        {env?.status === "blocked" && <p className="training-run-path">{env.messages.join("\n")}</p>}
        {env && <ul className="training-env-checks">
          {env.checks.map(check => <li key={check.name} data-ok={check.ok}>
            <span>{check.name}</span><b title={check.detail}>{check.ok ? "✓" : "✗"} {check.ok
              ? ["训练 Python", "torch", "torchvision"].includes(check.name) ? check.detail
                : check.name === "预训练权重" ? check.detail.split("，")[0] : check.name === "ComfyUI 路径" ? "可用" : "可写"
              : "未通过"}</b>
            {!check.ok && <small>{check.detail}</small>}
          </li>)}
        </ul>}
      </section>
      {(env?.diagnostic || installDiagnostic) && <details key={(env?.diagnostic || installDiagnostic)?.logPath} className="training-env-panel">
        <summary>查看原始输出</summary>
        <p className="training-run-path">{(env?.diagnostic || installDiagnostic)?.logPath}</p>
        <pre className="training-run-log" data-expanded="true">{(env?.diagnostic || installDiagnostic)?.rawOutput}</pre>
      </details>}
      <TrainingResults datasetId={dataset} finishedRun={event?.state === "complete" ? event.runId : undefined} comfy={comfy}
        runState={running ? "running" : event?.state}
        pythonPath={pythonPath} environmentDir={environmentDir} onRunChange={setSelectedRun} onRetrain={() => document.querySelector<HTMLSelectElement>(".training-run-fields select")?.focus()} />
    </div>
    {storageChoice && <GameDialog className="training-storage-dialog" title="选择训练环境目录" description={env?.storage?.issue || "请选择可写且空间充足的训练环境目录"}
      onCancel={() => setStorageChoice(false)} details={<TrainingPythonSettings />}>
      <button className="game-confirm-cancel" type="button" onClick={() => setStorageChoice(false)}>取消</button>
      <button className="game-confirm-primary" type="button" onClick={() => { setStorageChoice(false);void probe(); }}>返回检查</button>
    </GameDialog>}
    {confirmation.dialog}
  </div>;
}
