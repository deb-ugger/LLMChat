import type { ReactNode } from "react";
import { normalizeMosaicScreening, type MosaicScreening } from "../../gameMosaicScreening";
import { GameFlowNumberChip, GameFlowParameterGroup } from "../GameFlowCard";

export function MosaicScreeningFields({ value, disabled, onChange, groups }: {
  value?: Partial<MosaicScreening>; disabled?: boolean; onChange: (value: MosaicScreening) => void;
  groups?: { scope: ReactNode; concurrency: ReactNode; customDetector: ReactNode; actions: ReactNode };
}) {
  const current = normalizeMosaicScreening(value);
  const threshold = (key: "presenceThreshold" | "boxThreshold", number: number) => {
    if (Number.isFinite(number) && number >= 0.05 && number <= 0.95) onChange({ ...current, [key]: number });
  };
  const models = <>
      <label>分类模型<select disabled={disabled} value={current.localModels?.eva ? "eva" : "builtin"}
        onChange={event => onChange({ ...current, localModels: { ...current.localModels,
          eva: event.target.value === "eva" ? { modelPath: "", labelsPath: "" } : undefined } })}>
        <option value="builtin">MobileNetV3</option><option value="eva">WD EVA02-Large</option>
      </select></label>
      <label>定位模型<select disabled={disabled} value={current.localModels?.mrcnn ? "mrcnn" : "builtin"}
        onChange={event => onChange({ ...current, localModels: { ...current.localModels,
          mrcnn: event.target.value === "mrcnn" ? { modelPath: "" } : undefined } })}>
        <option value="builtin">YOLO11m</option><option value="mrcnn">Censor Mask R-CNN（CPU 耗时较长）</option>
      </select></label>
      {current.localModels?.eva && <>
        <label>EVA02 模型路径<input value={current.localModels.eva.modelPath} disabled={disabled}
          onChange={event => onChange({ ...current, localModels: { ...current.localModels, eva: { ...current.localModels!.eva!, modelPath: event.target.value } } })} /></label>
        <label>EVA02 标签路径<input value={current.localModels.eva.labelsPath} disabled={disabled}
          onChange={event => onChange({ ...current, localModels: { ...current.localModels, eva: { ...current.localModels!.eva!, labelsPath: event.target.value } } })} /></label>
      </>}
      {current.localModels?.mrcnn && <label>Mask R-CNN 模型路径<input value={current.localModels.mrcnn.modelPath} disabled={disabled}
        onChange={event => onChange({ ...current, localModels: { ...current.localModels, mrcnn: { modelPath: event.target.value } } })} /></label>}
  </>;
  const setConcurrency = (modelConcurrency: number) => onChange({ ...current, modelConcurrency });
  const concurrency = <label>ONNX 推理路数<select disabled={disabled} value={current.modelConcurrency ?? 1}
        onChange={event => setConcurrency(Number(event.target.value))}>
        {[1, 2, 4].map(count => <option key={count} value={count}>{count}</option>)}
      </select></label>;
  const thresholds = ([
    ["presenceThreshold", "分类阈值", "较低的分类阈值会保留更多疑似图片，也会增加待复核数量"],
    ["boxThreshold", "定位阈值", "较低的定位阈值会接受更多检测框，也可能增加误报"],
  ] as const).map(([key, label, hint]) => groups
    ? <GameFlowNumberChip key={key} label={label} hint={hint} min={0.05} max={0.95} step={0.01}
      value={current[key]} disabled={disabled} onChange={value => threshold(key, value)} />
    : <label key={key}>{label}<input className="game-mosaic-threshold" type="number" min={0.05} max={0.95} step={0.01}
      value={current[key]} disabled={disabled} title={hint} onChange={event => threshold(key, event.target.valueAsNumber)} /></label>);
  const behavior = <label className="game-mosaic-checkbox"><input type="checkbox" role={groups ? "switch" : undefined} checked={current.localZoom} disabled={disabled}
        onChange={event => onChange({ ...current, localZoom: event.target.checked })} />疑难图片局部放大</label>;
  const help = <small className="hint">每路使用独立工作线程、模型会话和输入画布；多开会增加内存、显存占用。实际路数不超过图片处理并发。</small>;
  if (!groups) return <>{concurrency}{help}{models}{thresholds}{behavior}</>;
  return <>
    <GameFlowParameterGroup kind="models" title="模型">{models}</GameFlowParameterGroup>
    <GameFlowParameterGroup kind="scope" title="范围与方式">{groups.scope}</GameFlowParameterGroup>
    <GameFlowParameterGroup kind="runtime" title="运行">
      <div className="game-flow-chip-row">
        {thresholds}{groups.concurrency}
        <GameFlowNumberChip label="推理路数" ariaLabel="ONNX 推理路数" value={current.modelConcurrency ?? 1}
          choices={[1, 2, 4]} disabled={disabled} onChange={setConcurrency} />
      </div>
      <div className="game-flow-chip-row">{behavior}{groups.customDetector}</div>
      {help}
    </GameFlowParameterGroup>
    <GameFlowParameterGroup kind="actions">{groups.actions}</GameFlowParameterGroup>
  </>;
}
