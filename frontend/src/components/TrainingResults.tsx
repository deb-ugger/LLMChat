import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { loadAnnotatedSampleSet, type AnnotatedSampleSet } from "../benchmark/imageSampleSet";
import { datasetParts } from "../benchmark/trainingDatasets";
import { parseValidation, percent, trainingMetrics, type ModelStatus, type TrainingResult, type TrainingRun, type ValidationRow } from "../benchmark/trainingResults";

const label = (part: string) => datasetParts[part as keyof typeof datasetParts] ?? part;
const time = (value: number) => new Date(value).toLocaleString();

function ValidationImage({ row, snapshot }: { row: ValidationRow; snapshot: AnnotatedSampleSet }) {
  const [urls, setUrls] = useState<string[]>([]);
  const [error, setError] = useState("");
  const image = snapshot.images.find(image => image.sourceHash === row.sample);
  useEffect(() => {
    const controller = new AbortController();
    const urls: string[] = [];
    setUrls([]);setError("");
    if (!image) { setError("快照索引中未找到图片");return; }
    void snapshot.read(image, controller.signal).then(async blob => {
      const bitmap = await createImageBitmap(blob);
      try {
        const [x, y, right, bottom] = row.box;
        const canvas = new OffscreenCanvas(right - x, bottom - y);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法读取框裁切");
        context.drawImage(bitmap, x, y, right - x, bottom - y, 0, 0, right - x, bottom - y);
        const crop = await canvas.convertToBlob();
        if (controller.signal.aborted) return;
        urls.push(URL.createObjectURL(blob), URL.createObjectURL(crop));setUrls([...urls]);
      } finally { bitmap.close(); }
    }).catch(error => { if (!controller.signal.aborted) setError(String(error)); });
    return () => { controller.abort();urls.forEach(URL.revokeObjectURL); };
  }, [row, image, snapshot]);
  return <div className="training-validation-images">{error && <p role="alert">{error}</p>}
    {urls.map((url, index) => <figure key={url}><img src={url} alt={index ? "框裁切" : "整图"} /><figcaption>{index ? "框裁切" : image?.file}</figcaption></figure>)}
  </div>;
}

