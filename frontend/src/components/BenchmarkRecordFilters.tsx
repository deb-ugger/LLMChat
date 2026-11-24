import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { benchmarkTargetLabel, type BenchmarkTarget as Target } from "../benchmark/benchmarkRunner";
import { imageBenchmarkSteps } from "../gameImageBenchmark";
import { mosaicBenchmarkSteps } from "../gameMosaicBenchmark";
import type { groupBenchmarkTasks } from "../gameTextBenchmark";
import { getLayoutRect, getLayoutViewport } from "../viewportLayout";
import "../unityOffline.css";

const statusChoices = [
  ["failed", "有失败"], ["complete", "全部完成"], ["paused", "已暂停"],
] as const;
export type BenchmarkRecordStatus = typeof statusChoices[number][0];
export const allBenchmarkRecordStatuses: ReadonlySet<BenchmarkRecordStatus> = new Set(statusChoices.map(([id]) => id));

export function matchesBenchmarkRecordStatus(task: ReturnType<typeof groupBenchmarkTasks>[number], statuses: ReadonlySet<BenchmarkRecordStatus>) {
  if (statuses.size === statusChoices.length) return true;
  if (statuses.has("failed") && task.failed) return true;
  if (statuses.has("paused") && task.runs.some(run => run.status === "已暂停")) return true;
  const total = task.planned ? task.rounds * task.configs : task.runs.length;
  return statuses.has("complete") && !task.failed && !task.stopped && task.completed >= total;
}

const stepGroups: Record<"text" | "images" | "mosaic", { label: string; steps: readonly Target[] }> = {
  text: { label: "文本翻译", steps: ["screen", "translate"] },
  images: { label: "图片翻译", steps: Object.keys(imageBenchmarkSteps) as Target[] },
  mosaic: { label: "图片去码", steps: Object.keys(mosaicBenchmarkSteps) as Target[] },
};
type StepGroup = keyof typeof stepGroups;
const groups = Object.keys(stepGroups) as StepGroup[];
export type BenchmarkRecordStep = { module: StepGroup; step?: Target } | undefined;

export function matchesBenchmarkRecordStep(filter: BenchmarkRecordStep, step: Target | undefined) {
  return !filter || (step !== undefined && (filter.step ? filter.step === step : stepGroups[filter.module].steps.includes(step)));
}

function FilterPopup({ label, summary, detail, className, onOpenChange, children }: {
  label: string; summary: string; detail?: string; className: string;
  onOpenChange?: (open: boolean) => void;
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const position = useCallback(() => {
    if (!anchor.current || !popup.current) return;
    const area = getLayoutViewport();
    const button = getLayoutRect(anchor.current.getBoundingClientRect(), area.scale);
    const menu = popup.current;
    const below = area.height - button.bottom - 12;
    const above = button.top - 12;
    const upwards = below < 250 && above > below;
    menu.style.left = Math.max(8, Math.min(button.left, area.width - menu.offsetWidth - 8)) + "px";
    menu.style.top = upwards ? "auto" : button.bottom + 4 + "px";
    menu.style.bottom = upwards ? area.height - button.top + 4 + "px" : "auto";
    menu.style.maxHeight = Math.max(0, upwards ? above : below) + "px";
  }, []);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, position]);
  const close = () => {
    popup.current?.hidePopover();
    anchor.current?.focus();
  };
  return <>
    <button ref={anchor} type="button" className="game-benchmark-filter-trigger" popoverTarget={id}
      aria-label={label + "：" + (detail || summary)} aria-haspopup="dialog" aria-controls={id} aria-expanded={open}
      data-tooltip={detail}>
      <span>{summary}</span>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
        <path d={open ? "m3 10 5-5 5 5" : "m3 5 5 5 5-5"} />
      </svg>
    </button>
    {createPortal(<div ref={popup} id={id} popover="auto" role="dialog" aria-label={label}
      className={"game-benchmark-filter-popup " + className} onToggle={event => {
        const shown = event.currentTarget.matches(":popover-open");
        if (shown) position();
        setOpen(shown);
        onOpenChange?.(shown);
      }}>
      {children(close)}
    </div>, document.body)}
  </>;
}

