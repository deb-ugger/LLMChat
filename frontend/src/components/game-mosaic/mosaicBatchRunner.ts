import { mosaicRunImageOutcome } from "../../benchmark/formalRunHistory";
import { groupMosaicScenes, mosaicModelLabels, type MosaicBox, type MosaicScan } from "../../gameMosaic";
import { mosaicScreeningStatus, removeContainedMosaicBoxes, type MosaicInitialScreeningSnapshot } from "../../gameMosaicStatus";
import { matchesMosaicReviewKey } from "../../gameMosaicRefine";
import type { UnityImage } from "../../unityOffline";
import type { MosaicAutomaticPlan, MosaicAutomaticPorts, MosaicCandidate, MosaicBatchPorts, MosaicBatchStep, MosaicBatchWork,
  MosaicRedrawPorts, MosaicRedrawReference, MosaicRefinePlan, MosaicRefinePorts, MosaicReviewPlan, MosaicReviewPorts, MosaicScreenPlan,
  MosaicScreenPorts, MosaicStepUsage, RedrawPlan, RedrawStyle, RefineMovement, Result, Results, StepReport, StepRun } from "./mosaicWorkbenchTypes";

export function sameReview(row: Result, scan: MosaicScan, key: string) {
  const boxes = removeContainedMosaicBoxes(scan.review ? scan.reviewBoxes || scan.boxes : scan.boxes);
  return matchesMosaicReviewKey(row.refined, key) && !row.refineError && row.review === scan.review &&
    !!row.refineQuickExcluded === !!scan.quickExcluded && JSON.stringify(row.boxes) === JSON.stringify(boxes);
}

export const defaultResult = (image: UnityImage): Result => ({ source: image.sourceHash, boxes: [], checked: true });
export function resultFor(rows: Results, image: UnityImage) {
  const row = rows[image.id];
  return row?.source === image.sourceHash ? row : defaultResult(image);
}

export function restoreDefaultSelection(row: Result): Result {
  if (!row.review && row.manualChecked && !row.manualBoxes && !row.saved && row.refineMovement?.to === "review")
    row = { ...row, review: "候选区域待复核" };
  if (row.checked || row.manualChecked || row.manualBoxes || row.saved || row.discardedHash || row.refined || row.refineError)
    return row;
  const checked = !row.scanned || (!row.reason && (row.boxes.length > 0 || !!row.review));
  return checked ? { ...row, checked } : row;
}

function rememberInitialScreening(row: Result): MosaicInitialScreeningSnapshot {
  const { boxes, checked, scanned, detector, reason, review } = row;
  return row.beforeRefine ?? { boxes, checked, scanned, detector, reason, review };
}

function attachRefineMovement(before: Result, after: Result): Result {
  const initial = rememberInitialScreening(before);
  return { ...after, beforeRefine: initial, refineMovement: {
    from: mosaicScreeningStatus(initial),
    to: mosaicScreeningStatus(after),
    checkedBefore: initial.checked,
    checkedAfter: after.checked,
  } };
}

export function refineMovementFor(row: Result): RefineMovement | undefined {
  const movement = row.refineMovement;
  if (movement) {
    if (row.refineError && movement.to !== "failed") return { ...movement, to: "failed" };
    // Older projects recorded a successful positive review as a candidate.
    return movement.to === "candidate" && row.refined ? { ...movement, to: "refinedCandidate" } : movement;
  }
  if (row.beforeRefine && (row.refined || row.refineError) && !row.saved)
    return attachRefineMovement(row, row).refineMovement;
}

export function reviewedResult(row: Result, scan: MosaicScan, reviewKey: string): Result {
  return attachRefineMovement(row, { ...row,
    boxes: removeContainedMosaicBoxes(scan.review ? scan.reviewBoxes || scan.boxes : scan.boxes),
    checked: row.manualChecked ? row.checked : !!scan.boxes.length && !scan.review,
    refined: reviewKey, refineMovement: undefined, refineQuickExcluded: scan.quickExcluded, manualStatus: undefined,
    reason: undefined, refineError: undefined, redrawError: undefined, review: scan.review });
}