export function TrainingResults({ datasetId, finishedRun, comfy, onRetrain, onRunChange }: {
  datasetId: string; finishedRun?: string; comfy: string; onRetrain: () => void; onRunChange?: (run: TrainingRun | undefined) => void;
}) {
  const [runs, setRuns] = useState<TrainingRun[]>([]);
  const [runId, setRunId] = useState("");
  const [result, setResult] = useState<TrainingResult>();
  const [snapshot, setSnapshot] = useState<AnnotatedSampleSet>();
  const [model, setModel] = useState<ModelStatus>();
  const [rows, setRows] = useState<ValidationRow[]>([]);
  const [filter, setFilter] = useState<{ expected?: string; prediction?: string; errors?: boolean }>({});
  const [low, setLow] = useState(false);
  const [selection, setSelection] = useState<ValidationRow>();
  const [part, setPart] = useState("male_external");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const version = useRef(0);

  useEffect(() => {
    let active = true;setRuns([]);setRunId("");setError("");
    if (datasetId) void invoke<TrainingRun[]>("list_training_runs", { datasetWorkId: datasetId }).then(runs => {
      if (active) { setRuns(runs);setRunId(runs.find(run => run.runId === finishedRun)?.runId ?? runs[0]?.runId ?? ""); }
    }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [datasetId, finishedRun]);

  useEffect(() => {
    const current = ++version.current;
    setResult(undefined);setRows([]);setSnapshot(undefined);setSelection(undefined);setFilter({});setMessage("");setError("");
    if (!runId) return;
    void invoke<TrainingResult>("read_training_result", { runId }).then(async value => {
      const rows = parseValidation(value.csv);
      const snapshot = await loadAnnotatedSampleSet(value.snapshotPath, { includeUnannotated: true });
      if (current !== version.current) return;
      setResult(value);setRows(rows);setSnapshot(snapshot);
    }).catch(error => { if (current === version.current) setError(String(error)); });
    return () => { version.current++; };
  }, [runId]);

  useEffect(() => {
    let active = true;setModel(undefined);
    if (comfy) void invoke<ModelStatus>("training_model_status", { comfyDir: comfy }).then(value => { if (active) setModel(value); })
      .catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [comfy, runId]);

  useEffect(() => {
    onRunChange?.(result ? { ...result.meta, report: result.report } : undefined);
  }, [result, onRunChange]);

  const metrics = result && trainingMetrics(rows, result.report);
  const visible = rows.filter(row => (!low || row.confidence < .9) && (!filter.errors || row.expected !== row.prediction) &&
    (!filter.expected || row.expected === filter.expected) && (!filter.prediction || row.prediction === filter.prediction));
  const enabled = !!result && model?.source?.runId === result.meta.runId;

  async function enable() {
    if (!model || !runId) return;
    setBusy(true);setError("");
    try {
      setModel(await invoke<ModelStatus>("enable_training_model", { runId, comfyDir: comfy, expectedActiveHash: model.hash }));
      setMessage("已生效，下次重绘使用新模型");
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }

  async function correct() {
    if (!selection || !result) return;
    setBusy(true);setError("");
    try {
      await invoke("correct_training_label", { runId: result.meta.runId, sample: selection.sample, boxCoordinates: selection.box, label: part, comfyDir: comfy });
      setMessage("已保存，可重新训练");
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }

  return <aside className="training-results">
    {!!runs.length && <><div className="training-result-history"><h3>运行历史</h3>
    {enabled && <span className="training-dataset-badge">已启用</span>}</div>
    <select aria-label="选择历史运行" value={runId} disabled={busy} onChange={event => setRunId(event.target.value)}>
      {runs.map(run => <option key={run.runId} value={run.runId}>{time(run.createdAt)} · {run.report ? `${run.report.training_samples + run.report.validation_samples} 框 · ${percent(run.report.agreement)}` : run.state}
        {model?.source?.runId === run.runId ? " · 已启用" : ""}</option>)}
    </select></>}
    {!runs.length && !error && <p className="training-no-results">还没有训练记录，左侧配置好后点开始训练</p>}
    {error && <p role="alert" className="training-dataset-error">{error}</p>}
    {metrics && result && <>
      <div className="training-result-metrics">{[["验证准确率", metrics.accuracy], ["宏平均 F1", metrics.macroF1],
        ["0.90 阈值覆盖率", metrics.coverage], ["接受后准确率", metrics.acceptedAccuracy]].map(([name, value]) =>
        <div key={String(name)}><span>{name}</span><strong>{percent(value as number | undefined)}</strong></div>)}</div>
      <table><caption>逐类结果</caption><thead><tr><th>类别</th><th>样本</th><th>精确</th><th>召回</th><th>F1</th></tr></thead>
        <tbody>{metrics.classes.map(row => <tr key={row.label}><th>{label(row.label)}</th><td>{row.count}</td><td>{percent(row.precision)}</td><td>{percent(row.recall)}</td><td>{percent(row.f1)}</td></tr>)}</tbody></table>
      <table><caption>混淆矩阵 · 行为真值，列为预测</caption><thead><tr><th>真值 / 预测</th>{metrics.labels.map(item => <th key={item}>{label(item)}</th>)}</tr></thead>
        <tbody>{metrics.matrix.map((row, i) => <tr key={i}><th>{label(metrics.labels[i])}</th>{row.map((count, j) => <td key={j}>
          <button className="unity-btn" type="button" aria-label={`${label(metrics.labels[i])}预测为${label(metrics.labels[j])} ${count} 框`}
            onClick={() => { setFilter({ expected: metrics.labels[i], prediction: metrics.labels[j] });setSelection(undefined); }}>{count}</button>
        </td>)}</tr>)}</tbody></table>
      <div className="training-dataset-actions"><button className="unity-btn" type="button" onClick={() => { setFilter({ errors: true });setSelection(undefined); }}>错图</button>
        <button className="unity-btn" type="button" onClick={() => setFilter({})}>全部</button>
        <label><input type="checkbox" checked={low} onChange={event => setLow(event.target.checked)} />低于阈值</label><span>{visible.length} 框</span></div>
      <select size={Math.min(4, Math.max(2, visible.length))} aria-label="验证框列表" value={selection ? String(rows.indexOf(selection)) : ""}
        onChange={event => { const row = rows[Number(event.target.value)];setSelection(row);setPart(row.expected); }}>
        {visible.map(row => <option value={rows.indexOf(row)} key={rows.indexOf(row)}>{row.scene} · {label(row.expected)} → {label(row.prediction)} · {percent(row.confidence)}</option>)}
      </select>
      {selection && snapshot && <section className="training-validation-detail"><h3>框详情</h3><ValidationImage row={selection} snapshot={snapshot} />
        <p>真值 {label(selection.expected)} · 预测 {label(selection.prediction)} · 置信度 {percent(selection.confidence)}</p><p>场景 {selection.scene}</p>
        <div className="training-dataset-actions"><select aria-label="更正部位" value={part} onChange={event => setPart(event.target.value)}>
          {Object.entries(datasetParts).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>
          <button type="button" className="unity-btn" disabled={busy || !comfy} onClick={() => void correct()}>保存标签</button>
          <button type="button" className="unity-btn" onClick={onRetrain}>返回训练</button></div>
        {message === "已保存，可重新训练" && <p role="status">{message}</p>}
      </section>}
      <section className="training-model-comparison"><h3>启用对照</h3>
        <dl><dt>当前模型</dt><dd>{model ? model.hash ? model.source ? `${model.source.runId} · ${time(model.source.createdAt)} · ${percent(model.source.accuracy)}` : "来源未知" : "尚未启用" : "正在读取…"}</dd>
          <dt>待启用模型</dt><dd>{result.meta.runId} · {time(result.meta.createdAt)} · {percent(result.report.agreement)}</dd></dl>
        {model?.hash && <p className="training-run-path">当前 SHA-256 {model.hash}</p>}
        <button type="button" className="unity-btn unity-btn-primary" disabled={!model || busy || enabled} onClick={() => void enable()}>{enabled ? "已启用" : "启用为线上模型"}</button>
        {enabled && <p role="status">已生效，下次重绘使用新模型</p>}
      </section>
    </>}
  </aside>;
}
