import { createContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BenchmarkState } from "../benchmark/benchmarkRunner";
import type { BenchmarkParameter } from "../benchmark/benchmarkParameters";
import { deriveFlowMetrics } from "../gameFlowMetrics";
import { gameDuration, type StepPerformance } from "../gameModelPerformance";
import { GameProgressBar } from "./GameStepProgress";
import { showAppNotice } from "./AppNotice";

type FoldModelLane = { model: string; rate?: string };

function shortModelName(model: string) {
  return model.split("/").at(-1) ?? model;
}

function meterGenerationTokS(meter: { generationTokens?: number; generationMs?: number; tokens?: number; requestMs?: number }) {
  const rate = deriveFlowMetrics({
    tokens: meter.generationTokens ?? meter.tokens,
    generationTokens: meter.generationTokens,
    generationMs: meter.generationMs,
    requestMs: meter.requestMs,
  }).find(metric => metric.key === "generationRate");
  return rate && rate.value !== "0" ? rate.value : undefined;
}

function foldModelLanes(measurement: StepPerformance | undefined, fallbackModels?: readonly string[]): FoldModelLane[] {
  const meters = Object.values(measurement?.models ?? {});
  const names = meters.length
    ? [...new Set(meters.map(item => item.model))]
    : [...new Set((fallbackModels ?? []).filter(Boolean))];
  return names.map(model => {
    const meter = measurement?.models[model] ?? meters.find(item => item.model === model);
    return { model, rate: meter ? meterGenerationTokS(meter) : undefined };
  });
}

function sampleModelHead(sample?: string) {
  const head = sample?.split(" · ")[0]?.trim();
  return head || undefined;
}

function modelMatchesSample(sampleHead: string | undefined, model: string) {
  if (!sampleHead) return false;
  const short = shortModelName(model);
  return sampleHead === model || sampleHead === short || model.endsWith(sampleHead);
}

export type GameFlowProgress = {
  sample?: string;
  current?: number;
  total?: number;
  completed?: number;
  unit?: string;
  configuration?: { current: number; total: number };
  successRate?: number;
  count?: string;
  percent?: number | null;
  remainingMs?: number;
  details?: ReactNode;
};

export type GameFlowActivity = {
  state: string;
  label?: ReactNode;
  elapsed?: ReactNode;
  actions?: ReactNode;
  progress?: GameFlowProgress;
  details?: ReactNode;
  statusLine?: string;
};

const expandedStorageKey = "llmchat.flow.expanded";
const expandedChangeEvent = "llmchat:flow-expanded";
type ExpandedSteps = Record<string, boolean>;

function readExpandedSteps(): ExpandedSteps {
  try {
    const value = JSON.parse(window.localStorage.getItem(expandedStorageKey) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value) &&
      Object.values(value).every(item => typeof item === "boolean")) return value;
  } catch { /* Fall back to the current workflow step. */ }
  return {};
}

export function useGameFlowExpansion() {
  const [overrides, setOverrides] = useState(readExpandedSteps);
  useEffect(() => {
    const sync = (event: Event) => setOverrides((event as CustomEvent<ExpandedSteps>).detail);
    const storage = (event: StorageEvent) => {
      if (event.key === expandedStorageKey || event.key === null) setOverrides(readExpandedSteps());
    };
    window.addEventListener(expandedChangeEvent, sync);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(expandedChangeEvent, sync);
      window.removeEventListener("storage", storage);
    };
  }, []);
  return {
    isExpanded: (id: string, fallback: boolean) => Object.hasOwn(overrides, id) ? overrides[id] : fallback,
    setExpanded: (id: string, expanded: boolean) => {
      const next = { ...overrides, ...readExpandedSteps(), [id]: expanded };
      setOverrides(next);
      try { window.localStorage.setItem(expandedStorageKey, JSON.stringify(next)); }
      catch { /* Keep the choice in the current window. */ }
      window.dispatchEvent(new CustomEvent(expandedChangeEvent, { detail: next }));
    },
  };
}