export function clearReviewResult(row: Result): Result {
  const hadLegacyError = row.scanned && !!row.reason;
  if (row.saved || !(row.beforeRefine || row.refined || row.refineError || hadLegacyError)) return row;
  const { beforeRefine, refineMovement, refined, refineError, refineQuickExcluded, ...rest } = row;
  if (!beforeRefine || row.manualBoxes) {
    return restoreDefaultSelection({ ...rest,
      reason: hadLegacyError ? undefined : row.reason,
      review: refined && row.review && !row.manualBoxes ? "候选区域待复核" : row.review,
    });
  }
  return restoreDefaultSelection({ ...rest, ...beforeRefine,
    scanned: beforeRefine.scanned, detector: beforeRefine.detector, reason: beforeRefine.reason,
    checked: row.manualChecked ? row.checked : beforeRefine.checked,
    review: beforeRefine.review });
}

export function keepText(image: UnityImage, protect: boolean): MosaicBox[] {
  if (!protect) return [];
  return image.regions.filter(region => region.text.trim() && Number.isFinite(region.x0 + region.x1 + region.y0 + region.y1))
    .map((region): MosaicBox => [Math.max(0, Math.floor(region.x0)), Math.max(0, Math.floor(region.y0)),
      Math.min(image.width, Math.ceil(region.x1)), Math.min(image.height, Math.ceil(region.y1))])
    .filter(([left, top, right, bottom]) => left < right && top < bottom);
}

export async function runMosaicBatch(label: string, work: MosaicBatchWork, step: MosaicBatchStep | undefined, ports: MosaicBatchPorts) {
  const { setProgressStep, setStepRuns, setProgress, setError } = ports;
  if (ports.blocked()) return;
  const controller = new AbortController();
  ports.start(controller, step?.id);
  const batchStarted = performance.now();
  const elapsedBefore = step ? ports.resumableElapsed(step) : 0;
  const started = batchStarted - elapsedBefore;
  setProgressStep(step?.id);
  if (step) setStepRuns(previous => ({ ...previous, [step.id]: {
    state: "running", completed: step.completed ?? 0, total: step.total, summary: step.summary, parameters: step.parameters, started, batchStarted,
  } }));
  ports.setRunning(label);
  const updateStep = (edit: Partial<StepRun>) => {
    if (!step) return;
    setStepRuns(previous => {
      const current = previous[step.id];
      return current ? { ...previous, [step.id]: { ...current, ...edit } } : previous;
    });
  };
  let usage: MosaicStepUsage | undefined;
  let state: StepRun["state"] = "error";
  let failureDetail: string | undefined;
  try {
    if (step) {
      usage = ports.beginUsage(step,
        () => { if (usage) updateStep(usage.snapshot()); });
      usage.refresh();
    }
    const completed = await work(controller.signal, progress => {
      const counts = typeof progress === "number" ? { completed: progress } : progress;
      const itemsDone = counts.processed ?? counts.completed;
      if (itemsDone !== undefined) usage?.recordItems(itemsDone, counts.failed);
      updateStep({ ...usage?.snapshot(), ...counts });
    }, usage);
    const stopped = controller.signal.aborted && !(step?.id === "redraw" && completed === true);
    if (stopped) setProgress("已停止后续任务");
    state = stopped ? "stopped" : completed === false ? "error" : "done";
  } catch (cause) {
    if (!controller.signal.aborted) {
      failureDetail = cause instanceof Error ? cause.message : String(cause);
      setError(failureDetail);
    }
    else setProgress("已停止后续任务");
    state = controller.signal.aborted ? "stopped" : "error";
  } finally {
    const ended = performance.now();
    try {
      await usage?.finish(state === "done", state === "error", failureDetail);
      updateStep({ ...usage?.snapshot(), state, elapsed: ended - started, batchElapsed: ended - batchStarted });
    } finally { ports.finish(); }
  }
}

