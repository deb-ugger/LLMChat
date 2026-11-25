import { useState } from "react";
import { readTrainingPython, saveTrainingPython } from "../trainingPythonSettings";
import { showAppNotice } from "./AppNotice";

export function TrainingPythonSettings() {
  const [path, setPath] = useState(readTrainingPython);
  return <section className="settings-card game-context-settings">
    <h2>数据集训练</h2>
    <form className="game-context-controls" onSubmit={event => {
      event.preventDefault();saveTrainingPython(path);showAppNotice("训练 Python 路径已保存", "success");
    }}>
      <label>训练用的 Python 路径<input aria-label="训练用的 Python 路径" value={path} placeholder="留空自动探测本机 Python"
        onChange={event => setPath(event.target.value)} /></label>
      <button className="settings-panel-save" type="submit">保存训练设置</button>
    </form>
    <p className="hint">可选，留空自动查找 Python 3.10–3.12。指定后只检查该解释器；缺依赖时在用户数据目录创建独立训练环境。</p>
  </section>;
}