type ParameterControl = HTMLInputElement | HTMLSelectElement | HTMLButtonElement;
type ParameterWidth = "narrow" | "mid" | "wide";
const parameterControls = [
  "input:not([type=checkbox], [type=radio], [type=file], [type=hidden])",
  "select:not([hidden], .game-model-concurrency-control)",
  ".unity-description-trigger",
].join(", ");
const parameterField = ".game-mosaic-model-field, .game-model-column, .unity-language-setting, label";

function parameterWidthClass(control: ParameterControl, field: HTMLElement): ParameterWidth {
  if (control instanceof HTMLInputElement) return control.type === "number" ? "narrow" : "wide";
  if (control instanceof HTMLSelectElement && control.options.length &&
    [...control.options].every(option => /^\d+$/.test(option.value))) return "narrow";
  return control.dataset.paramWidth === "mid" || !field.closest('[data-parameter-group="models"]') ? "mid" : "wide";
}

function measureParameterText(text: string, style: CSSStyleDeclaration, measure: CanvasRenderingContext2D) {
  measure.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(" ");
  return measure.measureText(text).width;
}

function parameterValueWidth(control: ParameterControl, measure: CanvasRenderingContext2D) {
  const caption = control.parentElement?.querySelector<HTMLElement>(":scope > .searchable-select-caption");
  const text = control instanceof HTMLSelectElement ? control.selectedOptions[0]?.label
    : control instanceof HTMLInputElement ? control.value || control.placeholder
    : control.firstElementChild?.textContent;
  if (!text) return 0;
  const style = getComputedStyle(control);
  const textStyle = caption ? getComputedStyle(caption) : style;
  const textWidth = measureParameterText(text, textStyle, measure);
  if (caption) {
    return Math.ceil(textWidth + parseFloat(textStyle.insetInlineStart) + parseFloat(textStyle.insetInlineEnd));
  }
  const insets = [style.paddingInlineStart, style.paddingInlineEnd, style.borderInlineStartWidth, style.borderInlineEndWidth]
    .reduce((sum, size) => sum + (parseFloat(size) || 0), 0);
  const icon = control instanceof HTMLButtonElement ? (control.querySelector("svg")?.clientWidth ?? 0)
    : control instanceof HTMLSelectElement ? 16 : 0;
  const gap = icon ? parseFloat(style.columnGap) || 0 : 0;
  return Math.ceil(textWidth + insets + icon + gap);
}

function parameterLabelWidth(field: HTMLElement, measure: CanvasRenderingContext2D) {
  const label = field.querySelector<HTMLElement>(":scope > span, .game-model-head > span, .unity-language-heading > span");
  const text = (label?.textContent ?? Array.from(field.childNodes)
    .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("")).trim().replace(/\s+/g, " ");
  const style = getComputedStyle(label ?? field);
  return measureParameterText(text, style, measure);
}