export function stopMosaicBatch(controller: AbortController | null, setProgress: (message: string) => void) {
  controller?.abort();
  setProgress("正在保存进度并停止后续任务");
}

export async function runMosaicScreen(plan: MosaicScreenPlan, signal: AbortSignal, report: (progress: StepReport) => void,
  usage: MosaicStepUsage | undefined, ports: MosaicScreenPorts) {
  const { targets, usable, rows, initial, detectorKind, detectorKey, detectorFile, modelName, concurrency } = plan;
  const { replaceRows, setRows, clearReviews, resetRedraw, read, prepareSources, loadMosaicDetector, createMosaicGridScanner, setProgress, onDevice } = ports;

  const fresh = { ...rows };
  const ids = new Set(targets.map(image => image.id));
  for (const image of targets) {
    const row = clearReviewResult(resultFor(rows, image));
    fresh[image.id] = row.saved ? row : { ...row, scanned: false, reason: undefined };
  }
  replaceRows(fresh);
  clearReviews([...ids]);
  resetRedraw(ids);
  const lanes = Math.min(targets.length, Math.max(1, Math.min(4, concurrency ?? 2)));
  const detector = detectorKind !== "grid" ? await loadMosaicDetector(detectorFile, {
    initialScreening: true, screening: plan.screening, maxConcurrency: lanes,
    signal, timingScope: usage?.scope,
    onDevice,
  }) : undefined;
  let batch: Results = {};
  let cursor = 0, completed = initial, failures = 0;
  const reportBatch = () => report({ completed, processed: completed - initial, failed: failures });
  let lastReport = 0;
  const checkpoint = () => {
    const changes = batch;
    batch = {};
    setRows(previous => ({ ...previous, ...changes }));
  };
  async function lane() {
    const scanner = detector ?? createMosaicGridScanner();
    try {
      while (!signal.aborted && cursor < targets.length) {
        const start = cursor;
        cursor += prepareSources ? 16 : 1;
        const next = targets.slice(start, cursor);
        const errors: Record<string, string> = prepareSources ? await prepareSources(next, signal) : {};
        for (const image of next) {
          if (signal.aborted) break;
          const old = resultFor(fresh, image);
          try {
            const prepareError = errors[image.id];
            if (prepareError) throw new Error(prepareError);
            const input = await read(image, signal);
            if (signal.aborted) break;
            const scan = await usage!.measure(modelName, lanes, () => scanner.scan(input));
            usage?.recordImage?.(image.id, mosaicRunImageOutcome(scan, false));
            const { signature } = scan;
            const boxes = removeContainedMosaicBoxes(scan.boxes.length ? scan.boxes : scan.reviewBoxes || []);
            batch[image.id] = { ...old, boxes: old.manualBoxes || old.saved ? old.boxes : boxes,
              checked: old.manualChecked || old.manualBoxes || old.saved ? old.checked : boxes.length > 0 || !!scan.review,
              signature: btoa(String.fromCharCode(...signature)), detector: detectorKey, scanned: true, beforeRefine:undefined, refineMovement:undefined, refined:undefined, refineQuickExcluded:undefined, refineError:undefined, redrawError:undefined, reason: undefined, manualStatus: undefined, review: old.manualBoxes || old.saved ? undefined : scan.review };
          } catch (cause) {
            if (signal.aborted) break;
            failures++;
            const reason = cause instanceof Error ? cause.message : String(cause);
            usage?.recordImage?.(image.id, mosaicRunImageOutcome(undefined, false, reason));
            batch[image.id] = { ...old, scanned: false, manualStatus: undefined, reason };
          }
          completed++;
          if ((completed - initial) % 64 === 0) checkpoint();
          const now = performance.now();
          if (now - lastReport >= 150) {
            reportBatch();
            setProgress(image.name);
            lastReport = now;
          }
        }
      }
    } finally { if (!detector) await scanner.release(); }
  }
  try {
    const settled = await Promise.allSettled(Array.from({ length: lanes }, lane));
    for (const item of settled) if (item.status === "rejected") throw item.reason;
  } finally {
    checkpoint();
    reportBatch();
    await detector?.release();
  }
  setRows(previous => {
    const next = { ...previous };
    const proposals = groupMosaicScenes(usable.flatMap(image => {
      const row = resultFor(next, image);
      if (!row.signature || row.manualGroup || row.saved || row.reference) return [];
      const signature = typeof row.signature === "string" ? Array.from(atob(row.signature), c => c.charCodeAt(0)) : row.signature;
      return [{ ...image, signature }];
    }));
    for (const list of proposals) for (const image of list) next[image.id] = { ...next[image.id], group: "scene-" + list[0].id };
    return next;
  });
  setProgress([failures ? failures + " 张筛选失败，详情见「处理失败」分组。" : "", detector?.reused ? "已复用 " + detector.reused + " 张相同图片的检测结果" : ""].filter(Boolean).join(" · "));
  return failures === 0;
}

