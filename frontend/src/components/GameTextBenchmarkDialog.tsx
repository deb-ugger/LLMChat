import type { GameDialoguePage } from "../gameTranslationContext";
import { LOCAL_REFINE_MODELS } from "../gameImageScreening";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { benchmarkChannelName, requestBenchmarkWindow } from "../gameBenchmarkWindow";
import { registerAppCloseGuard } from "../appClose";
import { benchmarkRoles, groupBenchmarkTasks, inspectBenchmarkSample, readGameBenchmarkHistory, runGameTextBenchmarks, runGameTextScreenSample, type BenchmarkStepRunner, type BenchmarkConfig, type BenchmarkResult, type BenchmarkSample } from "../gameTextBenchmark";
import { beginGameStep, clearGamePerformance, finishGameStep, gameDuration, modelConcurrency, stepPerformance, updateBenchmarkWindowPerformance, flushGamePerformanceArchive } from "../gameModelPerformance";
import type { UnityEntry, UnityImage, UnityProgress } from "../unityOffline";
import { imageBenchmarkRows, imageBenchmarkSteps, runGameImageSample, type ImageBenchmarkStep, type ImageBenchmarkSetup, type ImageBenchmarkWorkload } from "../gameImageBenchmark";
import { gamePromptCatalog, type GamePromptScene } from "../gamePrompts";
import { OCR_MODE_OPTIONS } from "../ocr/modes";
import { UNITY_LANGUAGES } from "../unityTranslation";
import { showAppNotice } from "./AppNotice";

