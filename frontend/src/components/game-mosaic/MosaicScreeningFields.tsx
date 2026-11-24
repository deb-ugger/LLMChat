import { normalizeMosaicScreening, type MosaicScreening } from "../../gameMosaicScreening";

export function MosaicScreeningFields({ value, disabled, onChange }: {
  value?: Partial<MosaicScreening>; disabled?: boolean; onChange: (value: MosaicScreening) => void;
}) {
  const current = normalizeMosaicScreening(value);
  const threshold = (key: "presenceThreshold" | "boxThreshold", number: number) => {
    if (Number.isFinite(number) && number >= 0.05 && number <= 0.95) onChange({ ...current, [key]: number });
  };
  return <>
    <label>分类阈值<input type="number" min={0.05} max={0.95} step={0.01} value={current.presenceThreshold} disabled={disabled}
      title="较低的分类阈值会保留更多疑似图片，也会增加待复核数量"
      onChange={event => threshold("presenceThreshold", event.target.valueAsNumber)} /></label>
    <label>定位阈值<input type="number" min={0.05} max={0.95} step={0.01} value={current.boxThreshold} disabled={disabled}
      title="较低的定位阈值会接受更多检测框，也可能增加误报"
      onChange={event => threshold("boxThreshold", event.target.valueAsNumber)} /></label>
    <label className="game-mosaic-checkbox"><input type="checkbox" checked={current.localZoom} disabled={disabled}
      onChange={event => onChange({ ...current, localZoom: event.target.checked })} />疑难图片局部放大</label>
  </>;
}
