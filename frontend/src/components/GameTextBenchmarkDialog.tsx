import { mosaicBenchmarkSteps, type MosaicBenchmarkStep } from "../gameMosaicBenchmark";
import { readMosaicSettings, type MosaicSettings } from "../gameMosaic";
import { LOCAL_REFINE_MODELS } from "../gameImageScreening";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { benchmarkChannelName, requestBenchmarkWindow, type BenchmarkQueueCommand } from "../gameBenchmarkWindow";
import { benchmarkRunner, emptyBenchmarkSnapshot, isMosaicBenchmarkStep as isMosaicStep, type BenchmarkTarget as Target, type BenchmarkInput, type BenchmarkRequest, type BenchmarkSnapshot } from "../benchmark/benchmarkRunner";
export type { BenchmarkInput, BenchmarkImageSource } from "../benchmark/benchmarkRunner";
import { benchmarkRoles, groupBenchmarkTasks, inspectBenchmarkSample, readGameBenchmarkHistory, type BenchmarkConfig, type BenchmarkResult, type BenchmarkSample } from "../gameTextBenchmark";
import { gameDuration, modelConcurrency } from "../gameModelPerformance";
import type { UnityEntry } from "../unityOffline";
import { imageBenchmarkSteps, type ImageBenchmarkStep, type ImageBenchmarkSetup } from "../gameImageBenchmark";
import { gamePromptCatalog, type GamePromptScene } from "../gamePrompts";
import { OCR_MODE_OPTIONS } from "../ocr/modes";
import { UNITY_LANGUAGES } from "../unityTranslation";
import { showAppNotice } from "./AppNotice";

const roleLabels = { text: "正文", dialogue: "对白", names: "术语" };
type BenchmarkSetup = Pick<BenchmarkInput, "scope" | "current" | "models" | "screenModel" | "initialPart"> & {
  selectedCount: number; imageCount?: number; imageSetup?: ImageBenchmarkSetup; mosaicSetup?: MosaicSettings;
};
type BenchmarkPageInput = BenchmarkSetup & {
  requestSelection: () => Promise<UnityEntry[]>;
  enqueue: (request: BenchmarkRequest) => Promise<unknown>;
  control: (kind: BenchmarkQueueCommand, id?: string) => Promise<unknown>;
  snapshot: BenchmarkSnapshot;
  onClose: () => void;
  channel?: BroadcastChannel;
};
type QueueDraft = { configs: BenchmarkConfig[]; rounds: string };
const setupFor = (input: BenchmarkInput): BenchmarkSetup => ({
  scope: input.scope, current: input.current, models: input.models, screenModel: input.screenModel,
  initialPart: input.initialPart, selectedCount: input.getWorkload().selected.length,
  mosaicSetup: input.mosaicRoot ? readMosaicSettings(input.mosaicRoot) : undefined,
  imageSetup: input.images?.setup, imageCount: input.images?.getWorkload().selected.length,
});
const openEvent = "llmchat-open-game-benchmark";
export function openGameTextBenchmark(input: BenchmarkInput) {
  window.dispatchEvent(new CustomEvent(openEvent, { detail: input }));
}

function controlQueue(kind: BenchmarkQueueCommand, id?: string) {
  if (kind === "benchmark-start") benchmarkRunner.start();
  if (kind === "benchmark-stop") benchmarkRunner.stop();
  if (kind === "benchmark-remove" && id) benchmarkRunner.remove(id);
}

function LocalGameBenchmark({ input, onClose }: { input: BenchmarkInput; onClose: () => void }) {
  const snapshot = useSyncExternalStore(benchmarkRunner.subscribe, benchmarkRunner.snapshot);
  return <GameBenchmarkPage {...setupFor(input)} snapshot={snapshot}
    requestSelection={async () => input.getWorkload().selected}
    enqueue={async request => benchmarkRunner.enqueue(input, request)}
    control={async (kind, id) => controlQueue(kind, id)} onClose={onClose} />;
}