const roleLabels = { text: "正文", dialogue: "对白", names: "术语" };
type Target = "translate" | "screen" | ImageBenchmarkStep;
export type BenchmarkImageSource = {
  setup: ImageBenchmarkSetup;
  getWorkload: () => ImageBenchmarkWorkload;
  readImage?: (project: NonNullable<ImageBenchmarkWorkload["project"]>, image: UnityImage) => Promise<Blob>;
};
export type BenchmarkInput = {
  scope: string; current: Omit<BenchmarkConfig, "id" | "label" | "models"> & { modelIds: Record<typeof benchmarkRoles[number], string> };
  getWorkload: () => { entries: UnityEntry[]; selected: UnityEntry[]; dialoguePages?: GameDialoguePage[] };
  screenModel?: string;
  images?: BenchmarkImageSource;
  initialPart?: "text" | "images";
  models: string[];
  onMessage: (text: string, level: "info" | "success" | "error") => void;
};
type BenchmarkSetup = Pick<BenchmarkInput, "scope" | "current" | "models" | "screenModel" | "initialPart"> & {
  selectedCount: number; imageCount?: number; imageSetup?: ImageBenchmarkSetup;
};
type BenchmarkWorkload = ReturnType<BenchmarkInput["getWorkload"]>;
type BenchmarkPageInput = BenchmarkSetup & {
  requestWorkload: () => Promise<BenchmarkWorkload>;
  requestSelection: () => Promise<UnityEntry[]>;
  requestImages: () => Promise<ImageBenchmarkWorkload>;
  readImage: (image: UnityImage) => Promise<Blob>;
  onClose: () => void;
  onMessage: BenchmarkInput["onMessage"];
  channel?: BroadcastChannel;
};
type QueueDraft = { configs: BenchmarkConfig[]; rounds: string };
const setupFor = (input: BenchmarkInput): BenchmarkSetup => ({
  scope: input.scope, current: input.current, models: input.models, screenModel: input.screenModel,
  initialPart: input.initialPart, selectedCount: input.getWorkload().selected.length,
  imageSetup: input.images?.setup, imageCount: input.images?.getWorkload().selected.length,
});
const openEvent = "llmchat-open-game-benchmark";
export function openGameTextBenchmark(input: BenchmarkInput) {
  window.dispatchEvent(new CustomEvent(openEvent, { detail: input }));
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
    let imageSnapshot: { project: NonNullable<ImageBenchmarkWorkload["project"]>; images: Map<string, UnityImage> } | undefined;
    let opening: Promise<void> | undefined;
    let running = false, disposed = false, unregister: (() => void) | undefined;
    const open = (event: Event) => {
      if (opening) return;
      const input = (event as CustomEvent<BenchmarkInput>).detail;
      opening = invoke<boolean>("open_game_benchmark_window").then(created => {
        if (created || !active || !running) {
          active = input;
          imageSnapshot = undefined;
          if (!created) channel.postMessage({ type: "refresh-setup", setup: setupFor(input) });
        }
      }).catch(error => showAppNotice("打开测试队列失败：" + String(error), "error")).finally(() => { opening = undefined; });
    };
    channel.onmessage = async (event: MessageEvent) => {
      const message = event.data;
      if (message?.type === "request" && message.kind !== "stop") {
        try {
          await opening;
          if (!active) throw new Error("测试队列没有关联的游戏工程");
          const value = message.kind === "read-image" ? (() => {
              const image = imageSnapshot?.images.get(message.imageId);
              return image && imageSnapshot && active?.images?.readImage?.(imageSnapshot.project, image);
            })() :
            message.kind === "images" ? (() => {
              const workload = active.images?.getWorkload();
              if (workload?.project) imageSnapshot = { project: workload.project, images: new Map(workload.selected.map(row => [row.id, row])) };
              return workload && { ...workload, project: workload.project && { ...workload.project, entries: [], images: [] } };
            })() :
            message.kind === "selection" ? active.getWorkload().selected :
            message.kind === "workload" ? active.getWorkload() : setupFor(active);
          const response = await value;
          if (response === undefined) throw new Error("当前游戏未提供所需的测试数据");
          channel.postMessage({ type: "response", id: message.id, value: response });
        } catch (error) { channel.postMessage({ type: "response", id: message.id, error: String(error) }); }
      } else if (message?.type === "performance" && (active?.scope === message.scope || active?.images?.setup.scope === message.scope)) {
        running = message.value?.queue?.started !== undefined;
        updateBenchmarkWindowPerformance(message.scope, message.value && { ...message.value, step: message.step });
      } else if (message?.type === "output") active?.onMessage(message.text, message.level);
    };
    window.addEventListener(openEvent, open);
    void registerAppCloseGuard(async () => {
      if (running) await requestBenchmarkWindow(channel, "stop", 45000);
      return true;
    }).then(stop => { if (disposed) stop(); else unregister = stop; }).catch(console.error);
    return () => { disposed = true; unregister?.(); window.removeEventListener(openEvent, open); channel.close(); };
  }, []);
  return local ? <GameBenchmarkPage {...setupFor(local)} onMessage={local.onMessage}
    requestWorkload={async () => local.getWorkload()} requestSelection={async () => local.getWorkload().selected}
    requestImages={async () => local.images!.getWorkload()} readImage={image => local.images!.readImage!(local.images!.getWorkload().project!, image)}
    onClose={() => setLocal(undefined)} /> : null;
}

export function GameTextBenchmarkWindow() {
  const [page, setPage] = useState<{ setup: BenchmarkSetup; channel: BroadcastChannel }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const channel = new BroadcastChannel(benchmarkChannelName);
    const refresh = (event: MessageEvent) => {
      if (event.data?.type === "refresh-setup") setPage({ setup: event.data.setup, channel });
    };
    channel.addEventListener("message", refresh);
    void requestBenchmarkWindow<BenchmarkSetup>(channel, "setup").then(setup => {
      if (active) setPage({ setup, channel });
    }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; channel.close(); };
  }, []);
  const close = () => void getCurrentWindow().close().catch(error => showAppNotice("关闭测试窗口失败：" + String(error), "error"));
  if (!page) return <main className="game-benchmark-page"><p role="status">{error || "正在读取测试队列…"}</p>
    <button type="button" className="unity-btn" onClick={close}>关闭</button></main>;
  return <GameBenchmarkPage key={page.setup.scope} {...page.setup} channel={page.channel}
    requestWorkload={() => requestBenchmarkWindow(page.channel, "workload")}
    requestSelection={() => requestBenchmarkWindow(page.channel, "selection")}
    requestImages={() => requestBenchmarkWindow(page.channel, "images")}
    readImage={image => requestBenchmarkWindow(page.channel, "read-image", 15000, image.id)}
    onClose={close} onMessage={(text, level) => page.channel.postMessage({ type: "output", text, level })} />;
}

