import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export type GameTextFilters = { checked: boolean; unchecked: boolean; pending: boolean; failed: boolean; done: boolean; quality: boolean; target: boolean };
export const defaultGameTextFilters: GameTextFilters = { checked: true, unchecked: true, pending: true, failed: true, done: true, quality: false, target: false };
export function matchesGameTextFilters(filters: GameTextFilters, selected: boolean, valid: boolean, failed: boolean, quality: boolean, target: boolean) {
  const state = failed ? "failed" : valid ? "done" : "pending";
  return filters[selected ? "checked" : "unchecked"] && filters[state] && (!filters.quality || quality) && (!filters.target || target);
}
export function GameTextFilterMenu({ active, disabled, value, onChange }: { active: boolean; disabled?: boolean; value: GameTextFilters; onChange: (value: GameTextFilters) => void }) {
  const menu = useRef<HTMLDivElement>(null), id = useId();
  useEffect(() => { if (!active || disabled) menu.current?.hidePopover(); }, [active, disabled]);
  return <><button type="button" className="unity-btn unity-text-action" aria-label="筛选文本与译文" data-tooltip="筛选文本与译文" disabled={disabled} popoverTarget={id} popoverTargetAction="toggle" aria-haspopup="dialog" onClick={event => {
    const rect = event.currentTarget.getBoundingClientRect(); Object.assign(menu.current!.style, { left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 248))}px`, top: `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 380))}px` });
  }}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8z" /></svg></button>
    {createPortal(<div ref={menu} id={id} popover="auto" role="dialog" aria-label="文本筛选条件" className="unity-image-filter-menu">
      <div className="unity-image-filter-presets"><button type="button" onClick={() => onChange({ ...defaultGameTextFilters })}>全部选取</button><button type="button" onClick={() => onChange({ ...defaultGameTextFilters, checked: false, unchecked: false, pending: false, failed: false, done: false })}>取消全部选取</button></div>
      {([["checked", "已勾选"], ["unchecked", "未勾选"], ["pending", "未完成"], ["failed", "失败"], ["done", "已完成"], ["quality", "仅看疑似问题"], ["target", "仅看无需翻译"]] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={value[key]} onChange={event => onChange({ ...value, [key]: event.target.checked })} />{label}</label>)}
    </div>, document.body)}</>;
}