function useParameterFieldWidths(configured: boolean) {
  const fields = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = fields.current;
    if (!configured || !root) return;
    const measure = document.createElement("canvas").getContext("2d");
    if (!measure) return;
    let frame = 0;
    const layout = () => {
      const style = getComputedStyle(root);
      const columns = style.gridTemplateColumns.split(" ").map(parseFloat);
      const columnWidth = columns.length === 2 ? Math.min(...columns) : Infinity;
      const fullWidth = root.clientWidth;
      const preferred = {
        narrow: parseFloat(style.getPropertyValue("--game-flow-narrow-width")),
        mid: parseFloat(style.getPropertyValue("--game-flow-mid-width")),
        wide: parseFloat(style.getPropertyValue("--game-flow-control-min")),
      };
      const numberInputWidth = parseFloat(style.getPropertyValue("--game-flow-number-input-width"));
      const minLabel = parseFloat(style.getPropertyValue("--game-flow-label-width"));
      const gap = parseFloat(style.getPropertyValue("--game-flow-field-gap"));
      const visibleFields = new Set<HTMLElement>();
      const widths = new Map<HTMLElement, { tier: ParameterWidth; control: number; required: number }>();
      for (const control of root.querySelectorAll<ParameterControl>(parameterControls)) {
        if (!control.offsetWidth || control.closest("[popover]")) continue;
        const field = control.closest<HTMLElement>(parameterField);
        if (!field || !root.contains(field) || getComputedStyle(field).display !== "grid") continue;
        visibleFields.add(field);
        if (control.getAttribute("aria-expanded") === "true" && field.dataset.paramWidth) continue;

        const region = control.closest<HTMLElement>(".model-filter-select") ?? control;
        const concurrency = field.querySelector<HTMLElement>(".game-model-concurrency-control");
        const tools = Math.max(0, region.offsetWidth - control.offsetWidth) + (concurrency ? concurrency.offsetWidth + gap : 0);
        const measured = parameterValueWidth(control, measure);
        const preferredTier = parameterWidthClass(control, field);
        const targetWidth = control instanceof HTMLInputElement && control.type === "number" ? numberInputWidth : preferred[preferredTier];
        const tier = preferredTier !== "wide" && measured > targetWidth ? "wide" : preferredTier;
        const label = Math.ceil(Math.max(tier === "narrow" ? 0 : minLabel, parameterLabelWidth(field, measure)));
        const controlWidth = Math.max(tier === preferredTier ? targetWidth : preferred.wide, measured) + tools;
        widths.set(field, { tier, control: controlWidth, required: label + gap + controlWidth });
      }
      for (const field of root.querySelectorAll<HTMLElement>(".game-flow-param-field")) {
        if (visibleFields.has(field)) continue;
        field.classList.remove("game-flow-param-field", "game-flow-param-wide", "game-flow-param-stacked");
        delete field.dataset.paramWidth;
        field.style.removeProperty("--game-flow-field-control-width");
        field.style.removeProperty("--game-flow-field-width");
      }
      for (const [field, width] of widths) {
        field.classList.add("game-flow-param-field");
        field.classList.toggle("game-flow-param-wide", width.required > columnWidth);
        field.classList.toggle("game-flow-param-stacked", width.required > fullWidth);
        field.dataset.paramWidth = width.tier;
        field.style.setProperty("--game-flow-field-control-width", width.control + "px");
        field.style.setProperty("--game-flow-field-width", width.required + "px");
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(layout);
    };
    const resize = new ResizeObserver(schedule);
    const changes = new MutationObserver(schedule);
    resize.observe(root);
    changes.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["value", "placeholder", "aria-expanded"] });
    root.addEventListener("input", schedule);
    root.addEventListener("change", schedule);
    document.fonts.addEventListener("loadingdone", schedule);
    layout();
    return () => {
      resize.disconnect();
      changes.disconnect();
      root.removeEventListener("input", schedule);
      root.removeEventListener("change", schedule);
      document.fonts.removeEventListener("loadingdone", schedule);
      cancelAnimationFrame(frame);
    };
  }, [configured]);
  return fields;
}

export const GameFlowGroupedParameters = createContext(false);

export function GameFlowParameterGroup({ kind, title, children }: {
  kind: "models" | "scope" | "runtime" | "generation" | "behavior" | "actions" | "help";
  title?: string;
  children: ReactNode;
}) {
  const heading = useId();
  return <div className="game-flow-param-section" data-parameter-group={kind}
    role={title ? "group" : undefined} aria-labelledby={title ? heading : undefined}>
    {title ? <><h6 id={heading}>{title}</h6><div className="game-flow-group-fields">{children}</div></> : children}
  </div>;
}

export function GameFlowParameterValue({ label, value }: { label: string; value: ReactNode }) {
  return <span className="game-flow-chip">{label}<span className="game-flow-chip-value">{value}</span></span>;
}