function GameBenchmarkPage(props: BenchmarkPageInput) {
  const imageSteps = Object.keys(props.imageSetup?.steps || {}) as ImageBenchmarkStep[];
  const [part, setPart] = useState<"text" | "images">(props.initialPart === "images" && imageSteps.length ? "images" : "text");
  const [textStep, setTextStep] = useState<"translate" | "screen">("translate");
  const [imageStep, setImageStep] = useState<ImageBenchmarkStep>(imageSteps[0] || "recognize");
  const [running, setRunning] = useState(false);
  const drafts = useRef<Partial<Record<Target, QueueDraft>>>({});
  const step = part === "text" ? textStep : imageStep;
  return <GameTextBenchmarkDialog key={step} {...props} step={step} draft={drafts.current[step]}
    onDraft={draft => { drafts.current[step] = draft; }} onRunning={setRunning}
    targetControls={<div className="game-benchmark-toolbar game-benchmark-target">
      <label>测试内容<select value={part} disabled={running} onChange={event => setPart(event.target.value as typeof part)}>
        <option value="text">翻译文本</option>
        {imageSteps.length > 0 && <option value="images">图片翻译</option>}
      </select></label>
      <label>步骤{part === "text" ?
        <select value={textStep} disabled={running} onChange={event => setTextStep(event.target.value as typeof textStep)}>
          <option value="screen">筛选文本</option><option value="translate">翻译正文</option>
        </select> : <select value={imageStep} disabled={running} onChange={event => setImageStep(event.target.value as ImageBenchmarkStep)}>
          {imageSteps.map(id => <option key={id} value={id}>{imageBenchmarkSteps[id].title}</option>)}
        </select>}</label>
    </div>} />;
}