export async function performMosaicReviews(plan: MosaicReviewPlan, signal: AbortSignal,
  report: ((completed: number, detail: string) => void) | undefined, ports: MosaicReviewPorts) {
  const { targets, rows, gamePath, preferences, reviewKey, detectorFile, restart, automatic, metrics, deploymentScope } = plan;
  const { read, prepareSources, refineBatch, readMosaicReviews, setRows, setRefineRetries, gameStepSelections, prepareRequest, request } = ports;
  const reviewSettings = automatic ? { ...preferences, refineScope: preferences.refineIncludeMissed ? "all" as const : "suspected" as const } : preferences;
  const cached = automatic && !restart ? readMosaicReviews(gamePath,reviewKey) : undefined;
  const isCached = (image: UnityImage) => {
    const old = cached?.[image.id];
    return old?.source === image.sourceHash && !(reviewSettings.refineScope === "all" && old.scan.quickExcluded);
  };
  const ownedUsage = !deploymentScope && !metrics?.usage && targets.some(image => !isCached(image))
    ? ports.beginUsage(!restart) : undefined;
  const usage = metrics?.usage ?? ownedUsage;
  let processed = 0, failures = 0;
  const timingScope = deploymentScope ?? usage?.scope;
  const selections = timingScope && gameStepSelections(timingScope, deploymentScope ? "mosaic" : "refine");
  const retries = new Map((restart ? [] : targets).filter(image => !!resultFor(rows, image).refineError)
    .map(image => [image.id, image.sourceHash]));
  if (retries.size) setRefineRetries(retries);
  const finishRetry = (image: UnityImage) => {
    if (retries.get(image.id) !== image.sourceHash) return;
    setRefineRetries(previous => {
      const next = new Map(previous);
      next.delete(image.id);
      return next;
    });
  };
  let succeeded = false;
  try {
    const result = await refineBatch(targets, {
      root: gamePath, settings: reviewSettings, signal, modelFile: detectorFile, read, prepare: prepareSources, restart, timingScope, prepareRequest,
      request: (model, prompt, image, signal, lanes) => request(model, prompt, image, signal, selections ? selections(lanes) : undefined)
        .finally(() => usage?.refresh()),
      onResult: (image, scan) => {
        usage?.recordImage?.(image.id, mosaicRunImageOutcome(scan, true));
        setRows(previous => {
          const old = resultFor(previous, image);
          if (old.manualBoxes || old.saved || sameReview(old, scan, reviewKey)) return previous;
          return { ...previous, [image.id]: reviewedResult(old, scan, reviewKey) };
        });
        finishRetry(image);
        if (ownedUsage && !isCached(image)) ownedUsage.recordItems(++processed, failures);
      },
      onError: (image, error) => {
        usage?.recordImage?.(image.id, mosaicRunImageOutcome(undefined, true, error));
        metrics?.onFailure();
        if (ownedUsage) { failures++; ownedUsage.recordItems(++processed, failures); }
        setRows(previous => {
          const row = resultFor(previous, image);
          return { ...previous, [image.id]: attachRefineMovement(row, { ...row,
            refineError: error, refined: undefined, refineQuickExcluded: undefined }) };
        });
        finishRetry(image);
      },
      onProgress: report,
      onPreparation: metrics?.onPreparation,
    });
    succeeded = result.failed === 0;
    return result;
  } finally {
    if (retries.size) setRefineRetries(new Map());
    await ownedUsage?.finish(succeeded);
  }
}