export function GameFlowNumberChip({ label, value, onChange, disabled, choices, min, max, step = 1, hint, ariaLabel = label }: {
  label: string; value: number; onChange: (value: number) => void; disabled?: boolean;
  choices?: readonly number[]; min?: number; max?: number; step?: number; hint?: string; ariaLabel?: string;
}) {
  const list = useId();
  const [editing, setEditing] = useState(false);
  const editor = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const showEditor = editing && !disabled;
  useLayoutEffect(() => {
    if (showEditor) {
      editor.current?.focus();
      editor.current?.select();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      button.current?.focus();
    }
  }, [showEditor]);
  const allowed = choices ? "可选值 " + choices.join("、") : undefined;
  return <span className="game-flow-chip" data-tooltip={[hint, allowed].filter(Boolean).join("。") || undefined}>
    {label}
    {showEditor ? <>
      <input ref={editor} type="number" className="game-flow-chip-value" aria-label={ariaLabel}
        defaultValue={value} min={min} max={max} step={step} list={choices ? list : undefined}
        onBlur={event => {
          setEditing(false);
          const input = event.currentTarget;
          const next = input.valueAsNumber;
          if (input.matches(":disabled") || next === value || !input.value && !input.validity.badInput) return;
          if (input.validity.valid && (!choices || choices.includes(next))) onChange(next);
          else showAppNotice(ariaLabel + (allowed ? "的" + allowed : "超出可用范围"), "error");
        }}
        onKeyDown={event => {
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          returnFocus.current = true;
          if (event.key === "Escape") event.currentTarget.value = String(value);
          event.currentTarget.blur();
        }} />
      {choices && <datalist id={list}>{choices.map(choice => <option key={choice} value={choice} />)}</datalist>}
    </> : <button type="button" ref={button} className="game-flow-chip-value" aria-label={ariaLabel + " " + value}
      disabled={disabled} onClick={() => setEditing(true)}>{value}</button>}
  </span>;
}

type CardProps = GameFlowActivity & {
  title: string;
  current?: boolean;
  groupedParameters?: boolean;
  headerSummary?: ReactNode;
  benchmark?: BenchmarkState;
  performance?: ReactNode;
  onConfigure?: () => void;
  body?: ReactNode;
  resultLine?: string;
  configuration?: ReactNode;
  configurationActions?: ReactNode;
  runningParameters?: readonly BenchmarkParameter[];
  information?: readonly { label: string; value: ReactNode }[];
  foldedSummary?: { completed?: number; failed?: number; models?: readonly string[]; concurrency?: number };
  parametersLocked?: boolean;
  saveConfiguration?: { run: () => void; cancel: () => void; disabled: boolean; saving?: boolean };
  disclosure?: { expanded: boolean; toggle: () => void };
  stepMeasurement?: StepPerformance;
};

export function StandaloneGameFlowCard({ stepId, ...props }: Omit<CardProps, "disclosure"> & { stepId: string }) {
  const expansion = useGameFlowExpansion();
  const expanded = expansion.isExpanded(stepId, true);
  return <GameFlowCard {...props} disclosure={{ expanded, toggle: () => expansion.setExpanded(stepId, !expanded) }} />;
}