export function GameTextBenchmarkHost() {
  const [local, setLocal] = useState<BenchmarkInput>();
  useEffect(() => {
    if (!isTauri()) {
      const open = (event: Event) => setLocal((event as CustomEvent<BenchmarkInput>).detail);
      window.addEventListener(openEvent, open);
      return () => window.removeEventListener(openEvent, open);
    }
    const channel = new BroadcastChannel(benchmarkChannelName);
    let active: BenchmarkInput | undefined;
    let opening: Promise<void> | undefined;
    const open = (event: Event) => {
      if (opening) return;
      const previous = active;
      active = (event as CustomEvent<BenchmarkInput>).detail;
      opening = invoke<boolean>("open_game_benchmark_window").then(created => {
        if (!created && active) channel.postMessage({ type: "refresh-setup", setup: setupFor(active) });
      }).catch(error => {
        active = previous;
        showAppNotice("打开测试队列失败：" + String(error), "error");
      }).finally(() => { opening = undefined; });
    };
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== "request") return;
      try {
        let value: unknown = true;
        if (message.kind === "benchmark-snapshot") value = benchmarkRunner.snapshot();
        else if (message.kind === "benchmark-start" || message.kind === "benchmark-stop" || message.kind === "benchmark-remove")
          controlQueue(message.kind, message.data);
        else {
          if (!active) throw new Error("测试队列没有关联的游戏工程");
          if (message.kind === "setup") value = setupFor(active);
          else if (message.kind === "selection") value = active.getWorkload().selected;
          else if (message.kind === "benchmark-enqueue") value = benchmarkRunner.enqueue(active, message.data);
          else throw new Error("未知的测试队列请求");
        }
        channel.postMessage({ type: "response", id: message.id, value });
      } catch (error) {
        channel.postMessage({ type: "response", id: message.id, error: String(error) });
      }
    };
    const unsubscribe = benchmarkRunner.subscribe(() => {
      const state = benchmarkRunner.snapshot();
      if (state.progress) channel.postMessage(state.progress);
      channel.postMessage({ type: "benchmark-queue", ...state });
    });
    window.addEventListener(openEvent, open);
    return () => { unsubscribe(); window.removeEventListener(openEvent, open); channel.close(); };
  }, []);
  return local ? <LocalGameBenchmark key={local.scope} input={local} onClose={() => setLocal(undefined)} /> : null;
}

export function GameTextBenchmarkWindow() {
  const [page, setPage] = useState<{ setup: BenchmarkSetup; channel: BroadcastChannel }>();
  const [snapshot, setSnapshot] = useState(emptyBenchmarkSnapshot);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const channel = new BroadcastChannel(benchmarkChannelName);
    const receiveSnapshot = (state: BenchmarkSnapshot) => {
      if (active) setSnapshot(previous => state.version >= previous.version ? state : previous);
    };
    const refresh = (event: MessageEvent) => {
      if (event.data?.type === "refresh-setup") setPage({ setup: event.data.setup, channel });
      if (event.data?.type === "benchmark-queue") receiveSnapshot(event.data);
    };
    channel.addEventListener("message", refresh);
    void Promise.all([
      requestBenchmarkWindow<BenchmarkSetup>(channel, "setup"),
      requestBenchmarkWindow<BenchmarkSnapshot>(channel, "benchmark-snapshot"),
    ]).then(([setup, state]) => {
      if (active) { receiveSnapshot(state); setPage({ setup, channel }); }
    }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; channel.close(); };
  }, []);
  const close = () => void getCurrentWindow().close().catch(error => showAppNotice("关闭测试窗口失败：" + String(error), "error"));
  if (!page) return <main className="game-benchmark-page"><p role="status">{error || "正在读取测试队列…"}</p>
    <button type="button" className="unity-btn" onClick={close}>关闭</button></main>;
  return <GameBenchmarkPage key={page.setup.scope} {...page.setup} channel={page.channel} snapshot={snapshot}
    requestSelection={() => requestBenchmarkWindow(page.channel, "selection")}
    enqueue={request => requestBenchmarkWindow(page.channel, "benchmark-enqueue", request)}
    control={(kind, id) => requestBenchmarkWindow(page.channel, kind, id)} onClose={close} />;
}

