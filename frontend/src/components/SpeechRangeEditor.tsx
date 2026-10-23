import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { formatSpeechTime, speechRangeProgress, validateSpeechRanges, type SpeechRange } from "../speech/transcription";

function parseTime(text: string) {
  const parts = text.trim().replace(",", ".").split(":");
  if (parts.length > 3 || parts.some(value => !/^\d+(?:\.\d+)?$/.test(value))) throw new Error("时间请填写秒数或 时:分:秒");
  const values = parts.map(Number);
  if (values.some(value => !Number.isFinite(value)) || (values.length > 1 && values.slice(1).some(value => value >= 60))) throw new Error("分钟和秒必须小于 60");
  return Math.round(values.reduce((sum, value) => sum * 60 + value, 0) * 1000) / 1000;
}
type Edge = "start" | "end";
type RangeProps = {
  duration: number; ranges?: SpeechRange[]; disabled: boolean; onChange: (ranges: SpeechRange[] | undefined) => void;
};
export function SpeechRangePicker({ ranges, readOnly, onOpen }: { ranges?: SpeechRange[]; readOnly: boolean; onOpen: () => void }) {
  const summary = ranges === undefined ? "整段音频" : ranges.length ? `已选 ${ranges.length} 段` : "未选片段";
  return <div className="speech-range-option">
    <span className="speech-range-option-label">识别范围</span>{readOnly ? <button type="button" className="speech-range-view" title="查看识别范围" aria-label={`查看识别范围：${summary}`} onClick={onOpen}><span>{summary}</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button> : <div className="speech-range-option-control"><span className="speech-range-option-summary">{summary}</span>
    <button type="button" onClick={onOpen}>选取片段</button></div>}
  </div>;
}
export function SpeechRangePage({ name, duration, ranges, disabled, onChange, onClose }: RangeProps & { name: string; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  const initial = () => ranges?.map(range => ({ ...range })) ?? (disabled ? [{ start: 0, end: duration }] : []);
  const latestDraft = useRef<SpeechRange[]>(initial());
  const titleId = useId();
  const [draft, setDraft] = useState<SpeechRange[]>(initial);
  useEffect(() => {
    if (disabled) { const next = initial(); latestDraft.current = next; setDraft(next); }
  }, [disabled, ranges, duration]);
  const changeDraft = (next: SpeechRange[]) => { latestDraft.current = next; setDraft(next); };
  const finishTyping = () => {
    const focused = document.activeElement as HTMLElement | null;
    if (focused && panel.current?.contains(focused)) focused.blur();
  };
  const close = () => {
    finishTyping();
    const saved = ranges ?? [];
    const changed = !disabled && (latestDraft.current.length !== saved.length || latestDraft.current.some((range, index) => range.start !== saved[index]?.start || range.end !== saved[index]?.end));
    if (changed) confirmation.current?.showModal();
    else onClose();
  };
  const save = () => {
    finishTyping();
    onChange(latestDraft.current.length ? latestDraft.current : undefined);
    confirmation.current?.close(); onClose();
  };
  return <div ref={panel} className="speech-range-page" onKeyDown={event => { if (event.key === "Escape" && !confirmation.current?.open) { event.preventDefault(); close(); } }}>
      <div className="speech-range-page-header"><h3 id={titleId}>{disabled ? "查看识别范围" : "选取音频片段"}{disabled && <span>只读</span>}</h3><span title={name}>{name}</span></div>
      <div className="speech-range-page-body"><SpeechRangeEditor key={String(disabled)} duration={duration} ranges={draft} disabled={disabled} onChange={next => changeDraft(next ?? [])} /></div>
      <div className="speech-range-dialog-footer">{!disabled && <span>未选片段时按整段音频识别。</span>}<div><button type="button" onClick={close}>{disabled ? "关闭" : "取消"}</button>
        {!disabled && <button type="button" className="speech-primary" onClick={save}>保存选段</button>}</div></div>
    <dialog ref={confirmation} className="speech-range-dialog speech-range-confirm" role="alertdialog" aria-labelledby={`${titleId}-unsaved`}>
      <div className="speech-range-dialog-header"><div><h2 id={`${titleId}-unsaved`}>选段尚未保存</h2></div></div>
      <div className="speech-range-dialog-body"><p>已修改的片段尚未保存，是否保存后关闭？</p></div>
      <div className="speech-range-dialog-footer"><div>
        <button type="button" onClick={() => confirmation.current?.close()}>继续编辑</button>
        <button type="button" className="speech-range-discard" onClick={() => { confirmation.current?.close(); onClose(); }}>放弃修改</button>
        <button type="button" className="speech-primary" onClick={save}>保存并关闭</button>
      </div></div>
    </dialog>
  </div>;
}
export function SpeechRangeEditor({ duration, ranges = [], disabled, onChange }: RangeProps) {
  const bar = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const history = useRef<SpeechRange[][]>([]);
  const dragging = useRef<SpeechRange[] | null>(null);
  const latest = useRef(ranges);
  latest.current = ranges;
  const [anchor, setAnchor] = useState<number | null>(null);
  const [active, setActive] = useState<{ index: number; edge: Edge }>({ index: 0, edge: "start" });
  const [hovered, setHovered] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null);
  const [stepText, setStepText] = useState("0.1");
  const [error, setError] = useState("");
  const time = (value: number) => formatSpeechTime(value, ".");
  const step = Number(stepText);
  const apply = (next: SpeechRange[]) => {
    if (disabled) return false;
    try {
      if (next.length) validateSpeechRanges(next, duration);
      if (JSON.stringify(next) === JSON.stringify(latest.current)) return true;
      if (!dragging.current) history.current.push(latest.current.map(range => ({ ...range })));
      latest.current = next;
      onChange(next); setError(""); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
  };
  const changeEdge = (index: number, edge: Edge, value: number) => apply(ranges!.map((range, i) => i === index ? { ...range, [edge]: edge === "end" && Math.abs(value - duration) < 0.001 ? duration : value } : range));
  const point = (clientX: number) => {
    const bounds = bar.current!.getBoundingClientRect();
    return Math.min(duration, Math.round(Math.max(0, Math.min(duration, (clientX - bounds.left) / bounds.width * duration)) * 1000) / 1000);
  };
  const move = (index: number, edge: Edge, value: number) => {
    const range = ranges?.[index]; if (!range) return;
    const low = edge === "start" ? ranges![index - 1]?.end ?? 0 : range.start + 0.001;
    const high = edge === "end" ? ranges![index + 1]?.start ?? duration : range.end - 0.001;
    if (high < low) return;
    changeEdge(index, edge, Math.max(low, Math.min(high, Math.round(value * 1000) / 1000)));
  };
  const nudge = (event: KeyboardEvent, index: number, edge: Edge) => {
    if (disabled || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (!Number.isFinite(step) || step < 0.001) { setError("微调步长至少为 0.001 秒"); return; }
    if (ranges?.[index]) move(index, edge, ranges[index][edge] + (event.key === "ArrowLeft" ? -step : step));
  };
  const drag = (event: PointerEvent<HTMLButtonElement>, index: number, edge: Edge) => {
    if (!disabled && event.currentTarget.hasPointerCapture(event.pointerId)) move(index, edge, point(event.clientX));
  };
  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (dragging.current && JSON.stringify(dragging.current) !== JSON.stringify(latest.current)) history.current.push(dragging.current);
    dragging.current = null;
  };
  const remove = (index: number) => {
    if (apply(latest.current.filter((_, i) => i !== index))) {
      setActive({ index: Math.max(0, Math.min(index, latest.current.length - 1)), edge: "start" }); setHovered(null); setAnchor(null);
    }
    setMenu(null);
  };
  const select = (index: number) => { setActive({ index, edge: "start" }); setHovered(null); setAnchor(null); };
  const context = (event: MouseEvent, index: number) => {
    if (disabled) return;
    event.preventDefault(); event.stopPropagation(); select(index);
    setMenu({ index, x: Math.min(event.clientX, window.innerWidth - 150), y: Math.min(event.clientY, window.innerHeight - 48) });
  };
  const rangeLabel = (index: number) => `片段 ${index + 1}：${time(ranges[index].start)} — ${time(ranges[index].end)}`;
  const highlighted = hovered ?? active.index;
  return <section className="speech-range-editor" aria-label="音频识别范围" onClick={() => setMenu(null)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenu(null); }} onKeyDown={event => {
    if (event.key === "Escape" && menu) { event.preventDefault(); event.stopPropagation(); setMenu(null); return; }
    if (disabled) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation();
      if (event.target instanceof HTMLInputElement) event.target.blur();
      const previous = history.current.pop();
      if (previous) { latest.current = previous; onChange(previous); setError(""); setAnchor(null); setHovered(null); setMenu(null); setActive({ index: 0, edge: "start" }); }
    } else if (event.key === "Delete" && !(event.target instanceof HTMLInputElement) && ranges[active.index]) {
      event.preventDefault(); event.stopPropagation(); remove(active.index);
    }
  }}>
      <div className="speech-range-timeline"><div ref={bar} className={`speech-range-bar${disabled ? " is-readonly" : ""}`} role="group" aria-label="音频选段时间轴" tabIndex={0}
        onKeyDown={event => nudge(event, active.index, active.edge)} onClick={event => {
          if (disabled) return;
          const value = point(event.clientX);
          if (anchor === null) { setAnchor(value); setError(""); return; }
          const next = [...ranges, { start: Math.min(anchor, value), end: Math.max(anchor, value) }].sort((a, b) => a.start - b.start);
          if (apply(next)) setActive({ index: next.findIndex(range => range.start === Math.min(anchor, value)), edge: "end" });
          setAnchor(null);
        }}>
        {ranges.map((range, index) => <div key={index} className={`speech-range-segment${highlighted === index ? " is-active" : ""}`} title={rangeLabel(index)} style={{ left: `${range.start / duration * 100}%`, width: `${(range.end - range.start) / duration * 100}%` }}
          onMouseEnter={() => { setHovered(index); list.current?.children[index]?.scrollIntoView({ block: "nearest" }); }} onMouseLeave={() => setHovered(null)}
          onContextMenu={event => context(event, index)} onClick={event => { event.stopPropagation(); setMenu(null); select(index); bar.current?.focus(); }}>
          {highlighted === index && <svg className="speech-range-indicator" width="16" height="22" viewBox="0 0 16 22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2v16M3 13l5 5 5-5" /></svg>}
          {(["start", "end"] as const).map(edge => <button type="button" role="slider" className={`speech-range-handle is-${edge}`} key={edge} aria-disabled={disabled}
            aria-label={`片段 ${index + 1} ${edge === "start" ? "开始" : "结束"}`} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={range[edge]} aria-valuetext={time(range[edge])}
            onClick={event => event.stopPropagation()} onFocus={() => { setActive({ index, edge }); setHovered(null); }} onKeyDown={event => nudge(event, index, edge)}
            onPointerDown={event => { event.stopPropagation(); setAnchor(null); setActive({ index, edge }); if (!disabled) { dragging.current = ranges.map(range => ({ ...range })); event.currentTarget.setPointerCapture(event.pointerId); } }}
            onPointerMove={event => drag(event, index, edge)} onPointerUp={finishDrag} onPointerCancel={finishDrag} />)}
        </div>)}
        {anchor !== null && <span className="speech-range-anchor" style={{ left: `${anchor / duration * 100}%` }} />}
      </div>
      <div className="speech-range-scale"><span>00:00:00</span><span>{time(duration)}</span></div>
      <div className="speech-range-current" role="status">{ranges[highlighted] ? rangeLabel(highlighted) : "整段音频"}</div>
      </div>
      {!disabled && <p className={`speech-range-hint${error ? " speech-range-error" : ""}`} role={error ? "alert" : undefined}>{error || (anchor === null ? "点击时间轴两次选取起止点；端点可拖动，用 ← → 微调。" : `起点 ${time(anchor)}，再点击选择终点。`)}</p>}
      <div className="speech-range-meta"><span className="speech-range-summary">已选 {ranges.length} 段 · {time(speechRangeProgress(ranges, duration, 0).duration)}</span>
        {!disabled && <label className="speech-range-step">微调步长<input aria-label="微调步长（秒）" type="number" min="0.001" step="0.001" value={stepText} onChange={event => { setStepText(event.target.value); setError(""); }} />秒</label>}</div>
      <div className="speech-range-list" ref={list}>{ranges.map((range, index) => <div className={`speech-range-row${highlighted === index ? " is-active" : ""}`} key={index} tabIndex={0} aria-label={`选择片段 ${index + 1}`} aria-current={active.index === index ? "true" : undefined}
        onClick={() => select(index)} onFocus={() => select(index)} onMouseEnter={() => setHovered(index)} onMouseLeave={() => setHovered(null)} onContextMenu={event => context(event, index)}
        onKeyDown={event => { if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault(); select(index); } }}><span>{index + 1}</span>
        {(["start", "end"] as const).map(edge => <label key={edge}>{edge === "start" ? "开始" : "结束"}<input aria-label={`片段 ${index + 1} ${edge === "start" ? "开始时间" : "结束时间"}`} readOnly={disabled} key={`${edge}-${range[edge]}`} defaultValue={time(range[edge])}
          onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} onBlur={event => {
            try { if (!changeEdge(index, edge, parseTime(event.currentTarget.value))) event.currentTarget.value = time(range[edge]); }
            catch (cause) { setError((cause as Error).message); event.currentTarget.value = time(range[edge]); }
          }} /></label>)}
        {!disabled && <button type="button" aria-label={`删除片段 ${index + 1}`} onClick={event => { event.stopPropagation(); remove(index); }}>×</button>}
      </div>)}</div>
      {menu && !disabled && <div className="speech-range-menu" role="menu" style={{ left: menu.x, top: menu.y }}><button type="button" role="menuitem" autoFocus onClick={() => { remove(menu.index); bar.current?.focus(); }}>删除片段 <span>Delete</span></button></div>}
  </section>;
}