export function GameFlowCard({ title, state, current, benchmark, label, elapsed, progress, details, statusLine, performance,
  actions, onConfigure, body, resultLine, configuration, configurationActions, runningParameters, information, foldedSummary,
  parametersLocked, saveConfiguration, disclosure, groupedParameters = false, headerSummary, stepMeasurement }: CardProps) {
  const detailsId = useId();
  const settingsId = useId();
  const statusId = useId();
  const expanded = disclosure?.expanded ?? true;
  const benchmarkActive = benchmark?.state === "running";
  const active = state === "running" || benchmarkActive;
  const locked = active || parametersLocked;
  const configured = expanded && !!configuration;
  const parameterFields = useParameterFieldWidths(configured && !groupedParameters);
  const readOnlyParameters = !active && !configuration ? benchmark?.parameters ?? runningParameters : undefined;
  const infoRows = [...(information ?? []), ...(readOnlyParameters ?? [])];
  const position = benchmark && benchmark.round != null && benchmark.rounds != null &&
    benchmark.configIndex != null && benchmark.configCount != null
    ? `第 ${benchmark.round}/${benchmark.rounds} 轮 · 配置 ${benchmark.configIndex}/${benchmark.configCount}` : undefined;
  const configCurrent = benchmark?.sampleCurrent;
  const configTotal = benchmark?.sampleTotal;
  const configElapsed = benchmark?.configElapsedMs;
  const configCounts = configCurrent != null && configTotal != null;
  const failures = benchmark?.performance?.failures;
  const successful = configCurrent != null && failures != null ? Math.max(0, configCurrent - failures) : undefined;
  const activeProgress: GameFlowProgress | undefined = benchmark ? {
    sample: benchmark.sample,
    current: configCounts ? configCurrent : undefined,
    total: configCounts ? configTotal : undefined,
    completed: successful,
    percent: configCounts && configTotal > 0 ? 100 * configCurrent / configTotal : undefined,
    configuration: benchmark.configIndex != null && benchmark.configCount != null
      ? { current: benchmark.configIndex, total: benchmark.configCount } : undefined,
    successRate: successful != null && configTotal != null && configTotal > 0 ? 100 * successful / configTotal : undefined,
    remainingMs: configCurrent != null && configCurrent > 0 && configTotal != null && configElapsed != null && configElapsed > 0
      ? configElapsed / configCurrent * Math.max(0, configTotal - configCurrent) : undefined,
    details: progress?.details,
  } : state === "running" ? progress ?? {} : undefined;
  const progressCurrent = activeProgress?.current;
  const progressTotal = activeProgress?.total;
  const hasCounts = progressCurrent != null && progressTotal != null;
  const progressPercent = activeProgress?.percent ?? (hasCounts && progressTotal > 0
    ? 100 * progressCurrent / progressTotal : undefined);
  const percent = progressPercent == null ? undefined : Math.min(100, Math.max(0, progressPercent));
  const summaryProgress = activeProgress ?? progress;
  const elapsedLabel = benchmark ? gameDuration(configElapsed ?? benchmark.elapsedMs) : elapsed;
  const completed = summaryProgress?.completed ?? (benchmark ? undefined : foldedSummary?.completed) ?? summaryProgress?.current;
  const unit = progress?.unit ?? "项";
  const progressSample = activeProgress ? activeProgress.sample ?? statusLine : undefined;
  const cardStateLine = active ? statusLine || (benchmarkActive ? benchmark.detail : undefined)
    : state === "done" ? resultLine : undefined;
  const stateLineInProgress = activeProgress != null && progressSample != null && cardStateLine === progressSample;
  const progressConfig = activeProgress?.configuration;
  const progressPosition = position ?? (progressConfig && "配置 " + progressConfig.current + "/" + progressConfig.total);
  const remainingMs = activeProgress?.remainingMs;
  const remaining = remainingMs == null ? undefined
    : remainingMs < 3600000 ? gameDuration(remainingMs).slice(3) : gameDuration(remainingMs);
  const recordedModels = Object.values(benchmark?.performance?.models ?? {});
  const modelValues = benchmark ? (recordedModels.length ? recordedModels.map(model => model.model)
    : benchmark.parameters?.filter(p => p.label.endsWith("模型")).map(p => p.value)) : foldedSummary?.models;
  const modelNames = [...new Set(modelValues?.filter(value => value && value !== "—").map(value => value.split("/").at(-1)))];
  const concurrency = benchmark ? Math.max(0, ...recordedModels.map(model => model.concurrency),
    ...(benchmark.parameters ?? []).filter(p => p.label.endsWith("并发")).map(p => Number.parseInt(p.value, 10) || 0))
    : foldedSummary?.concurrency;
  const failed = benchmark ? benchmark.performance?.failures : foldedSummary?.failed;
  const total = summaryProgress?.total;
  const summaryCount = completed != null ? completed.toLocaleString() + (total != null
    ? " / " + total.toLocaleString() : "") + " " + unit : undefined;
  const modelsText = modelNames.join(" → ");
  const summaryRows = [
    { key: "count", text: summaryCount },
    { key: "failure", text: failed != null && failed > 0 ? "失败 " + failed.toLocaleString() + " " + unit : undefined },
    { key: "models", text: modelsText },
    { key: "concurrency", text: concurrency != null && concurrency > 1 ? "并发 " + concurrency : undefined },
    { key: "round", text: active ? position : undefined },
  ].filter(row => row.text);
  const status = benchmark ? benchmark.state === "paused" ? "测试已暂停" : "测试中" : label;
  const elapsedText = groupedParameters ? elapsedLabel ?? "—" : elapsedLabel;
  const showHeaderTiming = groupedParameters && active && elapsedText != null;
  const elapsedDisplay = elapsedText != null && !showHeaderTiming && <span className="game-flow-elapsed">
    {(groupedParameters || expanded || active) && "已用 "}{elapsedText}</span>;
  const headerTiming = showHeaderTiming && <span className="game-flow-timing" title="已用与预计剩余">
    已用 <b>{elapsedText}</b>
    {remaining && <><span className="game-flow-timing-sep" aria-hidden="true">·</span>剩 <b>{remaining}</b></>}
  </span>;
  const actionDisplay = actions && <div className="game-flow-actions">{actions}</div>;
  const showFoldedCompact = groupedParameters && !expanded && !!activeProgress;
  const activeSampleModel = sampleModelHead(progressSample);
  let foldedLanes = showFoldedCompact
    ? foldModelLanes(stepMeasurement, foldedSummary?.models) : [];
  if (showFoldedCompact && activeSampleModel &&
    !foldedLanes.some(lane => modelMatchesSample(activeSampleModel, lane.model))) {
    foldedLanes = [{ model: activeSampleModel, rate: undefined }, ...foldedLanes];
  }
  const activeLaneIndex = foldedLanes.findIndex(lane => modelMatchesSample(activeSampleModel, lane.model));
  const progressBar = percent === undefined
    ? <GameProgressBar label={title + "进度"} />
    : <div className="game-flow-progress-bar" role="progressbar" aria-label={title + "进度"}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: percent + "%" }} /></div>;
  const progressCounts = (hasCounts || activeProgress?.count) && <span className="game-flow-progress-count">
    {hasCounts
      ? <>{progressCurrent!.toLocaleString()} <small>/ {progressTotal!.toLocaleString()}</small></>
      : activeProgress!.count}
  </span>;
  const progressPercentLabel = percent !== undefined &&
    <b className="game-flow-progress-pct" aria-hidden="true">
      {percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%</b>;
  const foldedProgress = showFoldedCompact && <div className="game-flow-folded-compact" role="group" aria-label={title + "进度"}>
    <div className="game-flow-fold-primary">
      <div className="game-flow-fold-bar">{progressBar}</div>
      {progressPercentLabel}
      {progressCounts}
    </div>
    <div className="game-flow-fold-secondary">
      {progressPosition && <span className="game-flow-progress-chip">{progressPosition}</span>}
      {foldedLanes.length > 0 && <>
        {progressPosition && <span className="game-flow-fold-sep" aria-hidden="true">·</span>}
        <div className="game-flow-fold-model-slot" aria-live="polite">
          {foldedLanes.map((lane, index) => <div key={lane.model}
            className={"game-flow-fold-lane" + (index === (activeLaneIndex >= 0 ? activeLaneIndex : 0) ? " is-active" : "")}>
            <span className="game-flow-fold-model">{shortModelName(lane.model)}</span>
            {lane.rate && <span className="game-flow-fold-speed">纯生成 <b>{lane.rate}</b> tok/s</span>}
          </div>)}
        </div>
      </>}
    </div>
  </div>;
  const expandedProgress = activeProgress && <div className="game-flow-progress">
    <div className="game-flow-progress-top">
      {progressSample && <span className="game-flow-sample" data-tooltip={progressSample}>{progressSample}</span>}
    </div>
    <div className="game-flow-progress-track">{progressBar}</div>
    <div className="game-flow-progress-bottom">
      {progressPosition && <span className="game-flow-progress-chip">{progressPosition}</span>}
      {remaining && !showHeaderTiming && <span className="game-flow-progress-remaining">预计剩余 <b>{remaining}</b></span>}
      <span className="game-flow-progress-tail">
        {progressPercentLabel}
        {progressCounts}
      </span>
    </div>
  </div>;
  return <article className={`game-flow-item is-${state}${benchmark ? " is-benchmark" : ""}${benchmark?.state === "running" ? " is-benchmark-running" : ""}${current ? " is-current-step" : ""}${configured ? " is-configured" : ""}${groupedParameters ? " has-grouped-parameters" : ""}${showFoldedCompact ? " has-folded-progress" : ""}`} data-benchmark={benchmark?.state}>
    <div className={"game-flow-step" + (showFoldedCompact ? " is-folded-compact" : "")}>
      <header className={"game-flow-head" + (disclosure ? " is-collapsible" : "") + (expanded ? "" : " is-folded")}>
        {disclosure && <button type="button" className="game-flow-head-toggle" onClick={disclosure.toggle}
          aria-label={(expanded ? "折叠" : "展开") + title + "详情"} aria-expanded={expanded} aria-controls={detailsId}
          data-tooltip={expanded ? "折叠详情" : "展开详情"} />}
        <span className="game-flow-dot" aria-hidden="true" />
        {!disclosure && onConfigure && !locked ? <button type="button" className="game-flow-title" aria-expanded={configured}
          aria-controls={settingsId} aria-describedby={statusId}
          style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer" }}
          onClick={onConfigure}>{title}</button> : <strong className="game-flow-title">{title}</strong>}
        <span id={statusId} className="game-flow-state" role="status">{status}</span>
        {groupedParameters ? <>
          {headerSummary && <span className="game-flow-header-summary">{headerSummary}</span>}
          <div className="game-flow-header-operations">{headerTiming ?? elapsedDisplay}{actionDisplay}</div>
        </> : <>{elapsedDisplay}{actionDisplay}</>}
      </header>
      {foldedProgress}
      {!expanded && !showFoldedCompact && summaryRows.length > 0 && <div className="game-flow-collapsed-summary">
        {summaryRows.map(({ key, text }, index) => <span key={key} className={"game-flow-folded-" + key}>
          {index > 0 && <span aria-hidden="true"> · </span>}
          <span className="game-flow-folded-value" data-tooltip={key === "models" ? text : undefined}>{text}</span>
        </span>)}
      </div>}
      <div id={detailsId} hidden={!expanded}>
        {infoRows.length > 0 && <dl className="game-flow-card-info" aria-label="步骤信息">
          {infoRows.map(({ label, value }, index) => <div key={label + index}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>}
        {expandedProgress}
        {activeProgress?.details}
        {details}
        {performance}
        {body}
        {(configured || !locked && onConfigure) && <section id={settingsId}
          className="game-flow-editable" role="region" aria-label={title + "运行参数"} hidden={!configured}>
          {configured && <fieldset className="game-flow-parameter-fields" disabled={locked}>
            <div ref={parameterFields} className={groupedParameters ? "game-flow-grouped-fields" : "game-flow-editable-fields"}>
              <GameFlowGroupedParameters.Provider value={groupedParameters}>{configuration}</GameFlowGroupedParameters.Provider>
              {(configurationActions || saveConfiguration) && <GameFlowParameterGroup kind="actions">
                {configurationActions}
                {saveConfiguration && <>
                  <button type="button" className="unity-btn" disabled={saveConfiguration.saving} onClick={saveConfiguration.cancel}>取消</button>
                  <button type="button" className="unity-btn unity-btn-primary" disabled={saveConfiguration.disabled}
                    onClick={saveConfiguration.run}>{saveConfiguration.saving ? "保存中…" : "保存"}</button>
                </>}
              </GameFlowParameterGroup>}
            </div>
          </fieldset>}
        </section>}
        {cardStateLine && !stateLineInProgress && <div className="game-flow-state-line" role="status" data-active={active || undefined}>
          <span aria-hidden="true" /><span>{cardStateLine}</span>
        </div>}
      </div>
    </div>
  </article>;
}
