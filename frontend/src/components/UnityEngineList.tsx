import { useState } from "react";
import { classicEngines, engineReady, engineRequiresKey, getEngineInfo, type EngineKeysMap } from "../translateEngines";
import type { UnityEngineChoice } from "../unityEnginePool";

export function UnityEngineList({ choices, keys, disabled, expanded, onExpandedChange, onChange }: { choices: UnityEngineChoice[]; keys: EngineKeysMap; disabled: boolean; expanded: boolean; onExpandedChange: (value: boolean) => void; onChange: (value: UnityEngineChoice[]) => void }) {
  const [adding, setAdding] = useState("");
  const available = classicEngines().filter(engine => !choices.some(row => row.id === engine.id));
  const ordered = [...choices].sort((a, b) => Number(engineRequiresKey(getEngineInfo(a.id)!)) - Number(engineRequiresKey(getEngineInfo(b.id)!)));
  return <details className="unity-engine-pool" open={expanded} onToggle={event => onExpandedChange(event.currentTarget.open)}>
    <summary>并行翻译引擎 <span>已启用 {choices.filter(row => row.enabled).length} 个 · 可用 {choices.filter(row => row.enabled && engineReady(keys, row.id)).length} 个</span></summary>
    <fieldset disabled={disabled} aria-label="并行翻译引擎配置">
    {ordered.map(row => {
      const engine = getEngineInfo(row.id)!;
      return <div className="unity-engine-row" key={row.id}>
        <label><input type="checkbox" checked={row.enabled} onChange={event => onChange(choices.map(item => item.id === row.id ? { ...item, enabled: event.target.checked } : item))} />{engine.label}</label>
        <span className={engineReady(keys, row.id) ? "hint" : "unity-offline-error"}>{!row.enabled ? "已禁用" : !engineReady(keys, row.id) ? "未配置，不参与调度" : engineRequiresKey(engine) ? "后备 · 可能计费" : "优先"}</span>
        <button type="button" className="unity-btn" aria-label={`删除${engine.label}`} onClick={() => onChange(choices.filter(item => item.id !== row.id))}>删除</button>
      </div>;
    })}
    <div className="unity-engine-add">
      <select aria-label="添加并行翻译引擎" value={adding} onChange={event => setAdding(event.target.value)}><option value="">选择引擎</option>{available.map(engine => <option key={engine.id} value={engine.id}>{engine.label}{engineRequiresKey(engine) ? " · 后备，可能计费" : ""}</option>)}</select>
      <button type="button" className="unity-btn" disabled={!available.some(engine => engine.id === adding)} onClick={() => { const engine = available.find(item => item.id === adding); if (engine) onChange([...choices, { id: engine.id, enabled: true }]); setAdding(""); }}>添加</button>
    </div>
    <p className="hint">每个引擎最多同时处理一个任务；免 Key 引擎并行，该条目在免 Key 引擎均失败后才使用手动加入的后备引擎。凭证在通用设置中配置。</p>
    </fieldset>
  </details>;
}