export async function runMosaicRefine(plan: MosaicRefinePlan, signal: AbortSignal, report: (progress: StepReport) => void,
  usage: MosaicStepUsage | undefined, ports: MosaicRefinePorts) {
  const { targets, rows, restart, initial, previousReview, checkedReviewScope, reviewSessionKey } = plan;
  const { replaceRows, clearReviews, resetRedraw, performReviews, setProgress, setError, trackReview } = ports;

  const tracked = restart ? new Map<string, string>() : new Map(previousReview?.images);
  for (const image of checkedReviewScope) tracked.set(image.id, image.sourceHash);
  trackReview({ key: reviewSessionKey, images: tracked });
  if (restart) {
    const next = { ...rows };
    const ids = new Set(targets.map(image => image.id));
    for (const image of targets) next[image.id] = clearReviewResult(resultFor(rows, image));
    replaceRows(next);
    clearReviews([...ids]);
    resetRedraw(ids);
  }
  let completed = 0, failed = 0;
  const reportBatch = () => report({ completed: initial + completed, processed: completed + failed, failed });
  const result = await performReviews(targets,signal,(count,detail)=>{
    completed = count;
    reportBatch();
    setProgress(detail);
  },restart,false,{
    onPreparation: prepared => report({ prepared: initial + prepared }),
    onFailure: () => { failed++; reportBatch(); },
    usage,
  });
  const uncertain=[...result.results.values()].filter(scan=>scan.review).length;
  setProgress("本轮复筛结束 · "+uncertain+" 张待人工确认");
  if (result.failed) setError(result.failed + " 张复筛失败，详情见「处理失败」分组");
  return !result.failed;
}

export function assignMosaicRedrawReference(rows: Results, images: readonly UnityImage[], reference: UnityImage) {
  const chosen = resultFor(rows, reference);
  if (!chosen.saved) throw new Error("请先采用去码图，再设为画风参考");
  const group = chosen.group || reference.id;
  const next = { ...rows };
  for (const image of images) {
    const row = resultFor(rows, image);
    if ((row.group || image.id) !== group) continue;
    next[image.id] = { ...row, group, manualGroup: true, reference: image.id === reference.id };
  }
  return next;
}

export function mosaicRedrawReferences(images: readonly UnityImage[], rows: Results) {
  const references = new Map<string, UnityImage>();
  for (const image of images) {
    const row = resultFor(rows, image);
    const group = row.group || image.id;
    if (row.saved && row.reference && !references.has(group)) references.set(group, image);
  }
  return references;
}

export function mosaicRedrawStyle(image: UnityImage, rows: Results, references: ReadonlyMap<string, UnityImage>): RedrawStyle {
  const group = resultFor(rows, image).group || image.id;
  const seed = parseInt(group.replace(/[^a-f0-9]/gi, "").slice(-8) || "1", 16);
  return { group, seed, reference: references.get(group) };
}

function createMosaicReferenceReader(readSaved: (image: UnityImage, signal: AbortSignal) => Promise<Blob>, signal: AbortSignal) {
  const cache = new Map<string, Promise<Blob>>();
  return (reference: UnityImage) => {
    const key = JSON.stringify([reference.id, reference.sourceHash]);
    let loading = cache.get(key);
    if (!loading) {
      loading = readSaved(reference, signal).catch(error => {
        signal.throwIfAborted();
        throw new Error("读取画风参考失败 · " + reference.name + " · " + (error instanceof Error ? error.message : String(error)));
      });
      cache.set(key, loading);
    }
    return loading;
  };
}