function GameTextBenchmarkDialog({ scope: textScope, current, screenModel, step, draft, onDraft, onRunning, targetControls,
  requestWorkload, requestSelection, requestImages, readImage, imageSetup, imageCount, selectedCount, models, onClose, onMessage, channel }:
  BenchmarkPageInput & { step: Target; draft?: QueueDraft; onDraft: (draft: QueueDraft) => void; onRunning: (running: boolean) => void; targetControls: ReactNode }) {
  const imageStep = step === "screen" || step === "translate" ? undefined : step;
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
    return { ...settings, ...(images ? { source: images.source, target: images.target, skipTarget: images.skipTarget,
      imageMode: imageStep === "refine" ? images.refineMode || "precise" : images.mode, imageStrategy: images.strategy, localLanes: imageStep === "refine" ? images.refineConcurrency || 2 : images.concurrency, imageConfidence: images.confidence, engines: images.engines } : {}),
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
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState("");
  const [results, setResults] = useState<BenchmarkResult[]>([]);
  const [history, setHistory] = useState<BenchmarkResult[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false), [historyError, setHistoryError] = useState("");
  const [historyRevision, setHistoryRevision] = useState(0);
  const [total, setTotal] = useState<number>();
  const [sampleSize, setSampleSize] = useState<number>();
  const [samplePreview, setSamplePreview] = useState<Record<string, BenchmarkSample>>({});
  const [checking, setChecking] = useState(false);
  const [selectionCount, setSelectionCount] = useState(imageStep ? imageCount ?? 0 : selectedCount);
  const abort = useRef<AbortController | undefined>(undefined);
  const work = useRef<Promise<void> | undefined>(undefined);
  const totalRounds = Number(rounds);
  const validRounds = Number.isInteger(totalRounds) && totalRounds >= 1 && totalRounds <= 100;
  const serialized = JSON.stringify({ configs, rounds: totalRounds });
  const canRun = configs.length > 0 && validRounds &&
    configs.every(config => {
      if (!config.models.text.id) return !requiresModel &&
        (step !== "translate" && step !== "imageTranslate" || !!(config.engines || images?.engines || current.engines)?.some(engine => engine.enabled));
      return roles.every(role => !config.models[role].id || models.includes(config.models[role].id));
    });
  useEffect(() => { onDraft({ configs, rounds }); }, [configs, rounds]);
  const saveQueue = (silent = false) => {
    if (!validRounds || serialized === savedQueue) return;
    localStorage.setItem(key, serialized);
    setSavedQueue(serialized);
    if (!silent) showAppNotice("测试队列已保存");
  };
  const toggleConfig = (id: string, open: boolean) => setExpanded(previous => {
    if (previous.has(id) === open) return previous;
    const next = new Set(previous);
    if (open) next.add(id); else next.delete(id);
    return next;
  });
  useEffect(() => {
    if (!channel) return () => abort.current?.abort();
    let disposed = false, closing = false, unlisten: (() => void) | undefined;
    const stop = async (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== "request" || message.kind !== "stop") return;
      abort.current?.abort();
      await work.current;
      await flushGamePerformanceArchive();
      channel.postMessage({ type: "response", id: message.id, value: true });
    };
    channel.addEventListener("message", stop);
    const window = getCurrentWindow();
    void window.onCloseRequested(async event => {
      event.preventDefault();
      if (closing) return;
      closing = true;
      try {
        abort.current?.abort();
        await work.current;
        await flushGamePerformanceArchive();
        channel.postMessage({ type: "performance", scope });
        await window.destroy();
      } catch (error) {
        closing = false;
        showAppNotice("关闭测试窗口失败：" + String(error), "error");
      }
    }).then(remove => { if (disposed) remove(); else unlisten = remove; }).catch(console.error);
    return () => { disposed = true; unlisten?.(); channel.removeEventListener("message", stop); abort.current?.abort(); };
  }, [channel, scope]);
  const runScope = scope + (imageStep ? ":benchmark:images" : ":benchmark:text");
  useEffect(() => {
    let active = true;
    setHistoryLoading(true); setHistoryError("");
    void readGameBenchmarkHistory(runScope, step).then(records => { if (active) setHistory(records); })
      .catch(error => { if (active) setHistoryError(String(error)); })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [runScope, step, historyRevision]);
  useEffect(() => {
    if (!channel || !running) return;
    const publish = () => channel.postMessage({ type: "performance", scope, step, value: {
      queue: stepPerformance(scope + ":benchmark-total", "queue"), run: stepPerformance(runScope, step),
    } });
    publish();
    window.addEventListener("llmchat-game-performance", publish);
    const timer = window.setInterval(publish, 1000);
    return () => {
      window.removeEventListener("llmchat-game-performance", publish);
      window.clearInterval(timer);
      channel.postMessage({ type: "performance", scope });
    };
  }, [channel, running, scope, step, runScope]);
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
  const start = () => {
    if (!canRun || abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true); onRunning(true); setResults([]); setTotal(undefined); setProgress(""); setStatus("正在准备测试…");
    const totalScope = scope + ":benchmark-total";
    const queue = structuredClone(configs).map(config => ({ ...config, engines: config.engines || (imageStep ? images?.engines : current.engines) }));
    const metadata = { part: imageStep ? "images" : "text", step, queueId: crypto.randomUUID(), rounds: totalRounds, configs: queue.length, selected: 0, runs: 0, failedRuns: 0, status: "运行中", detail: "" };
    const stepTitle = imageStep ? imageBenchmarkSteps[imageStep].title : step === "screen" ? "筛选文本" : "翻译文本";
    onMessage(`开始${stepTitle}性能测试 · ${queue.length} 个配置 · ${totalRounds} 轮`, "info");
    let timerStarted = false;
    work.current = (async () => {
      saveQueue(true);
      let workload: { entries: UnityEntry[]; selectedIds: Set<string>; dialoguePages?: GameDialoguePage[] } = { entries: [], selectedIds: new Set() };
      let target: { step: string; selected: number; run: BenchmarkStepRunner } | undefined;
      const onProgress = (value: UnityProgress) => setProgress(value.detail);
      if (imageStep && images) {
        const source = await requestImages();
        const sample = imageBenchmarkRows(imageStep, source.selected);
        if (!sample.length) throw new Error("所勾选的图片没有符合当前步骤的样本，请检查选择及前置结果。");
        setSelectionCount(source.selected.length);
        target = { step, selected: sample.length, run: (config, settings, runScope) => runGameImageSample(
          imageStep, sample, source, config, images, settings, runScope, controller.signal, readImage, onMessage, onProgress) };
      } else {
        const { entries, selected, dialoguePages } = await requestWorkload();
        if (!selected.length) throw new Error("请先勾选要测试的文本");
        setSelectionCount(selected.length);
        workload = { entries, selectedIds: new Set(selected.map(entry => entry.id)), dialoguePages };
        if (step === "screen") target = { step, selected: selected.length, run: (config, settings, runScope) =>
          runGameTextScreenSample(config, selected, settings, runScope, controller.signal, onMessage, onProgress) };
        if (step === "translate") {
          const preview = inspectBenchmarkSample(selected, queue);
          setSamplePreview(preview);
          if (queue.some(config => config.models.text.id && config.models.dialogue.id && config.models.dialogue.id !== config.models.text.id && !preview[config.id].dialogue)) {
            onMessage("测试样本没有可进入专用对白路线的条目，此轮不能用于比较对白模型。", "info");
          }
        }
      }
      controller.signal.throwIfAborted();
      metadata.selected = target?.selected ?? workload.selectedIds.size;
      setSampleSize(metadata.selected);
      clearGamePerformance(totalScope, ["queue"]);
      beginGameStep(totalScope, "queue", metadata);
      timerStarted = true;
      await runGameTextBenchmarks(queue, totalRounds, workload, runScope, metadata.queueId, controller.signal, onMessage,
        (round, config) => { setStatus("第 " + round + " / " + totalRounds + " 轮 · " + config.label); setProgress(""); },
        onProgress,
        result => { metadata.runs++; if (result.status === "失败") metadata.failedRuns++; setResults(previous => [...previous, result]); }, target);
      metadata.status = "队列完成"; setStatus(metadata.status);
    })().catch(error => {
      metadata.status = controller.signal.aborted ? "测试已中止" : "测试失败";
      metadata.detail = error instanceof Error ? error.message : String(error);
      setStatus(metadata.status);
      if (!controller.signal.aborted) setProgress(String(error));
    }).finally(() => {
      let elapsed: number | undefined;
      if (timerStarted) {
        finishGameStep(totalScope, true);
        elapsed = stepPerformance(totalScope, "queue").elapsedMs;
        setTotal(elapsed);
        clearGamePerformance(totalScope, ["queue"]);
      }
      onMessage(`${stepTitle}${metadata.status} · 已执行 ${metadata.runs}/${queue.length * totalRounds} 个配置轮次 · 失败配置 ${metadata.failedRuns}${elapsed === undefined ? "" : ` · 总用时 ${(elapsed / 1000).toFixed(2)} 秒`}${metadata.detail ? " · " + metadata.detail : ""}`, metadata.status === "测试失败" || metadata.failedRuns ? "error" : "info");
      updateBenchmarkWindowPerformance(scope);
      channel?.postMessage({ type: "performance", scope });
      setHistoryRevision(value => value + 1);
      abort.current = undefined; work.current = undefined; setRunning(false); onRunning(false);
    });
  };

  const currentIds = new Set(results.map(result => result.performance.taskId));
  const tasks = groupBenchmarkTasks([...results, ...history.filter(result => !currentIds.has(result.performance.taskId))]);
  const page = <main className={"game-benchmark-page" + (channel ? "" : " game-benchmark-browser-fallback")}>
    <header className="game-benchmark-page-header">
      <h2>测试队列</h2>
      {targetControls}
      <p className="hint">{running && sampleSize !== undefined ? "本次测试使用 " + sampleSize : "已勾选 " + selectionCount}{imageStep ? " 张图片" : " 条文本"}。测试结果独立归档。</p>
    </header>
    <section className="game-benchmark-scroll"><div className="game-text-benchmark">
      <div className="game-benchmark-toolbar">
        <label>循环轮次 <input type="number" min={1} max={100} step={1} value={rounds} disabled={running} onChange={event => setRounds(event.target.value)} /></label>
        <button type="button" className="unity-btn" disabled={running} onClick={() => {
          const config = capture(configs.length + 1);
          setConfigs(previous => [...previous, config]);
          toggleConfig(config.id, true);
        }}>加入当前配置</button>
        {step === "translate" && <button type="button" className="unity-btn" disabled={running || checking || !configs.length} onClick={() => void inspect()}>检查样本</button>}
      </div>
      {configs.map((config, index) => <details key={config.id} className="game-benchmark-item" open={expanded.has(config.id)}
        onToggle={event => toggleConfig(config.id, event.currentTarget.open)}>
        <summary>
          <strong>{config.label || "配置 " + (index + 1)}</strong>
          <span>{config.models.text.id ? config.models.text.id.split("/").at(-1) + " · 并发 " + config.models.text.lanes : requiresModel ? "未选模型" : localLabel}</span>
        </summary>
        <fieldset disabled={running} className="game-benchmark-item-fields">
        <div className="game-benchmark-toolbar">
          <input aria-label={"第 " + (index + 1) + " 项名称"} value={config.label} onChange={event => update(config.id, previous => ({ ...previous, label: event.target.value }))} />
          <button type="button" className="unity-btn" disabled={index === 0} onClick={() => move(index, index - 1)}>上移</button>
          <button type="button" className="unity-btn" disabled={index === configs.length - 1} onClick={() => move(index, index + 1)}>下移</button>
          <button type="button" className="unity-btn" onClick={() => setConfigs(previous => previous.filter(item => item.id !== config.id))}>移除</button>
        </div>
        {roles.filter(role => role === "text" || !!config.models.text.id).map(role => {
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
        {step === "recognize" && images?.confidence !== undefined && <div className="game-benchmark-toolbar"><label>置信度阈值（%）
          <input type="number" min={0} max={100} value={config.imageConfidence ?? images.confidence}
            onChange={event => update(config.id, previous => ({ ...previous, imageConfidence: Math.min(100, Math.max(0, Number(event.target.value))) }))} />
        </label></div>}
        <div className="game-benchmark-toolbar">
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
        </div>
        </fieldset>
        {samplePreview[config.id] && <p style={{ padding: "0 12px 8px" }}>
          共 {samplePreview[config.id].selected} 条 · 正文候选 {samplePreview[config.id].text} · 对白候选 {samplePreview[config.id].dialogue} · 原样保留 {samplePreview[config.id].retained}
          {config.models.dialogue.id && config.models.dialogue.id !== config.models.text.id && samplePreview[config.id].dialogue === 0 &&
            <strong> · 此样本测不到专用对白模型</strong>}
        </p>}
      </details>)}
      {status && <p role="status"><strong>{status}{total === undefined ? "" : " · 总用时 " + gameDuration(total)}</strong> {progress}</p>}
      <div className="game-benchmark-results" aria-label="测试记录">
        <header className="game-benchmark-records-head"><strong>测试记录 · {tasks.length} 个任务</strong>
          <button type="button" className="unity-btn" disabled={running || historyLoading} onClick={() => setHistoryRevision(value => value + 1)}>刷新</button></header>
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
    <button type="button" className="settings-panel-save" disabled={!running && !canRun} onClick={running ? () => abort.current?.abort() : start}>{running ? "中止测试" : "开始测试"}</button>
    <button type="button" className="unity-btn" disabled={running || !validRounds || serialized === savedQueue} onClick={() => { try { saveQueue(); } catch (error) { showAppNotice("测试队列保存失败：" + String(error), "error"); } }}>保存队列</button>
    <button type="button" className="unity-btn" onClick={() => { if (channel) onClose(); else if (running) { abort.current?.abort(); void work.current?.then(onClose); } else onClose(); }}>关闭</button>
    </footer>
  </main>;
  return channel ? page : createPortal(page, document.body);
}
