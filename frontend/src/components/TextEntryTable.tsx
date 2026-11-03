import { memo } from "react";
import type { TransEntry } from "../textTranslate";
type Props = {
  entry: TransEntry; number: number; selected: boolean; disabled: boolean; independent: boolean;
  onSelect: (id: string, selected: boolean) => void; onEdit: (id: string, value: string) => void;
  onIndependent: (id: string, value: boolean) => void; onContext: (id: string) => void; onCompare: (id: string) => void;
};
const labels: Record<TransEntry["status"], string> = { done: "已译", pending: "未译", skipped: "无需译", error: "失败", running: "进行中" };
export const TextEntryRow = memo(function TextEntryRow({ entry, number, selected, disabled, independent, onSelect, onEdit, onIndependent, onContext, onCompare }: Props) {
  return <div className={`text-entry-row status-${entry.status}`} title={entry.error || entry.warning || undefined}>
    <span className="text-entry-idx"><input type="checkbox" aria-label={`选择条目 ${number}`} checked={selected} disabled={disabled} onChange={event => onSelect(entry.id, event.target.checked)} />{number}</span>
    <span className="text-entry-src">{entry.src || "（空）"}{(entry.error || entry.warning) && <small style={{ display: "block", whiteSpace: "pre-line", color: entry.error ? "var(--danger)" : "var(--text-muted)" }}>{entry.error || entry.warning}</small>}</span>
    <input className="text-entry-dst" value={entry.dst} disabled={disabled || entry.status === "skipped"} onChange={event => onEdit(entry.id, event.target.value)} />
    <span className={`text-entry-status is-${entry.status}`}>
      {entry.warning ? "待校对" : labels[entry.status]}
      <button type="button" onClick={() => onContext(entry.id)}>前后文</button>
      {independent && <label><input type="checkbox" disabled={disabled} checked={!!entry.translateSeparately} onChange={event => onIndependent(entry.id, event.target.checked)} />独立翻译</label>}
      {entry.previousDst !== undefined && <button type="button" onClick={() => onCompare(entry.id)}>对照</button>}
    </span>
  </div>;
});