export function automaticMosaicRedrawStyle(usable: readonly UnityImage[], rows: Results,
  readSaved: (image: UnityImage, signal: AbortSignal) => Promise<Blob>, signal: AbortSignal) {
  const references = mosaicRedrawReferences(usable, rows);
  const readReference = createMosaicReferenceReader(readSaved, signal);
  return async (image: UnityImage): Promise<{ seed: number; reference?: Blob }> => {
    const style = mosaicRedrawStyle(image, rows, references);
    if (!style.reference || style.reference.id === image.id) return { seed: 1 };
    return { seed: style.seed, reference: await readReference(style.reference) };
  };
}

export function existingMosaicRedrawReferences(images: readonly UnityImage[], rows: Results,
  candidates: Readonly<Record<string, MosaicCandidate>>, model: RedrawPlan["models"][number]) {
  const ready = new Set<string>();
  const references = new Map<string, MosaicRedrawReference>();
  for (const image of images) {
    const row = resultFor(rows, image);
    if (!row.checked) continue;
    const candidate = candidates[image.id];
    const confirmed = row.manualStatus === "refinedCandidate" ||
      (!row.manualStatus && (row.manualBoxes || mosaicScreeningStatus(row) === "refinedCandidate"));
    const blob = confirmed && candidate?.revision === image.sourceHash
      ? (candidate.versions.filter(version => version.model === model).at(-1) ?? candidate.versions.at(-1))?.blob : undefined;
    if (!row.saved && !blob) continue;
    const reuse: MosaicRedrawReference = row.saved
      ? { image, source: "adopted", boxes: row.boxes }
      : { image, source: "candidate", boxes: row.boxes, blob };
    ready.add(image.id);
    const group = row.group || image.id;
    const previous = references.get(group);
    if (!previous || (row.saved && (row.reference || previous.source === "candidate"))) references.set(group, reuse);
  }
  return { ready, references };
}

export function canResumeMosaicRedraw(plan: RedrawPlan, usable: readonly UnityImage[], rows: Results, protect: boolean) {
  const current = new Map(usable.map(image => [image.id, image]));
  const references = mosaicRedrawReferences(usable, rows);
  const targetIds = new Set(plan.targets.map(target => target.image.id));
  return plan.targets.every(({ image, boxes, keep, style }) => {
    const latest = current.get(image.id);
    if (latest?.sourceHash !== image.sourceHash) return false;
    const latestStyle = mosaicRedrawStyle(latest, rows, references);
    const automatic = plan.groupReferences?.get(style.group);
    const referenceImage = automatic && current.get(automatic.image.id);
    const referenceRow = referenceImage && resultFor(rows, referenceImage);
    const referenceUnchanged = automatic ? automatic.source === "generate" ? targetIds.has(automatic.image.id)
      : referenceImage?.sourceHash === automatic.image.sourceHash && !!referenceRow?.checked &&
        (referenceRow.group || referenceImage.id) === style.group && JSON.stringify(referenceRow.boxes) === JSON.stringify(automatic.boxes) &&
        (automatic.source !== "adopted" || referenceRow.saved)
      : latestStyle.reference?.id === style.reference?.id && latestStyle.reference?.sourceHash === style.reference?.sourceHash;
    return latestStyle.group === style.group && referenceUnchanged &&
      JSON.stringify(resultFor(rows, latest).boxes) === JSON.stringify(boxes) &&
      JSON.stringify(keepText(latest, protect)) === JSON.stringify(keep);
  });
}

export function mosaicRedrawStepCount(plan: Pick<RedrawPlan, "models" | "steps">, engine: RedrawPlan["models"][number]) {
  return plan.models.length === 1 ? plan.steps : engine === "turbo" ? 8 : 20;
}