export function BenchmarkRecordStatusFilter({ value, onChange }: {
  value: ReadonlySet<BenchmarkRecordStatus>; onChange: (next: ReadonlySet<BenchmarkRecordStatus>) => void;
}) {
  const labels = statusChoices.filter(([id]) => value.has(id)).map(([, label]) => label);
  const summary = labels.length === statusChoices.length ? "全部状态"
    : labels.length === 1 ? labels[0] : labels.length ? "已选 " + labels.length + " 项" : "未选状态";
  return <FilterPopup label="筛选记录状态" summary={summary} detail={labels.length === 2 ? labels.join("、") : undefined}
    className="unity-image-filter-menu game-benchmark-status-menu">
    {() => <>
      <div className="unity-image-filter-presets">
        <button type="button" onClick={() => onChange(allBenchmarkRecordStatuses)}>全部选取</button>
        <button type="button" onClick={() => onChange(new Set())}>取消全部选取</button>
      </div>
      {statusChoices.map(([id, label]) => <label key={id}>
        <input type="checkbox" checked={value.has(id)} onChange={event => {
          const next = new Set(value);
          if (event.currentTarget.checked) next.add(id); else next.delete(id);
          onChange(next);
        }} />{label}
      </label>)}
    </>}
  </FilterPopup>;
}

export function BenchmarkRecordStepFilter({ value, onChange }: {
  value: BenchmarkRecordStep; onChange: (next: BenchmarkRecordStep) => void;
}) {
  const [preview, setPreview] = useState<StepGroup>(value?.module ?? "text");
  const hover = useRef<number | undefined>(undefined);
  const stepsId = useId();
  const cancelHover = () => window.clearTimeout(hover.current);
  useEffect(() => () => window.clearTimeout(hover.current), []);
  const activeGroup = stepGroups[preview];
  const summary = value?.step ? benchmarkTargetLabel(value.step) : value ? stepGroups[value.module].label : "全部步骤";
  const detail = value?.step ? stepGroups[value.module].label + " / " + summary : undefined;
  return <FilterPopup label="筛选记录步骤" summary={summary} detail={detail} className="game-benchmark-step-menu"
    onOpenChange={shown => {
      cancelHover();
      if (shown) setPreview(value?.module ?? "text");
    }}>
    {close => {
      const select = (next: BenchmarkRecordStep) => {
        cancelHover();
        onChange(next);
        close();
      };
      return <>
        <div className="game-benchmark-step-level" role="group" aria-label="模块">
          <button type="button" aria-pressed={!value} onClick={() => select(undefined)}>全部步骤</button>
          {groups.map(group => <button type="button" key={group} aria-controls={stepsId}
            aria-expanded={preview === group} onPointerEnter={event => {
              cancelHover();
              if (event.pointerType !== "touch" && group !== preview) {
                hover.current = window.setTimeout(() => setPreview(group), 140);
              }
            }} onPointerLeave={cancelHover} onClick={() => {
              cancelHover();
              setPreview(group);
            }}><span>{stepGroups[group].label}</span><span aria-hidden="true">›</span></button>)}
        </div>
        <div id={stepsId} className="game-benchmark-step-level" role="group" aria-label={activeGroup.label + "步骤"}
          onPointerEnter={cancelHover}>
          <button type="button" aria-pressed={value?.module === preview && !value.step}
            onClick={() => select({ module: preview })}>本模块全部步骤</button>
          {activeGroup.steps.map(step => <button type="button" key={step} aria-pressed={value?.step === step}
            onClick={() => select({ module: preview, step })}>{benchmarkTargetLabel(step)}</button>)}
        </div>
      </>;
    }}
  </FilterPopup>;
}
