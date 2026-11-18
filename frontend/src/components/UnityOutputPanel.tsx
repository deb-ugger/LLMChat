import { useId, useRef, useState, type ReactNode } from "react";
import { useFollowLatest } from "../hooks/useFollowLatest";

export function UnityOutputPanel({ resources, results, errorCount }: {
  resources: ReactNode; results: ReactNode; errorCount: number;
}) {
  const [selected, setSelected] = useState(0), id = useId();
  const resourceScroll = useFollowLatest<HTMLDivElement>(selected === 0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  return <section className="unity-offline-footer" aria-label="资源信息和批量结果">
    <div className="unity-output-tabs" role="tablist" aria-label="工程信息" onKeyDown={event => {
      const next = event.key === "ArrowRight" || event.key === "ArrowLeft" ? 1 - selected : event.key === "Home" ? 0 : event.key === "End" ? 1 : null;
      if (next === null) return;
      event.preventDefault(); setSelected(next); tabs.current[next]?.focus();
    }}>
      {["资源信息", "批量结果"].map((label, index) => <button ref={element => { tabs.current[index] = element; }} type="button" role="tab" key={label} id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`} aria-selected={selected === index} tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)}>{label}{index === 1 && errorCount > 0 && <span className="game-batch-error-count" aria-label={errorCount + " 条错误"}>{errorCount}</span>}</button>)}
    </div>
    <div ref={resourceScroll} id={`${id}-panel-0`} role="tabpanel" aria-labelledby={`${id}-tab-0`} tabIndex={0} hidden={selected !== 0} className="unity-offline-log">{resources}</div>
    <div id={`${id}-panel-1`} role="tabpanel" aria-labelledby={`${id}-tab-1`} tabIndex={0} hidden={selected !== 1} className="unity-offline-log">{results}</div>
  </section>;
}