export async function runMosaicRedraw(plan: RedrawPlan, initial: number, signal: AbortSignal, report: (progress: StepReport) => void,
  usage: MosaicStepUsage | undefined, ports: MosaicRedrawPorts) {
  const { read, readSaved, mosaicInputKey, redrawMosaic, recordGameCacheHit, update, setProgress, setError, setPending, onCandidate } = ports;
  const total = plan.targets.length;
  let completed = initial;

  await setPending(plan);
  const readReference = createMosaicReferenceReader(readSaved, signal);
  const cache = new Map<string, { blob: Blob; seconds: number }>();
  const failures = new Set<string>();
  let waitingForReference = 0;
  const reportFailure = (image: UnityImage, detail: string) => {
    failures.add(image.id);
    usage?.recordImage?.(image.id, mosaicRunImageOutcome(undefined, false, detail));
    update(image, { redrawError: detail });
    report({ completed, processed: completed - initial + failures.size, failed: failures.size });
  };
  for (const { image, boxes, keep, pending, style, promptIds } of plan.targets) {
    if (!pending.size) continue;
    signal.throwIfAborted();
    const automatic = plan.groupReferences?.get(style.group);
    const isAnchor = automatic?.source === "generate" && automatic.image.id === image.id;
    if (automatic?.source === "generate" && !isAnchor && !automatic.blob) {
      waitingForReference++;
      continue;
    }
    try {
      const original = await read(image, signal);
      const input = await mosaicInputKey(original, boxes);
      const referenceImage = automatic?.source === "adopted" ? automatic.image
        : !automatic && style.reference?.id !== image.id ? style.reference : undefined;
      const referenceKey = automatic ? [automatic.source, style.group, automatic.image.id, isAnchor]
        : referenceImage && [referenceImage.id, referenceImage.sourceHash];
      const reference = isAnchor ? undefined : automatic?.blob ?? (referenceImage ? await readReference(referenceImage) : undefined);
      for (const engine of pending) {
        signal.throwIfAborted();
        const title = image.name + " · " + mosaicModelLabels[engine] +
          (automatic ? (isAnchor ? " · 生成本组参考" : " · 按本组参考重绘") : "");
        setProgress(title);
        const stepCount = mosaicRedrawStepCount(plan, engine);
        const key = JSON.stringify([engine, stepCount, input, keep, style.seed, referenceKey]);
        const promptId = promptIds?.[engine];
        let outcome = cache.get(key);
        if (!outcome) {
          const start = performance.now();
          try {
            const blob = await usage!.measure(mosaicModelLabels[engine], 1, () => redrawMosaic({
              source: original, boxes, keep, model: engine, steps: stepCount, seed: style.seed, signal, reference,
              keepResultOnStop: true, promptId, timingScope: usage?.scope,
              progress: detail => setProgress(title + " · " + detail),
            }));
            usage!.refresh();
            outcome = { blob, seconds: (performance.now() - start) / 1000 };
            cache.set(key, outcome);
          } catch (cause) {
            if (signal.aborted) throw cause;
            reportFailure(image, mosaicModelLabels[engine] + " · " + (cause instanceof Error ? cause.message : String(cause)));
            continue;
          }
        } else recordGameCacheHit(usage?.scope);
        const { blob, seconds } = outcome;
        await onCandidate(image, { id: promptId ?? crypto.randomUUID(), model: engine, blob, seconds,
          boxes, keep, referenceGroup: plan.referenceGuide ? style.group : undefined });
        if (isAnchor) automatic.blob = blob;
        pending.delete(engine);
        if (!pending.size) {
          completed++;
          usage?.recordImage?.(image.id, { category: "已生成去码候选", boxes, status: "完成" });
          update(image, { redrawError: undefined });
          report({ completed, processed: completed - initial + failures.size, failed: failures.size });
        }
      }
    } catch (cause) {
      if (signal.aborted) throw cause;
      reportFailure(image, cause instanceof Error ? cause.message : String(cause));
    }
  }
  if (completed === total) await setPending(null);
  setProgress("");
  if (failures.size || waitingForReference) setError([
    failures.size ? failures.size + " 张重绘失败，详情见「处理失败」分组" : "",
    waitingForReference ? waitingForReference + " 张等待本组首图，继续重绘时会先重试首图" : "",
  ].filter(Boolean).join(" · "));
  return completed === total;
}

