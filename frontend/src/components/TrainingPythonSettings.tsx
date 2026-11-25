import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readTrainingPython, readTrainingEnvironmentDirectory, saveTrainingPython } from "../trainingPythonSettings";
import { showAppNotice } from "./AppNotice";

export function TrainingPythonSettings() {
  const [path, setPath] = useState(readTrainingPython);
  const [directory, setDirectory] = useState(readTrainingEnvironmentDirectory);
  const [storage, setStorage] = useState<TrainingStorage>();
  const [error, setError] = useState("");
  async function refresh() {
    try {
      const result = await invoke<TrainingStorage>("training_storage_info", { pythonPath: path, environmentDir: directory });
      setStorage(result);setError("");
    } catch (error) { setError(String(error)); }
  }
  useEffect(() => { void refresh(); }, []);
  return <section className="settings-card game-context-settings training-python-settings">
    <h2>数据集训练</h2>
    <form className="game-context-controls" onSubmit={event => {
      event.preventDefault();saveTrainingPython(path, directory);showAppNotice("训练环境设置已保存", "success");void refresh();
    }}>
      <label>训练用的 Python 路径<input aria-label="训练用的 Python 路径" value={path} placeholder="留空自动探测本机 Python"
        onChange={event => setPath(event.target.value)} /></label>
      <label>训练环境目录<input aria-label="训练环境目录" title={directory || storage?.directory || ""} value={directory || storage?.directory || ""} placeholder="默认使用软件目录下的 training-venv"
        onChange={event => setDirectory(event.target.value)} /></label>
      <div className="training-dataset-actions">
      <button type="button" className="unity-btn" onClick={() => void open({ directory: true, title: "选择训练环境目录" }).then(selected => { if (typeof selected === "string") setDirectory(selected); })}>选择目录</button>
      <button type="button" className="unity-btn" onClick={() => {
        setDirectory("");void invoke<TrainingStorage>("training_storage_info", { pythonPath: path, environmentDir: "" }).then(setStorage).catch(error => setError(String(error)));
      }}>使用软件目录</button>
      <button type="button" className="unity-btn" onClick={() => void refresh()}>刷新磁盘空间</button>
      <button className="settings-panel-save" type="submit">保存训练设置</button>
      </div>
    </form>
    <p className="hint">Python 留空自动查找 3.10–3.12。环境目录默认跟随软件，不可写或空间不足时请手动选择；至少需要约 1.9 GB 空间。</p>
    {storage && <><p className="hint">{storage.reason}</p><ul>{storage.drives.map(drive => <li key={drive.root}>{drive.root} 剩余 {(drive.freeBytes / 1e9).toFixed(2)} GB</li>)}</ul>
      {storage.issue && <p role="alert">{storage.issue}</p>}
      {storage.legacyDirectory && <p className="hint">检测到旧训练环境 {storage.legacyDirectory}，约 {(storage.legacyBytes / 1e9).toFixed(2)} GB；在新目录重建后可删除旧环境。</p>}</>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

export type TrainingStorage = {
  directory: string; cacheDirectory: string; tempDirectory: string; softwareDirectory: string;
  drives: { root: string; freeBytes: number }[]; reason: string; issue: string | null;
  freeBytes: number; requiredBytes: number; legacyDirectory: string | null; legacyBytes: number;
};