function GameBenchmarkPage(props: BenchmarkPageInput) {
  const imageSteps = Object.keys(props.imageSetup?.steps || {}) as ImageBenchmarkStep[];
  const [part, setPart] = useState<"text" | "images" | "mosaic">(
    props.initialPart === "mosaic" && props.mosaicSetup ? "mosaic" : props.initialPart === "images" && imageSteps.length ? "images" : "text");
  const [textStep, setTextStep] = useState<"translate" | "screen">("translate");
  const [imageStep, setImageStep] = useState<ImageBenchmarkStep>(imageSteps[0] || "recognize");
  const [mosaicStep, setMosaicStep] = useState<MosaicBenchmarkStep>("mosaicScreen");
  const drafts = useRef<Partial<Record<Target, QueueDraft>>>({});
  const step = part === "text" ? textStep : part === "mosaic" ? mosaicStep : imageStep;
  const { jobs, running, stopping, progress, historyRevision } = props.snapshot;
  const hasWaiting = jobs.some(job => job.status === "等待");
  const control = (kind: BenchmarkQueueCommand, id?: string) =>
    void props.control(kind, id).catch(error => showAppNotice(String(error), "error"));
  return <GameTextBenchmarkDialog key={step} {...props} step={step} draft={drafts.current[step]}
    onDraft={draft => { drafts.current[step] = draft; }} historyRevision={historyRevision}
    queueControls={<button type="button" className="unity-btn" disabled={stopping || !running && !hasWaiting}
      onClick={() => control(running ? "benchmark-stop" : "benchmark-start")}>
      {stopping ? "正在中止…" : running ? "中止当前并暂停队列" : "运行队列"}</button>}
    queueContents={<div className="game-benchmark-results" aria-label="任务队列">
      <strong>任务队列 · {jobs.length} 项</strong>
      {!jobs.length && <p className="hint">加入任务后，点击「运行队列」按顺序执行。</p>}
      {jobs.map(job => <div key={job.id} className="game-benchmark-toolbar">
        <strong>{job.label}</strong>
        {job.status === "运行中" && progress?.state === "running" ? <span role="status">
          {progress.label} · {progress.done}/{progress.total} · {gameDuration(progress.elapsedMs)}
          {progress.failed > 0 && " · 失败 " + progress.failed}{progress.sample && " · " + progress.sample}
        </span> : <span>{job.status} · 样本 {job.count} · {job.detail}</span>}
        {job.status !== "运行中" && <button type="button" className="unity-btn" onClick={() => control("benchmark-remove", job.id)}>移除</button>}
      </div>)}
    </div>}
    targetControls={<div className="game-benchmark-toolbar game-benchmark-target">
      <label>测试内容<select value={part} onChange={event => setPart(event.target.value as typeof part)}>
        <option value="text">翻译文本</option>
        {imageSteps.length > 0 && <option value="images">图片翻译</option>}
        {props.mosaicSetup && <option value="mosaic">图片去码</option>}
      </select></label>
      <label>步骤{part === "text" ?
        <select value={textStep} onChange={event => setTextStep(event.target.value as typeof textStep)}>
          <option value="screen">筛选文本</option><option value="translate">翻译正文</option>
        </select> : part === "mosaic" ? <select value={mosaicStep} onChange={event => setMosaicStep(event.target.value as MosaicBenchmarkStep)}>
          {Object.entries(mosaicBenchmarkSteps).map(([id, title]) => <option key={id} value={id}>{title}</option>)}
        </select> : <select value={imageStep} onChange={event => setImageStep(event.target.value as ImageBenchmarkStep)}>
          {imageSteps.map(id => <option key={id} value={id}>{imageBenchmarkSteps[id].title}</option>)}
        </select>}</label>
    </div>} />;
}


