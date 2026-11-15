import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Option<T extends string> = { value: T; label: string; title?: string; disabled?: boolean };
export const GAME_TEXT_IMPORT_CHOICES = [
  { value: "replace", label: "覆盖已有译文", title: "替换文件中对应条目的译文，空译文也会覆盖；未提供的条目保留" },
  { value: "fill", label: "仅补空白", title: "只填充空白译文，保留已有译文和草稿" },
] as const;

export function GameTextFileMenu<T extends string>({ kind, options, disabled, active = true, onSelect }: {
  kind: "download" | "import"; options: readonly Option<T>[]; disabled?: boolean; active?: boolean; onSelect: (value: T) => void;
}) {
  const id = useId(), menu = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = kind === "download" ? "下载" : "导入";
  useEffect(() => { if (!active || disabled) menu.current?.hidePopover(); }, [active, disabled]);
  const position = () => {
    if (!menu.current || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect(), box = menu.current.getBoundingClientRect();
    const width = box.width || 240, height = box.height || options.length * 40 + 12;
    Object.assign(menu.current.style, { left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`, top: `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - height - 8))}px` });
  };
  return <><button ref={trigger} type="button" className="unity-btn unity-text-action" aria-label={`${label}翻译文件`} data-tooltip={`${label}翻译文件`} aria-haspopup="menu" aria-expanded={open} aria-controls={id} popoverTarget={id} popoverTargetAction="toggle" disabled={disabled} onClick={position}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d={kind === "download" ? "M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" : "M12 17V5m-5 5 5-5 5 5M4 17v4h16v-4"} /></svg>{label}<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m3 4 3 3 3-3" /></svg>
  </button>{createPortal(<div ref={menu} id={id} popover="auto" role="menu" aria-label={`${label}翻译文件选项`} className="unity-image-filter-menu unity-download-menu" onToggle={event => { const shown = event.currentTarget.matches(":popover-open"); setOpen(shown); if (shown) position(); }}>
    {options.map(option => <button key={option.value} type="button" role="menuitem" disabled={option.disabled} data-tooltip={option.title} aria-label={option.title} onClick={() => { menu.current?.hidePopover(); onSelect(option.value); }}>{option.label}</button>)}
  </div>, document.body)}</>;
}
