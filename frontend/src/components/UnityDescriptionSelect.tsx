import { useCallback, useEffect, useId, useRef, useState } from "react";

type Choice = { value: string; label: string; description: string; warning?: string };
export const UNITY_SEGMENT_CHOICES: readonly Choice[] = [
  { value: "smart", label: "智能分段", description: "使用本地 WtP BERT Mini 小模型判断日文、中文等 85 种语言的原文换行：连续语句的排版折行归为同一条，句子边界、空行和列表保留分组。只在原字段内部处理，不跨字段合并。模型已内置，无需 API。", warning: "改变分段方式需要重新扫描；已有译文只复用完全匹配的条目。" },
  { value: "paragraphs", label: "按段落", description: "普通文本以空行分段，将连续非空行提取为一条；结构化资源仍按原字段提取，不使用模型。" },
  { value: "lines", label: "按行", description: "普通文本的每个非空行提取为一条；结构化资源仍按原字段提取，不使用模型。" },
];
export const UNITY_WRAP_CHOICES: readonly Choice[] = [
  { value: "join", label: "合并翻译后恢复换行", description: "保留段落空行和列表边界，只合并段内折行后翻译，再在各段内部重新排版。短译文允许减少行数，不以空白行填充。" },
  { value: "keep", label: "保留换行翻译", description: "按原有换行翻译，保留段内折行和段落空行，不进行翻译后的重新断行。" },
];
export const UNITY_LINE_CHOICES: readonly Choice[] = [
  { value: "local", label: "本地智能", description: "使用系统分词、标点规则和估算字宽选择断点，无需模型资源或额外 API 请求。保留段落和列表边界，段内行数随译文长度调整。" },
  { value: "wtp", label: "本地小模型", description: "内置 WtP BERT Mini，支持日文、中文、英文等 85 种语言，辅助判断句子边界，再结合词语、标点和字宽排版，不改写译文。模型约 28.2 MiB；按需加载，任务结束或中止时释放，无需 Python，不调用 API。", warning: "句子边界不等于游戏文本框换行，仍需检查实际排版。" },
  { value: "ratio", label: "原行比例", description: "参考原文各行长度分配译文，去除为凑行数产生的空白行，不增加模型请求。" },
  { value: "model", label: "大模型辅助", description: "使用所选模型，只从合法候选中选择断点，不得修改文字。模型连接使用通用设置，本机服务需先启动。", warning: "多行文本会增加辅助请求，可能产生 API 费用或占用本机推理资源。" },
];

/** Descriptions are visible only in the open menu; the trigger shows the short label. */
export function UnityDescriptionSelect({ label, value, choices, disabled, onChange }: {
  label: string; value: string; choices: readonly Choice[]; disabled?: boolean; onChange: (value: string) => void;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = choices.find(choice => choice.value === value);
  const position = useCallback(() => {
    const rect = trigger.current!.getBoundingClientRect(), list = menu.current!;
    const width = Math.min(Math.max(rect.width, 440), window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 8, above = rect.top - 8;
    const upwards = below < 300 && above > below;
    Object.assign(list.style, { width: `${width}px`, left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`, top: upwards ? "auto" : `${rect.bottom + 6}px`, bottom: upwards ? `${window.innerHeight - rect.top + 6}px` : "auto", maxHeight: `${Math.max(100, Math.min(560, upwards ? above : below))}px` });
  }, []);
  const close = (focus = false) => { menu.current?.hidePopover(); if (focus) trigger.current?.focus(); };
  const show = () => {
    if (disabled) return;
    position(); menu.current!.showPopover();
    menu.current!.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  };
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open, position]);
  useEffect(() => { if (disabled) menu.current?.hidePopover(); }, [disabled]);
  return <div className="unity-description-select">
    <button ref={trigger} type="button" className="unity-description-trigger" role="combobox" aria-label={label} aria-controls={id} aria-haspopup="listbox" aria-expanded={open} disabled={disabled}
      onClick={() => menu.current!.matches(":popover-open") ? close() : show()}
      onKeyDown={event => { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); show(); } }}>
      <span>{selected?.label || value}</span><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg>
    </button>
    <div ref={menu} id={id} className="unity-description-menu" popover="auto" role="listbox" aria-label={label}
      onToggle={() => setOpen(!!menu.current?.matches(":popover-open"))}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault(); event.stopPropagation();
          (document.activeElement as HTMLButtonElement)?.click();
        }
        else if (event.key === "Tab") close();
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          const options = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="option"]')], index = options.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
          options[next]?.focus();
        }
      }}>
      {choices.map(choice => <button type="button" key={choice.value} role="option" aria-selected={choice.value === value} tabIndex={-1} className="unity-description-option" onClick={() => { onChange(choice.value); close(true); }}>
        <strong>{choice.label}</strong><span>{choice.description}</span>{choice.warning && <b>{choice.warning}</b>}
      </button>)}
    </div>
  </div>;
}
