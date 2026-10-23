import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { formatSpeechTime, speechRangeProgress, validateSpeechRanges, type SpeechRange } from "../speech/transcription";

function parseTime(text: string) {
  const parts = text.trim().replace(",", ".").split(":");
  if (parts.length > 3 || parts.some(value => !/^\d+(?:\.\d+)?$/.test(value))) throw new Error("时间请填写秒数或 时:分:秒");
  const values = parts.map(Number);
  if (values.some(value => !Number.isFinite(value)) || (values.length > 1 && values.slice(1).some(value => value >= 60))) throw new Error("分钟和秒必须小于 60");
  return Math.round(values.reduce((sum, value) => sum * 60 + value, 0) * 1000) / 1000;
}
type Edge = "start" | "end";
export function SpeechRangeEditor({ duration, ranges, disabled, onChange }: {
  duration: number; ranges?: SpeechRange[]; disabled: boolean; onChange: (ranges: SpeechRange[] | undefined) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [active, setActive] = useState<{ index: number; edge: Edge }>({ index: 0, edge: "start" });
  const [stepText, setStepText] = useState("0.1");
  const [error, setError] = useState("");
  const time = (value: number) => formatSpeechTime(value, ".");
  const step = Number(stepText);
  const apply = (next: SpeechRange[]) => {
    try {
      if (next.length) validateSpeechRanges(next, duration);
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
  return <section className="speech-range-editor" aria-label="音频识别范围">
    <div className="speech-range-heading"><strong>识别范围</strong>{disabled ? <span>{ranges ? "所选片段" : "整段音频"}</span> : <div>
      <button type="button" aria-pressed={ranges === undefined} onClick={() => { onChange(undefined); setAnchor(null); setError(""); }}>整段</button>
      <button type="button" aria-pressed={ranges !== undefined} onClick={() => { if (!ranges) onChange([]); setAnchor(null); setError(""); }}>选取片段</button>
    </div>}</div>
    {ranges !== undefined && <>
      <div ref={bar} className={`speech-range-bar${disabled ? " is-readonly" : ""}`} role="group" aria-label="音频选段时间轴" tabIndex={disabled ? -1 : 0}
        onKeyDown={event => nudge(event, active.index, active.edge)} onClick={event => {
          if (disabled) return;
          const value = point(event.clientX);
          if (anchor === null) { setAnchor(value); setError(""); return; }
          const next = [...ranges, { start: Math.min(anchor, value), end: Math.max(anchor, value) }].sort((a, b) => a.start - b.start);
          if (apply(next)) setActive({ index: next.findIndex(range => range.start === Math.min(anchor, value)), edge: "end" });
          setAnchor(null);
        }}>
        {ranges.map((range, index) => <div key={index} className={`speech-range-segment${active.index === index ? " is-active" : ""}`} style={{ left: `${range.start / duration * 100}%`, width: `${(range.end - range.start) / duration * 100}%` }} onClick={event => { event.stopPropagation(); setActive({ index, edge: "start" }); }}>
          {(["start", "end"] as const).map(edge => <button type="button" role="slider" className={`speech-range-handle is-${edge}`} key={edge} disabled={disabled}
            aria-label={`片段 ${index + 1} ${edge === "start" ? "开始" : "结束"}`} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={range[edge]} aria-valuetext={time(range[edge])}
            onClick={event => event.stopPropagation()} onFocus={() => setActive({ index, edge })} onKeyDown={event => nudge(event, index, edge)}
            onPointerDown={event => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setActive({ index, edge }); }}
            onPointerMove={event => drag(event, index, edge)} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />)}
        </div>)}
        {anchor !== null && <span className="speech-range-anchor" style={{ left: `${anchor / duration * 100}%` }} />}
      </div>
      <div className="speech-range-scale"><span>00:00:00</span><span>{time(duration)}</span></div>
      {!disabled && <p className={`speech-range-hint${error ? " speech-range-error" : ""}`} role={error ? "alert" : undefined}>{error || (anchor === null ? "点击时间轴两次选取起止点；端点可拖动，用 ← → 微调。" : `起点 ${time(anchor)}，再点击选择终点。`)}</p>}
      <div className="speech-range-meta"><span className="speech-range-summary">已选 {ranges.length} 段 · {time(speechRangeProgress(ranges, duration, 0).duration)}</span>
        {!disabled && <label className="speech-range-step">微调步长<input aria-label="微调步长（秒）" type="number" min="0.001" step="0.001" value={stepText} onChange={event => { setStepText(event.target.value); setError(""); }} />秒</label>}</div>
      <div className="speech-range-list">{ranges.map((range, index) => <div className="speech-range-row" key={index}><span>{index + 1}</span>
        {(["start", "end"] as const).map(edge => <label key={edge}>{edge === "start" ? "开始" : "结束"}<input aria-label={`片段 ${index + 1} ${edge === "start" ? "开始时间" : "结束时间"}`} disabled={disabled} key={`${edge}-${range[edge]}`} defaultValue={time(range[edge])}
          onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} onBlur={event => {
            try { if (!changeEdge(index, edge, parseTime(event.currentTarget.value))) event.currentTarget.value = time(range[edge]); }
            catch (cause) { setError((cause as Error).message); event.currentTarget.value = time(range[edge]); }
          }} /></label>)}
        {!disabled && <button type="button" aria-label={`删除片段 ${index + 1}`} onClick={() => { apply(ranges.filter((_, i) => i !== index)); setActive({ index: 0, edge: "start" }); }}>×</button>}
      </div>)}</div>
    </>}
  </section>;
}
