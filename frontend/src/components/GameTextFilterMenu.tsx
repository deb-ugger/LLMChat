import { getLayoutRect, getLayoutViewport } from "../viewportLayout";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export type GameTextFilters = { checked: boolean; unchecked: boolean; pending: boolean; failed: boolean; done: boolean; quality: boolean; target: boolean; supplemental: boolean; limit: string };
export const defaultGameTextFilters: GameTextFilters = { checked: true, unchecked: true, pending: true, failed: true, done: true, quality: false, target: false, supplemental: false, limit: "" };
export function matchesGameTextFilters(filters: GameTextFilters, selected: boolean, valid: boolean, failed: boolean, quality: boolean, target: boolean, supplemental = false) {
  const state = failed ? "failed" : valid ? "done" : "pending";
  return filters[selected ? "checked" : "unchecked"] && filters[state] && (!filters.quality || quality) && (!filters.target || target) && (!filters.supplemental || supplemental);
}
export function limitGameText<T>(entries: T[], limit: string) {
  return limit ? entries.slice(0, Number(limit)) : entries;
}

export function GameTextFilterMenu({ active, disabled, value, matched, shown, onChange, onLimitChange, supplementalAvailable = false }: {
  active: boolean;
  disabled?: boolean;
  value: GameTextFilters;
  matched: number;
  shown: number;
  supplementalAvailable?: boolean;
  onChange: (value: GameTextFilters) => void;
  onLimitChange: (limit: string) => void;
}) {
  const menu = useRef<HTMLDivElement>(null), id = useId();
  useEffect(() => { if (!active || disabled) menu.current?.hidePopover(); }, [active, disabled]);
  return <><button type="button" className="unity-btn unity-text-action" aria-label="筛选文本与译文" data-tooltip="筛选文本与译文" disabled={disabled} popoverTarget={id} popoverTargetAction="toggle" aria-haspopup="dialog" onClick={event => {
    const viewport = getLayoutViewport();
    const rect = getLayoutRect(event.currentTarget.getBoundingClientRect(), viewport.scale);
    Object.assign(menu.current!.style, { left: `${Math.max(8, Math.min(rect.left, viewport.width - 248))}px`, top: `${Math.max(8, Math.min(rect.bottom + 6, viewport.height - 460))}px` });
  }}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8z" /></svg></button>
    {createPortal(<div ref={menu} id={id} popover="auto" role="dialog" aria-label="文本筛选条件" className="unity-image-filter-menu">
      <div className="unity-image-filter-presets"><button type="button" onClick={() => onChange({ ...defaultGameTextFilters, limit: value.limit })}>全部选取</button><button type="button" onClick={() => onChange({ ...defaultGameTextFilters, limit: value.limit, checked: false, unchecked: false, pending: false, failed: false, done: false })}>取消全部选取</button></div>
      {([["checked", "已勾选"], ["unchecked", "未勾选"], ["pending", "未完成"], ["failed", "失败"], ["done", "已完成"]] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={value[key]} onChange={event => onChange({ ...value, [key]: event.target.checked })} />{label}</label>)}
      <div className="game-text-filter-views" role="group" aria-label="仅查看">
        {([["quality", "仅查看疑似问题"], ["target", "仅查看无需翻译"], ["supplemental", "仅查看需补译部分"]] as const)
          .filter(([key]) => key !== "supplemental" || supplementalAvailable)
          .map(([key, label]) => <button key={key} type="button" className="game-text-filter-toggle"
            aria-pressed={value[key]} onClick={() => onChange({
              ...value, quality: false, target: false, supplemental: false, [key]: !value[key],
            })}>{label}</button>)}
      </div>
      <div className="game-text-filter-limit">
        <label htmlFor={id + "-limit"}>最多显示</label>
        <input id={id + "-limit"} type="text" inputMode="numeric" placeholder="不限" value={value.limit}
          onChange={event => {
            const input = event.target.value;
            if (/^\d*$/.test(input)) onLimitChange(input);
          }} />
        <span>条</span>
        <span className="hint" role="status">匹配 {matched} 条，显示 {shown} 条</span>
      </div>
    </div>, document.body)}</>;
}