function GameTextBenchmarkDialog({ scope: textScope, current, screenModel, step, draft, onDraft, enqueue, targetControls,
  requestSelection, imageSetup, mosaicSetup, imageCount, selectedCount, models, onClose, channel, queueControls, queueContents, historyRevision }:
  BenchmarkPageInput & { step: Target; draft?: QueueDraft; onDraft: (draft: QueueDraft) => void;
    targetControls: ReactNode; queueControls: ReactNode; queueContents: ReactNode; historyRevision: number }) {
  const mosaicStep = isMosaicStep(step) ? step : undefined;
  const imageStep = !isMosaicStep(step) && step !== "screen" && step !== "translate" ? step : undefined;
  const images = imageStep ? imageSetup : undefined;
  const scope = images?.scope || textScope;
  const mainRole = imageStep ? imageBenchmarkSteps[imageStep].role : "textScreen";
  const roles = step === "translate" ? benchmarkRoles : ["text"] as const;
  const requiresModel = step === "review";
  const localLabel = step === "translate" || step === "imageTranslate" ? "翻译引擎" : step === "render" ? "本地原位排版" : step === "recognize" ? "本地 OCR" : "本地筛选";
  const key = "llmchat-game-benchmark:" + scope + (step === "translate" ? "" : ":" + step);
  const capture = (number: number): BenchmarkConfig => {
    const { modelIds, ...settings } = current;
    const id = imageStep ? (images?.steps[imageStep] || "") : (screenModel || "");
    const selectedModels = {} as BenchmarkConfig["models"];
    for (const role of benchmarkRoles) {
      const model = step === "translate" ? modelIds[role] : role === "text" ? id : "";
      selectedModels[role] = { id: model, lanes: modelConcurrency(scope, step === "translate" ? role : mainRole, model || modelIds.text) };
    }
    return { ...settings, ...(mosaicStep && mosaicSetup ? { mosaic: { ...mosaicSetup, sampleLimit: 0, selection: "checked" } } : {}), ...(images ? { source: images.source, target: images.target, skipTarget: images.skipTarget,
      imageMode: imageStep === "refine" ? images.refineMode || "precise" : images.mode, imageStrategy: images.strategy, localLanes: imageStep === "refine" ? images.refineConcurrency || 2 : images.concurrency,
      imageConfidence: imageStep === "refine" ? images.refineConfidence : images.confidence, engines: images.engines } : {}),
      prompts: { ...(images?.prompts || settings.prompts) }, id: crypto.randomUUID(), label: "配置 " + number, models: selectedModels };
  };
  const [saved] = useState<{ configs?: BenchmarkConfig[]; rounds?: number }>(() => {
    try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
  });
  const [configs, setConfigs] = useState(() => draft?.configs || saved.configs || [capture(1)]);
  const [rounds, setRounds] = useState(draft?.rounds || String(saved.rounds || 1));
  const [savedQueue, setSavedQueue] = useState(() =>
    saved.configs ? JSON.stringify({ configs: saved.configs, rounds: saved.rounds || 1 }) : "");
  const [expanded, setExpanded] = useState(() => new Set(configs[0] ? [configs[0].id] : []));
  const [history, setHistory] = useState<BenchmarkResult[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false), [historyError, setHistoryError] = useState("");
  const [reload, setReload] = useState(0);
  const [samplePreview, setSamplePreview] = useState<Record<string, BenchmarkSample>>({});
  const [checking, setChecking] = useState(false);
  const [selectionCount, setSelectionCount] = useState(imageStep ? imageCount ?? 0 : selectedCount);
  const [adding, setAdding] = useState(false);
  const totalRounds = Number(rounds);
  const validRounds = Number.isInteger(totalRounds) && totalRounds >= 1 && totalRounds <= 100;
  const serialized = JSON.stringify({ configs, rounds: totalRounds });
  const canRun = configs.length > 0 && validRounds &&
    configs.every(config => {
      if (mosaicStep) return !!config.mosaic && (mosaicStep !== "mosaicRefine" ||
        !!config.mosaic.refineModel && !!config.mosaic.refineGuardModel);
      if (!config.models.text.id) return !requiresModel &&
        (step !== "translate" && step !== "imageTranslate" || !!(config.engines || images?.engines || current.engines)?.some(engine => engine.enabled));
      return roles.every(role => !config.models[role].id || models.includes(config.models[role].id));
    });
  useEffect(() => { onDraft({ configs, rounds }); }, [configs, rounds]);
  const saveQueue = (silent = false) => {
    if (!validRounds || serialized === savedQueue) return;
    localStorage.setItem(key, serialized);
    setSavedQueue(serialized);
    if (!silent) showAppNotice("测试配置已保存");
  };
  const sampleSettings = configs[0]?.mosaic;
  const changeMosaic = (id: string, patch: Partial<NonNullable<BenchmarkConfig["mosaic"]>>) => {
    update(id, config => ({ ...config, mosaic: { ...config.mosaic!, ...patch } }));
  };
  const changeSample = (patch: Pick<Partial<NonNullable<BenchmarkConfig["mosaic"]>>, "selection" | "sampleLimit">) =>
    setConfigs(previous => previous.map(config => config.mosaic ? { ...config, mosaic: { ...config.mosaic, ...patch } } : config));
  const toggleConfig = (id: string, open: boolean) => setExpanded(previous => {
    if (previous.has(id) === open) return previous;
    const next = new Set(previous);
    if (open) next.add(id); else next.delete(id);
    return next;
  });
  const runScope = scope + (mosaicStep ? ":benchmark:mosaic" : imageStep ? ":benchmark:images" : ":benchmark:text");
  useEffect(() => {
    let active = true;
    setHistoryLoading(true); setHistoryError("");
    void readGameBenchmarkHistory(runScope, step).then(records => { if (active) setHistory(records); })
      .catch(error => { if (active) setHistoryError(String(error)); })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [runScope, step, historyRevision, reload]);
  const inspect = async () => {
    setChecking(true);
    try {
      const selected = await requestSelection();
      setSelectionCount(selected.length);
      setSamplePreview(inspectBenchmarkSample(selected, configs));
    } catch (error) { showAppNotice(String(error), "error"); }
    finally { setChecking(false); }
  };
  const update = (id: string, change: (config: BenchmarkConfig) => BenchmarkConfig) => {
    setConfigs(previous => previous.map(config => config.id === id ? change(config) : config));
    setSamplePreview(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)));
  };
  const move = (index: number, other: number) => setConfigs(previous => {
    const next = previous.slice();
    [next[index], next[other]] = [next[other], next[index]];
    return next;
  });
  const start = async () => {
    if (!canRun || adding) return;
    const configsSnapshot = structuredClone(configs).map(config => ({ ...config, engines: config.engines || (imageStep ? images?.engines : current.engines) }));
    setAdding(true);
    try {
      await enqueue({ scope: textScope, step, configs: configsSnapshot, rounds: totalRounds });
    } catch (error) {
      showAppNotice(String(error), "error");
    } finally { setAdding(false); }
  };

  const tasks = useMemo(() => groupBenchmarkTasks(history), [history]);
  const latestRunByConfig = useMemo(() => {
    const latest = new Map<string, { run: BenchmarkResult; finishedAt: number }>();
    for (const run of history) {
      const config = run.performance.benchmark?.config as { id?: unknown } | undefined;
      const id = config?.id;
      if (typeof id !== "string" || !id) continue;
      const finishedAt = Date.parse(run.performance.endedAt || run.performance.beginTime || "") || 0;
      const previous = latest.get(id);
      if (!previous || finishedAt > previous.finishedAt || finishedAt === previous.finishedAt && run.round > previous.run.round) {
        latest.set(id, { run, finishedAt });
      }
    }
    return latest;
  }, [history]);
  const page = <main className={"game-benchmark-page" + (channel ? "" : " game-benchmark-browser-fallback")}>
    <header className="game-benchmark-page-header">
      <h2>测试队列</h2>
      {targetControls}
      <p className="hint">{mosaicStep ? "使用去码工作台的原图和蒙版，结果独立归档。" : "已勾选 " + selectionCount + (imageStep ? " 张图片" : " 条文本") + "。测试结果独立归档。"}</p>
    </header>
    <section className="game-benchmark-scroll"><div className="game-text-benchmark">
      {queueContents}
      <div className="game-benchmark-toolbar">
        <label>循环轮次 <input type="number" min={1} max={100} step={1} value={rounds} disabled={adding} onChange={event => setRounds(event.target.value)} /></label>
        <button type="button" className="unity-btn" disabled={adding} onClick={() => {
          const config = capture(configs.length + 1);
          if (config.mosaic && sampleSettings) {
            config.mosaic.selection = sampleSettings.selection;
            config.mosaic.sampleLimit = sampleSettings.sampleLimit;
          }
          setConfigs(previous => [...previous, config]);
          toggleConfig(config.id, true);
        }}>加入当前配置</button>
        {step === "translate" && <button type="button" className="unity-btn" disabled={checking || !configs.length} onClick={() => void inspect()}>检查样本</button>}
      </div>
      {mosaicStep && sampleSettings && <div className="game-benchmark-toolbar">
        <label>样本范围<select value={sampleSettings.selection} onChange={event => changeSample({ selection: event.target.value as typeof sampleSettings.selection })}>
          <option value="checked">去码页已勾选</option><option value="all">全部可用图片</option>
        </select></label>
        <label>样本上限<input type="number" min={0} step={1} value={sampleSettings.sampleLimit || ""} placeholder="不限"
          title="留空时测试范围内的全部图片" onChange={event => changeSample({ sampleLimit: Math.max(0, Math.trunc(Number(event.target.value))) })} /></label>
        {sampleSettings.sampleLimit > 0 && <button type="button" className="unity-btn" onClick={() => changeSample({ sampleLimit: 0 })}>取消上限</button>}
      </div>}
      {configs.map((config, index) => {
        const lastRun = latestRunByConfig.get(config.id)?.run;
        return <details key={config.id} className={"game-benchmark-item" + (lastRun ? " has-run" : "")} open={expanded.has(config.id)}
        onToggle={event => toggleConfig(config.id, event.currentTarget.open)}>
        <summary>
          <span className="game-benchmark-item-badge">Q{index + 1}</span>
          <strong>{config.label || "配置 " + (index + 1)}</strong>
          <span className="game-benchmark-item-model">{mosaicStep && config.mosaic ? mosaicStep === "mosaicScreen"
            ? (config.mosaic.detector === "grid" ? "方格规则" : "分类＋定位") + " · 并发 " + (config.mosaic.concurrency ?? 2)
            : mosaicStep === "mosaicRefine" ? (config.mosaic.refineModel || "").split("/").at(-1)
            : config.mosaic.model === "turbo" ? "Qwen Image 2.1 Turbo" : "Qwen Image Edit 2511"
            : config.models.text.id ? config.models.text.id.split("/").at(-1) + " · 并发 " + config.models.text.lanes : requiresModel ? "未选模型" : localLabel}</span>
          {lastRun && <span className="game-benchmark-item-score">上次 {gameDuration(lastRun.performance.elapsedMs)} · {lastRun.translated}/{lastRun.selected}</span>}
        </summary>
        <fieldset disabled={adding} className="game-benchmark-item-fields">
        <div className="game-benchmark-toolbar">
          <input aria-label={"第 " + (index + 1) + " 项名称"} value={config.label} onChange={event => update(config.id, previous => ({ ...previous, label: event.target.value }))} />
          <button type="button" className="unity-btn" disabled={index === 0} onClick={() => move(index, index - 1)}>上移</button>
          <button type="button" className="unity-btn" disabled={index === configs.length - 1} onClick={() => move(index, index + 1)}>下移</button>
          <button type="button" className="unity-btn" onClick={() => setConfigs(previous => previous.filter(item => item.id !== config.id))}>移除</button>
        </div>
        {mosaicStep && config.mosaic && <div className="game-benchmark-toolbar">
          {mosaicStep === "mosaicScreen" && <>
            <label>筛选方式<select value={config.mosaic.detector} onChange={event => changeMosaic(config.id, { detector: event.target.value as MosaicSettings["detector"] })}>
              <option value="anime">分类＋定位</option><option value="grid">方格规则</option>
            </select></label>
            <label>并发<select value={config.mosaic.concurrency ?? 2} onChange={event => changeMosaic(config.id, { concurrency: Number(event.target.value) })}>
              {[1, 2, 4].map(value => <option key={value}>{value}</option>)}
            </select></label>
          </>}
          {mosaicStep === "mosaicRefine" && <>
            <label>候选区域推理模型<select value={config.mosaic.refineModel} onChange={event => changeMosaic(config.id, { refineModel: event.target.value })}>
              {[...new Set([config.mosaic.refineModel, ...models].filter(Boolean))].map(model => <option key={model}>{model}</option>)}
            </select></label>
            <label>纹理与漏检复核模型<select value={config.mosaic.refineGuardModel} onChange={event => changeMosaic(config.id, { refineGuardModel: event.target.value })}>
              {[...new Set([config.mosaic.refineGuardModel, ...models].filter(Boolean))].map(model => <option key={model}>{model}</option>)}
            </select></label>
            <label>并发<select value={config.mosaic.refineConcurrency ?? 1} onChange={event => changeMosaic(config.id, { refineConcurrency: Number(event.target.value) })}>
              <option>1</option><option>2</option>
            </select></label>
          </>}
          {mosaicStep === "mosaicRedraw" && <>
            <label>重绘模型<select value={config.mosaic.model} onChange={event => changeMosaic(config.id,
              { model: event.target.value as MosaicSettings["model"], steps: event.target.value === "turbo" ? 8 : 20 })}>
              <option value="turbo">Qwen Image 2.1 Turbo</option><option value="2511">Qwen Image Edit 2511</option>
            </select></label>
            <label>步数<input type="number" min={1} max={100} value={config.mosaic.steps}
              onChange={event => changeMosaic(config.id, { steps: Math.max(1, Math.min(100, Math.trunc(Number(event.target.value)))) })} /></label>
            <label><input type="checkbox" checked={config.mosaic.protect} onChange={event => changeMosaic(config.id, { protect: event.target.checked })} />保护已识别文字</label>
          </>}
        </div>}
        {!mosaicStep && roles.filter(role => role === "text" || !!config.models.text.id).map(role => {
          const promptRole: GamePromptScene = step === "translate" ? role : mainRole;
          return <div className="game-benchmark-model" key={role}>
            <label>{step === "translate" ? roleLabels[role] : "处理方式"}<select value={config.models[role].id}
              onChange={event => update(config.id, previous => ({ ...previous, models: { ...previous.models, [role]: { ...previous.models[role], id: event.target.value } } }))}>
              <option value="">{role !== "text" ? "跟随正文模型" : requiresModel ? "请选择模型" : localLabel}</option>
              {[...new Set([...models, config.models[role].id].filter(Boolean))].map(model => <option key={model} value={model}>{model.split("/").at(-1)}</option>)}
            </select></label>
            <label>并发<select disabled={!config.models[role].id} value={config.models[role].lanes}
              onChange={event => update(config.id, previous => ({ ...previous, models: { ...previous.models, [role]: { ...previous.models[role], lanes: Number(event.target.value) } } }))}>
              {[1, 2, 3, 4].map(lanes => <option key={lanes} value={lanes}>{lanes}</option>)}
            </select></label>
            {config.models[role].id && <label>提示词<select value={config.prompts[promptRole] || "builtin:" + promptRole}
              onChange={event => update(config.id, previous => ({ ...previous, prompts: { ...previous.prompts, [promptRole]: event.target.value } }))}>
              {gamePromptCatalog().filter(entry => entry.scene === promptRole).map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select></label>}
          </div>;
        })}
        {(step === "filter" || step === "recognize" || step === "refine") && !config.models.text.id && <div className="game-benchmark-toolbar">
          {step === "filter" ? <label>筛选策略<select value={config.imageStrategy || "staged"}
            onChange={event => update(config.id, previous => ({ ...previous, imageStrategy: event.target.value as BenchmarkConfig["imageStrategy"] }))}>
            <option value="staged">分级快速筛选</option><option value="full">完整范围筛选</option>
          </select></label> : <label>{step === "refine" ? "本地模型" : "识别模式"}<select value={config.imageMode || (step === "refine" ? "precise" : "fast")}
            onChange={event => update(config.id, previous => ({ ...previous, imageMode: event.target.value as BenchmarkConfig["imageMode"] }))}>
            {(step === "refine" ? LOCAL_REFINE_MODELS : OCR_MODE_OPTIONS).map(option => <option key={option.id} value={option.id}>{option.title}</option>)}
          </select></label>}
          <label>本地并发<select value={config.localLanes || 1}
            onChange={event => update(config.id, previous => ({ ...previous, localLanes: Number(event.target.value) }))}>
            {(step === "refine" ? [1, 2, 3, 4] : [1, 2, 3, 4, 6, 8]).map(value => <option key={value} value={value}>{value}</option>)}
          </select></label>
        </div>}
        {(step === "translate" || step === "imageTranslate") && !config.models.text.id && <div className="game-benchmark-toolbar" role="group" aria-label="翻译引擎">
          {(config.engines || images?.engines || current.engines || []).map(engine => <label key={engine.id}>
            <input type="checkbox" checked={engine.enabled} onChange={event => {
              const enabled = event.target.checked;
              update(config.id, previous => ({ ...previous, engines: (previous.engines || images?.engines || current.engines || [])
                .map(item => item.id === engine.id ? { ...item, enabled } : item) }));
            }} />{engine.id}
          </label>)}
        </div>}
        {step === "recognize" && config.models.text.id && <label className="unity-inline-check"><input type="checkbox" checked={(config.imageMode || images?.mode) === "manga"}
          onChange={event => update(config.id, previous => ({ ...previous, imageMode: event.target.checked ? "manga" : "precise" }))} />用 Manga OCR 复读日文竖排</label>}
        {(step === "refine" || step === "recognize" && images?.confidence !== undefined) && <div className="game-benchmark-toolbar"><label>置信度阈值（%）
          <input type="number" min={0} max={100} value={config.imageConfidence ?? (step === "refine" ? images?.refineConfidence : images?.confidence) ?? 50}
            onChange={event => update(config.id, previous => ({ ...previous, imageConfidence: Math.min(100, Math.max(0, Number(event.target.value))) }))} />
        </label></div>}
        {!mosaicStep && <div className="game-benchmark-toolbar">
          {step !== "render" && <><label>原文语言<select value={config.source} onChange={event => update(config.id, previous => ({ ...previous, source: event.target.value }))}>
            <option value="auto">自动检测</option>{UNITY_LANGUAGES.map(language => <option key={language.value} value={language.value}>{language.label}</option>)}
          </select></label>
          <label>目标语言<select value={config.target} onChange={event => update(config.id, previous => ({ ...previous, target: event.target.value }))}>
            {UNITY_LANGUAGES.map(language => <option key={language.value} value={language.value}>{language.label}</option>)}
          </select></label>
          {["translate", "imageTranslate", "review", "screen"].includes(step) && <label><input type="checkbox" checked={config.skipTarget} onChange={event => update(config.id, previous => ({ ...previous, skipTarget: event.target.checked }))}/>跳过目标语言</label>}</>}
          {step === "translate" && <><label>换行处理<select value={config.wrap} onChange={event => update(config.id, previous => ({ ...previous, wrap: event.target.value as BenchmarkConfig["wrap"] }))}>
            <option value="keep">保留换行</option><option value="join">合并后恢复换行</option><option value="natural">大模型自然断行</option>
          </select></label><label><input type="checkbox" checked={config.includeContext} onChange={event => update(config.id, previous => ({ ...previous, includeContext: event.target.checked }))}/>附带上下文</label></>}
        </div>}
        </fieldset>
        {samplePreview[config.id] && <p style={{ padding: "0 12px 8px" }}>
          共 {samplePreview[config.id].selected} 条 · 正文候选 {samplePreview[config.id].text} · 对白候选 {samplePreview[config.id].dialogue} · 原样保留 {samplePreview[config.id].retained}
          {config.models.dialogue.id && config.models.dialogue.id !== config.models.text.id && samplePreview[config.id].dialogue === 0 &&
            <strong> · 此样本测不到专用对白模型</strong>}
        </p>}
        </details>;
      })}
      <div className="game-benchmark-results" aria-label="测试记录">
        <header className="game-benchmark-records-head"><strong>测试记录 · {tasks.length} 个任务</strong>
          <button type="button" className="unity-btn" disabled={historyLoading} onClick={() => setReload(value => value + 1)}>刷新</button></header>
        {historyLoading && <p className="hint" role="status">正在读取测试记录…</p>}
        {historyError && <p className="unity-offline-error" role="alert">{historyError}</p>}
        {!historyLoading && !historyError && !tasks.length && <p className="hint">当前步骤暂无测试记录。</p>}
        {tasks.map(task => <details key={task.id} className="game-benchmark-record-task">
          <summary><span className="game-benchmark-record-date">{task.firstTime && new Date(task.firstTime).toLocaleString("zh-CN", { hour12: false })}</span>
            {task.rounds} 轮 · {task.configs} 个配置 · {task.runs.length} 项{task.failed > 0 && ` · ${task.failed} 项含失败`}{task.stopped > 0 && ` · ${task.stopped} 项中止`}
          </summary>
          <div className="game-benchmark-record-runs">
          {task.runs.map((result, index) => <details key={result.performance.taskId || index}>
          <summary>第 {result.round} 轮 · {result.label} · {result.status} · {gameDuration(result.performance.elapsedMs)} · 完成 {result.translated}/{result.selected}</summary>
          {result.detail && <p>{result.detail}</p>}
          {result.summary && <p>{result.summary}</p>}
          {!!result.unobservedModels.length && <p>未记录模型请求：{result.unobservedModels.map(id => id.split("/").at(-1)).join("、")}</p>}
          {Object.values(result.performance.models).map(model => <div key={model.model + model.concurrency}>
            {model.model.split("/").at(-1)} · 并发 {model.concurrency} · {model.requests} 次 · 纯生成 {model.generationMs ? (model.generationTokens * 1000 / model.generationMs).toFixed(1) : "—"} tok/s · 请求平均 {model.requestMs ? (model.tokens * 1000 / model.requestMs).toFixed(1) : "—"} tok/s
          </div>)}
          </details>)}
          </div>
        </details>)}
      </div>
    </div></section>
    <footer className="game-benchmark-footer">
    <button type="button" className="settings-panel-save" disabled={!canRun || adding} onClick={() => void start()}>
      {adding ? "正在准备样本…" : sampleSettings?.sampleLimit ? "加入队列（每轮最多 " + sampleSettings.sampleLimit + " 张）" : "加入队列"}
    </button>
    {queueControls}
    <button type="button" className="unity-btn" disabled={!validRounds || serialized === savedQueue} onClick={() => { try { saveQueue(); } catch (error) { showAppNotice("测试配置保存失败：" + String(error), "error"); } }}>保存配置</button>
    <button type="button" className="unity-btn" onClick={onClose}>关闭</button>
    </footer>
  </main>;
  return channel ? page : createPortal(page, document.body);
}
