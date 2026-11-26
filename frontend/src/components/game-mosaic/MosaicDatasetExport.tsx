import { useEffect, useRef, useState } from "react";
import { exportMosaicDataset, prepareMosaicDatasetExport, rememberDataset, writeTrainingDatasetFile,
  type MosaicDatasetInput, type MosaicDatasetReport, type MosaicDatasetTarget } from "../../benchmark/trainingDatasets";
import type { UnityImage } from "../../unityOffline";
import { GameDialog } from "../GameActionConfirm";
import { showAppNotice } from "../AppNotice";

export function MosaicDatasetExport({ total, disabled, snapshot, read }: {
  total: number; disabled: boolean; snapshot: () => MosaicDatasetInput[];
  read: (image: UnityImage, signal: AbortSignal) => Promise<Blob>;
}) {
  const [pending, setPending] = useState<{ target: MosaicDatasetTarget; inputs: MosaicDatasetInput[] }>();
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; directory: string }>();
  const [report, setReport] = useState<MosaicDatasetReport>();
  const [showReport, setShowReport] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const task = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; task.current?.abort(); }; }, []);

  async function prepare() {
    if (task.current || disabled || !total) return;
    const controller = new AbortController();
    task.current = controller;
    setPreparing(true);
    try {
      const inputs = snapshot();
      const target = await prepareMosaicDatasetExport();
      if (!controller.signal.aborted) setPending({ target, inputs });
    } catch (error) {
      if (mounted.current) showAppNotice(`无法准备数据集导出：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      task.current = null;
      if (mounted.current) setPreparing(false);
    }
  }

  async function start() {
    if (!pending || task.current) return;
    const { target, inputs } = pending;
    const controller = new AbortController();
    task.current = controller;
    setPending(undefined);
    setCancelling(false);
    setProgress({ current: 0, total: inputs.length, directory: target.directory });
    try {
      const result = await exportMosaicDataset(target, inputs, read, writeTrainingDatasetFile, controller.signal,
        (current, count) => { if (mounted.current) setProgress({ current, total: count, directory: target.directory }); });
      rememberDataset(result.dataset.reference);
      if (mounted.current) {
        setReport(result.report);
        showAppNotice(`${result.report.cancelled ? "已取消，保留已导出内容" : "数据集导出完成"}：${result.report.unique} 张原图，失败 ${result.report.failures.length} 张。可查看导出结果。`, result.report.failures.length ? "error" : "success");
      }
    } catch (error) {
      if (mounted.current) showAppNotice(`数据集导出未完成：${error instanceof Error ? error.message : String(error)}；输出位置：${target.directory}`, "error");
    } finally {
      task.current = null;
      if (mounted.current) { setProgress(undefined); setCancelling(false); }
    }
  }

  function downloadReport() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + "\n"], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = "数据集导出结果.json"; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="unity-image-actions">
    <button type="button" className="unity-btn" disabled={disabled || !total || preparing || !!pending || !!progress}
      onClick={() => void prepare()}>{preparing ? "正在准备导出…" : "导出全量数据集"}</button>
    {report && <button type="button" className="unity-btn" onClick={() => setShowReport(true)}>查看导出结果</button>}
    {pending && <GameDialog title="导出全量数据集"
      description={`范围：当前工程全部 ${pending.inputs.length.toLocaleString("zh-CN")} 张图片，不受筛选和分页影响。规则：勾选且有蒙版＝有码，其余＝无码。包含当前未保存的勾选与蒙版。`}
      details={<p style={{ overflowWrap: "anywhere" }}>输出位置：{pending.target.directory}</p>}
      onCancel={() => setPending(undefined)}>
      <button type="button" className="game-confirm-cancel" onClick={() => setPending(undefined)}>取消</button>
      <button type="button" className="game-confirm-primary" onClick={() => void start()}>开始导出</button>
    </GameDialog>}
    {progress && <GameDialog title="正在导出数据集" dismissible={false}
      description={`已处理 ${progress.current.toLocaleString("zh-CN")} / ${progress.total.toLocaleString("zh-CN")} 张${cancelling ? "，正在取消…" : ""}`}
      details={<><progress aria-label="数据集导出进度" value={progress.current} max={progress.total || 1} style={{ width: "100%" }} />
        <p style={{ overflowWrap: "anywhere" }}>{progress.directory}</p><p>取消后保留已完成的图片与标注。</p></>}>
      <button type="button" className="game-confirm-cancel" disabled={cancelling} onClick={() => { setCancelling(true); task.current?.abort(); }}>取消导出</button>
    </GameDialog>}
    {showReport && report && <GameDialog title="数据集导出结果" onCancel={() => setShowReport(false)}
      description={`${report.cancelled ? "已取消" : "已完成"} · 已处理 ${report.processed} / ${report.total} 张`}
      details={<div style={{ maxHeight: "45vh", overflow: "auto", overflowWrap: "anywhere" }}>
        <p>范围 {report.total} 张 · 有码 {report.present} 张 / 无码 {report.none} 张</p>
        <p>写入 {report.unique} 个唯一 PNG · 同内容合并 {report.merged} 条记录</p>
        <p>有码框 {report.boxes} 个 · 带部位 {report.boxesWithPart} 个</p>
        <p>输出位置：{report.directory}</p>
        <p>解密或写入失败 {report.failures.length} 张</p>
        {report.failures.map((failure, index) => <p key={index}>{failure.path}：{failure.error}</p>)}
        {report.duplicates.slice(0, 3).map(group => <p key={group.sha256}>同内容：{group.paths.join(" | ")}</p>)}
      </div>}>
      <button type="button" className="unity-btn" onClick={downloadReport}>下载结果清单</button>
      <button type="button" className="game-confirm-primary" onClick={() => setShowReport(false)}>关闭</button>
    </GameDialog>}
  </div>;
}