export async function runAutomaticMosaic(plan: MosaicAutomaticPlan, signal: AbortSignal, ports: MosaicAutomaticPorts) {
  const { selected, scoped, usable, rows, detectorKey, protect, refine, model, steps, timingScope } = plan;
  const { read, readSaved, performReviews, openDetector, savedMosaicScan, redrawMosaic, reportGameStepItems, recordGameCacheHit, measureGameAsync, update, setProgress, clearReviews } = ports;

  const ids = new Set(selected.map(image => image.id));
  const existing = await ports.readExisting(signal);
  for (const image of usable) {
    const row = resultFor(rows, image);
    if (existing[image.id] === image.sourceHash && row.discardedHash !== image.sourceHash && !(row.manualChecked && !row.checked))
      ids.add(image.id);
  }
  const unscreened = scoped.filter(image => !ids.has(image.id) && !(resultFor(rows, image).manualChecked && !resultFor(rows, image).checked));
  if (!unscreened.length) return [...ids];
  const reviews = refine !== false ? await performReviews(unscreened.filter(image => !resultFor(rows,image).manualBoxes),
    signal, (_completed, detail) => setProgress(detail), false, true, undefined, timingScope) : undefined;
  if (reviews?.failed) {
    reportGameStepItems(timingScope, "mosaic", reviews.results.size + reviews.failed, reviews.failed);
    throw new Error(reviews.failed + " 张图片复筛失败");
  }
  let detector: Awaited<ReturnType<typeof openDetector>> | undefined;
  const rescreened = new Set<string>();
  const redrawStyle = automaticMosaicRedrawStyle(usable, rows, readSaved, signal);
  try {
    for (const [index, image] of unscreened.entries()) {
      signal.throwIfAborted();
      reportGameStepItems(timingScope, "mosaic", index);
      const row = resultFor(rows, image);
      const readSource = () => measureGameAsync(timingScope, "processingMs", () => read(image, signal));
      let source: Blob | undefined;
      const cached = savedMosaicScan(row, detectorKey);
      let scan = reviews?.results.get(image.id) ?? cached;
      if (scan && scan === cached) recordGameCacheHit(timingScope);
      if (!scan) {
        try {
          detector ??= await openDetector(signal, timingScope);
          source = await readSource();
          const imageSource = source;
          scan = await measureGameAsync(timingScope, "processingMs", () => detector!.scan(imageSource));
        } catch (error) {
          if (!signal.aborted) update(image, { scanned: false, reason: error instanceof Error ? error.message : String(error) });
          throw error;
        }
        rescreened.add(image.id);
        update(image, { scanned: true, detector: detectorKey, review: scan.review,
          boxes: removeContainedMosaicBoxes(scan.review ? scan.reviewBoxes || scan.boxes : scan.boxes),
          reason: undefined, refineError: undefined, refined: undefined, refineQuickExcluded: undefined,
          beforeRefine: undefined, refineMovement: undefined, manualStatus: undefined });
      }
      if (scan.review && !row.manualChecked) {
        update(image, { review: scan.review, boxes: removeContainedMosaicBoxes(scan.reviewBoxes || []), checked: false });
        throw new Error(image.name + " · " + scan.review);
      }
      const boxes = removeContainedMosaicBoxes(scan.boxes);
      if (!boxes.length) continue;
      try {
        const style = await redrawStyle(image);
        const rendered = await redrawMosaic({ source: source ?? await readSource(), boxes, keep: keepText(image, protect), model, steps,
          ...style, signal, timingScope, progress: setProgress });
        await measureGameAsync(timingScope, "saveMs", async () =>
          ports.writeCandidate(image, rendered, signal));
      } catch (error) {
        if (!signal.aborted) update(image, { redrawError: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      ids.add(image.id);
      update(image, { boxes, saved: true, checked: true, discardedHash: undefined, redrawError: undefined });
    }
    reportGameStepItems(timingScope, "mosaic", unscreened.length, 0);
    return [...ids];
  } finally {
    try { if (rescreened.size) clearReviews([...rescreened]); }
    finally { await detector?.release(); }
  }
}
