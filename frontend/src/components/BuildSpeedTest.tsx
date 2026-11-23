import { useState } from "react";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

type Measurement = { variant: "embedded" | "external"; phase: "full" | "incremental"; seconds: number };
const resultKey = "llmchat-build-speed-test";
const labels: Record<string, string> = {
  waiting: "等待构建锁…",
  prepare: "正在准备隔离目录…",
  "embedded full": "正在全量构建内嵌版…",
  "external full": "正在全量构建外置版…",
  "embedded incremental": "正在增量构建内嵌版…",
  "external incremental": "正在增量构建外置版…",
  cleanup: "正在清理测试文件…",
};

export function BuildSpeedTest() {
  const [result, setResult] = useState<Measurement[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(resultKey) || "[]");
      return Array.isArray(saved) ? saved : [];
    } catch { return []; }
  });
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const canRun = isTauri();
  async function start() {
    if (progress) return;
    setError("");
    setProgress(labels.waiting);
    const channel = new Channel<string>();
    channel.onmessage = phase => setProgress(labels[phase] ?? phase);
    try {
      const measurements = await invoke<Measurement[]>("run_build_speed_test", { progress: channel });
      setResult(measurements);
      localStorage.setItem(resultKey, JSON.stringify(measurements));
    } catch (cause) { setError(String(cause)); }
    finally { setProgress(""); }
  }

  const seconds = (variant: Measurement["variant"], phase: Measurement["phase"]) => {
    const value = result.find(item => item.variant === variant && item.phase === phase);
    return value ? value.seconds.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + " 秒" : "—";
  };
  return <main className="game-workflow-help app-help-view" aria-label="构建测速">
    <header className="game-workflow-help-header">
      <h1>构建测速</h1>
      <button type="button" className="unity-btn unity-btn-primary" disabled={!canRun || !!progress}
        onClick={() => void start()}>开始测速</button>
    </header>
    <div className="game-workflow-help-content">
      <p className="game-workflow-help-summary">比较 ORT WASM 内嵌和外置的桌面 Release 构建。全量使用空编译目录，增量复用该次依赖产物。测试结束后清理临时文件。</p>
      {!canRun && <p className="hint">请在桌面版中运行构建测速。</p>}
      {progress && <p role="status">{progress}</p>}
      {error && <pre role="alert" className="hint">{error}</pre>}
      {!!result.length && <table aria-label="最近一次构建测速结果">
        <thead><tr><th scope="col">构建阶段</th><th scope="col">WASM 内嵌</th><th scope="col">WASM 外置</th></tr></thead>
        <tbody>
          <tr><th scope="row">全量 Release</th><td>{seconds("embedded", "full")}</td><td>{seconds("external", "full")}</td></tr>
          <tr><th scope="row">增量 Release</th><td>{seconds("embedded", "incremental")}</td><td>{seconds("external", "incremental")}</td></tr>
        </tbody>
      </table>}
    </div>
  </main>;
}
