import { resourceDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { showAppNotice } from "../components/AppNotice";
import type { useGameActionConfirm } from "../components/GameActionConfirm";
import {
  gameImageExportApi, pollGameImageExport, type GameImageExportGenerateResult, type GameImageExportImageSelection,
  type GameImageExportOperationStatus, type GameImageExportQueued, type GameImageExportReceiptStatus,
  type GameImageExportKind, type GameImageExportLayerStates, type GameImageExportReceiptState, type GameImageExportTerminalStatus,
} from "../gameImageExport";

export type ImageExportCandidate = { imageId: string; sourceHash: string; renderedHash?: string };
type ExportSource = ImageExportCandidate & { mosaic: boolean };
type ConfirmationSelection = { images: GameImageExportImageSelection[]; needsConfirmation: number; bytes?: number };
type ExportJobKind = "generate" | "apply" | "restore";
type ExportJob = { kind: ExportJobKind; id: string; selectionKey?: string; reapply?: boolean };
type ExportRecord = { package?: GameImageExportGenerateResult; selectionKey?: string; pending?: ExportJob; outputDir?: string; targetChanged?: boolean };
type PackageDisposition = Pick<GameImageExportReceiptStatus, "canRestore" | "needsRecovery" | "layerRestoreSupported" | "layers">;
type PackageReceipt = { path: string; state?: GameImageExportReceiptState; status?: PackageDisposition; bytes?: number };
const hasAppliedImages = (state?: GameImageExportReceiptState) => state === "applied" || state === "partiallyRestored";
const unusedPackage: PackageDisposition = {
  canRestore: false, needsRecovery: false, layerRestoreSupported: false, layers: {},
};
const targetChangedHint = "游戏里的图片已被改动，需要重新生成";
const migrationHint = "建议先恢复旧图片补丁，再用成品包重新应用。";

function exportSources(candidates: readonly ImageExportCandidate[], mosaicIds: readonly string[]): ExportSource[] {
  const mosaics = new Set(mosaicIds);
  return candidates.map(image => ({ ...image, mosaic: mosaics.has(image.imageId) }))
    .filter(row => row.mosaic || row.renderedHash !== undefined);
}

export type ImageExportPackage = {
  confirmed: number;
  needsConfirmation: number;
  path: string;
  bytes?: number;
  targetChanged: boolean;
  applied: boolean;
  partiallyRestored: boolean;
  layers: GameImageExportLayerStates;
  layerRestoreSupported: boolean;
  legacyInstalled: boolean;
  needsRecovery: boolean;
  used: boolean;
  canRestore: boolean;
  canGenerate: boolean;
  canUsePackage: boolean;
  activity: ExportJobKind | "remove" | null;
  percent: number | null;
  canCancel: boolean;
  cancelling: boolean;
};

export type ImageExportActions = {
  generate: () => void;
  cancel: () => void;
  apply: () => void;
  restore: (kind?: GameImageExportKind) => void;
  remove: () => void;
  openDirectory: () => void;
};

type Options = {
  gamePath: string;
  active: boolean;
  locked: boolean;
  candidates: readonly ImageExportCandidate[];
  mosaicIds: readonly string[];
  onBusyChange: (busy: boolean) => void;
  confirm: ReturnType<typeof useGameActionConfirm>["confirm"];
  legacyRevision: string;
};

function notify(cause: unknown) {
  showAppNotice(cause instanceof Error ? cause.message : String(cause), "error");
}

const code = (cause: unknown) => (cause as { code?: string } | null)?.code;

function readRecord(key: string): ExportRecord {
  try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; }
  catch { return {}; }
}

async function withExportLockRetry<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await read(); }
    catch (cause) {
      if (code(cause) !== "BUSY" || attempt === 2) throw cause;
      await new Promise(resolve => window.setTimeout(resolve, 200));
    }
  }
}

async function readConfirmations(gamePath: string, sources: ExportSource[], signal: AbortSignal, sizePath?: string): Promise<ConfirmationSelection> {
  const images: GameImageExportImageSelection[] = [];
  let needsConfirmation = 0;
  let bytes: number | undefined;
  const lookup = async (imageId: string, layer: "translation" | "mosaic") => {
    const packagePath = sizePath;
    sizePath = undefined;
    const status = await withExportLockRetry(() =>
      gameImageExportApi.confirmationStatus({ gamePath, imageId, layer, packagePath }, signal), signal);
    if (packagePath) bytes = status.bytes;
    return status;
  };
  // Confirmation reads take the same per-game directory lock as export operations.
  for (const { imageId, sourceHash, renderedHash, mosaic } of sources) {
    if (renderedHash === "") { needsConfirmation++; continue; }
    const translation = renderedHash ? await lookup(imageId, "translation") : undefined;
    if (translation && (translation.state !== "confirmed" || translation.candidateVersion !== renderedHash)) {
      needsConfirmation++;
      continue;
    }
    const mosaicStatus = mosaic ? await lookup(imageId, "mosaic") : undefined;
    if (mosaicStatus && mosaicStatus.state !== "confirmed") { needsConfirmation++; continue; }
    const repair = mosaicStatus?.state === "confirmed" ? { confirmationId: mosaicStatus.confirmationId, pngSha256: mosaicStatus.pngSha256 } : undefined;
    if (translation?.state === "confirmed" && renderedHash)
      images.push({ imageId, sourceHash, translation: { confirmationId: translation.confirmationId, renderedHash }, mosaic: repair });
    else if (repair) images.push({ imageId, sourceHash, mosaic: repair });
  }
  return { images, needsConfirmation, bytes };
}

async function readDisposition(gamePath: string, packagePath: string, signal: AbortSignal): Promise<PackageReceipt> {
  try {
    const { receipt, bytes, canRestore, needsRecovery, layerRestoreSupported, layers } = await withExportLockRetry(() =>
      gameImageExportApi.queryReceipt({ gamePath, packagePath }, signal), signal);
    return { path: packagePath, state: receipt.state, bytes, status: { canRestore, needsRecovery, layerRestoreSupported, layers } };
  } catch (cause) {
    if (code(cause) !== "RECEIPT_NOT_FOUND") throw cause;
    const status = (cause as { response?: Partial<GameImageExportReceiptStatus> }).response;
    return { path: packagePath, bytes: status?.bytes, status: { ...unusedPackage, needsRecovery: !!status?.needsRecovery, canRestore: !!status?.canRestore } };
  }
}

export function useGameImageExportPackage({ gamePath, active, locked, candidates, mosaicIds, onBusyChange, confirm, legacyRevision }: Options) {
  const storageKey = "llmchat-game-image-export:" + gamePath.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const [record, setRecord] = useState(() => readRecord(storageKey));
  const latest = useRef(record);
  const persist = useCallback((next: ExportRecord) => {
    latest.current = next;
    setRecord(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { showAppNotice("无法保存成品包位置，包目录仍可打开", "error"); }
  }, [storageKey]);
  const [submitting, setSubmitting] = useState<ExportJobKind | "remove" | null>(null);
  const submittingRef = useRef(false);
  const automaticPolling = useRef(false);
  const [legacyInstalled, setLegacyInstalled] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<GameImageExportOperationStatus | null>(null);
  const [cancelRequest, setCancelRequest] = useState<{ id: string; state: "requesting" | "cancelling" }>();
  const [retry, setRetry] = useState(0);
  const pollWarning = useRef<string | undefined>(undefined);
  const [selection, setSelection] = useState<{ key: string; value: ConfirmationSelection }>();
  const [receipt, setReceipt] = useState<PackageReceipt>();
  const packagePath = record.package?.packagePath ?? "";
  const activity = record.pending?.kind ?? submitting;
  const busy = activity !== null;
  const key = JSON.stringify(exportSources(candidates, mosaicIds));
  const current = selection?.key === key ? selection.value : undefined;
  const packageReceipt = receipt?.path === packagePath ? receipt : undefined;
  const disposition = packageReceipt?.status;
  const receiptState = packageReceipt?.state;
  const applied = hasAppliedImages(receiptState);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  useEffect(() => {
    if (!active || busy) return;
    const controller = new AbortController(), { signal } = controller;
    void (async () => {
      let sizePath: string | undefined;
      if (packagePath) {
        try {
          const current = await readDisposition(gamePath, packagePath, signal);
          if (signal.aborted) return;
          setReceipt(current);
          if (hasAppliedImages(current.state) || current.status?.needsRecovery) return;
          if (current.bytes === undefined) sizePath = packagePath;
        } catch (cause) {
          if (signal.aborted) return;
          if (code(cause) === "PACKAGE_NOT_FOUND") setReceipt({ path: packagePath });
          notify(cause);
        }
      }
      try {
        const value = await readConfirmations(gamePath, JSON.parse(key) as ExportSource[], signal, sizePath);
        if (!signal.aborted) {
          setSelection({ key, value });
          if (value.bytes !== undefined) {
            const bytes = value.bytes;
            setReceipt(previous => previous?.path === packagePath ? { ...previous, bytes } : previous);
          }
        }
      } catch (cause) {
        if (!signal.aborted) { setSelection(undefined); notify(cause); }
      }
    })();
    return () => controller.abort();
  }, [active, busy, gamePath, key, packagePath]);

  useEffect(() => {
    if (!active || busy) return;
    const controller = new AbortController(), { signal } = controller;
    void withExportLockRetry(() => gameImageExportApi.legacyStatus(gamePath, signal), signal)
      .then(({ installed }) => { if (!signal.aborted) setLegacyInstalled(installed); })
      .catch(cause => { if (!signal.aborted) notify(cause); });
    return () => controller.abort();
  }, [active, busy, gamePath, legacyRevision, packagePath]);

  const finish = useCallback((pending: ExportJob, terminal: GameImageExportTerminalStatus) => {
    const { pending: _pending, ...previous } = latest.current;
    const result = terminal.result;
    if (terminal.state === "succeeded" && result && "packagePath" in result) {
      setReceipt({ path: result.packagePath, status: unusedPackage, bytes: result.bytes });
      persist({ ...previous, package: result, selectionKey: pending.selectionKey, targetChanged: undefined });
      return;
    }
    const path = previous.package?.packagePath;
    if (path && result && "transactionId" in result) {
      setReceipt(current => ({
        path,
        state: result.state,
        bytes: ("bytes" in result ? result.bytes : undefined) ?? (current?.path === path ? current.bytes : previous.package?.bytes),
      }));
    }
    if (terminal.state === "failed" && terminal.error.code === "LEGACY_PATCH_ACTIVE") setLegacyInstalled(true);
    const targetChanged = pending.kind === "apply" && terminal.state === "failed" && terminal.error.code === "TARGET_CHANGED";
    persist(targetChanged ? { ...previous, targetChanged: true } : previous);
    if (terminal.state === "cancelled" && pending.kind !== "generate") {
      const state = result && "transactionId" in result ? result.state : undefined;
      showAppNotice(state === undefined ? "已取消，游戏文件未修改" : {
        applied: "已取消，但图片已全部写入（等同已应用）",
        restored: "已取消，但图片已全部还原",
        partiallyRestored: "已取消，已还原部分图层",
      }[state]);
    } else if (terminal.state === "succeeded" && pending.reapply && "alreadyApplied" in terminal.result) {
      showAppNotice(terminal.result.alreadyApplied ? "目标文件已与包一致，已重新校验" : "已写回剩余图层");
    }
  }, [persist]);

  useEffect(() => {
    if (automaticPolling.current) return;
    const pending = record.pending;
    if (!pending) { setStatus(null); setCancelRequest(undefined); return; }
    const controller = new AbortController();
    let reconnect: number | undefined;
    void pollGameImageExport(pending.id, { signal: controller.signal, onStatus: setStatus }).then(terminal => {
      if (controller.signal.aborted) return;
      finish(pending, terminal);
      if (terminal.state === "failed") {
        const { code, message } = terminal.error;
        notify(code === "LEGACY_PATCH_ACTIVE" ? migrationHint : code === "TARGET_CHANGED" && pending.kind === "apply" ? targetChangedHint : message);
      }
    }).catch(cause => {
      if (controller.signal.aborted) return;
      if (code(cause) === "OPERATION_NOT_FOUND") {
        const { pending: _pending, ...previous } = latest.current;
        persist(previous);
        return;
      }
      if (pollWarning.current !== pending.id) { pollWarning.current = pending.id; notify(cause); }
      reconnect = window.setTimeout(() => setRetry(value => value + 1), 1500);
    });
    return () => { controller.abort(); window.clearTimeout(reconnect); };
  }, [record.pending, finish, persist, retry]);

  async function start(kind: ExportJobKind | "remove", work: (signal: AbortSignal) => Promise<(GameImageExportQueued & { outputDir?: string; selectionKey?: string }) | void>, reapply = false) {
    const signal = lifetime.current?.signal;
    if (locked || submittingRef.current || latest.current.pending || !signal || signal.aborted) return;
    submittingRef.current = true;
    setSubmitting(kind);
    try {
      const queued = await work(signal);
      if (queued && kind !== "remove") persist({ ...latest.current, outputDir: queued.outputDir ?? latest.current.outputDir, pending: { id: queued.operationId, kind, selectionKey: queued.selectionKey, ...(reapply ? { reapply } : {}) } });
    } catch (cause) {
      if (!signal.aborted) {
        if (kind === "apply" && code(cause) === "TARGET_CHANGED") {
          persist({ ...latest.current, targetChanged: true });
          notify(targetChangedHint);
        } else notify(cause);
      }
    } finally {
      if (!signal.aborted) { submittingRef.current = false; setSubmitting(null); }
    }
  }

  const pending = record.pending;
  const liveStatus = pending?.id === status?.operationId ? status : null;
  const progress = liveStatus?.progress;
  const requestState = pending?.id === cancelRequest?.id ? cancelRequest?.state : undefined;
  const cancelling = requestState === "cancelling" || liveStatus?.state === "cancelling";
  const canCancel = !!pending && !requestState && !cancelling &&
    (!liveStatus || liveStatus.state === "queued" || liveStatus.state === "running") &&
    (pending.kind !== "generate" || progress?.phase !== "publish");
  const cancel = async () => {
    const pending = latest.current.pending;
    const signal = lifetime.current?.signal;
    if (!pending || !canCancel || !signal || signal.aborted) return;
    setCancelRequest({ id: pending.id, state: "requesting" });
    try {
      await gameImageExportApi.cancel(pending.id, signal);
      if (!signal.aborted && latest.current.pending?.id === pending.id)
        setCancelRequest({ id: pending.id, state: "cancelling" });
    } catch (cause) {
      if (signal.aborted || latest.current.pending?.id !== pending.id) return;
      setCancelRequest(undefined);
      if (code(cause) === "CANCEL_TOO_LATE") showAppNotice("已错过安全取消点，正在完成");
      else notify(cause);
    }
  };

  const apply = () => {
    if (!packagePath || !disposition || disposition.needsRecovery || latest.current.targetChanged ||
        receiptState === "restored" || (!applied && legacyInstalled)) return;
    const title = applied ? "重新应用" : "应用成品包";
    void start("apply", async signal => {
      if (await confirm("请先关闭游戏，再将成品包写入游戏目录。", { title, okLabel: title }))
        return withExportLockRetry(() => gameImageExportApi.apply({ gamePath, packagePath }, signal), signal);
    }, applied);
  };
  const restore = (kind?: GameImageExportKind) => {
    if (!packagePath || !(disposition?.canRestore || disposition?.needsRecovery)) return;
    if (kind && (!disposition.layerRestoreSupported || !disposition.layers[kind]?.appliedFiles)) return;
    if (!kind && disposition.layerRestoreSupported && !disposition.needsRecovery) return;
    void start("restore", async signal => {
      if (await confirm("请先关闭游戏。恢复会将所选图片还原到应用成品包之前的版本。", { title: "恢复原图", okLabel: "恢复原图" }))
        return withExportLockRetry(() => gameImageExportApi.restore({ gamePath, packagePath, kinds: kind ? [kind] : undefined }, signal), signal);
    });
  };
  const remove = () => {
    if (!packagePath || !disposition || disposition.needsRecovery) return;
    const title = applied ? "恢复并删除" : "删除成品包";
    void start("remove", async signal => {
      if (!await confirm(applied ? "请先关闭游戏。将已应用的图片恢复为原图，再删除成品包目录？" : "删除这个成品包目录？",
        { title, okLabel: title })) return;
      const body = applied ? { packagePath, restoreFirst: true as const, gamePath } : { packagePath };
      const result = await withExportLockRetry(() => gameImageExportApi.remove(body, signal), signal);
      persist({ outputDir: latest.current.outputDir });
      if (result?.removed) showAppNotice("已恢复原图并删除包");
    });
  };

  const selectionKey = (images: GameImageExportImageSelection[]) =>
    JSON.stringify([...images].sort((a, b) => a.imageId.localeCompare(b.imageId)));

  const queueGeneration = async (images: GameImageExportImageSelection[], outputDir: string, signal: AbortSignal) =>
    ({ ...await withExportLockRetry(() => gameImageExportApi.generate({ gamePath, outputDir, images }, signal), signal), outputDir, selectionKey: selectionKey(images) });

  async function deploy(candidates: readonly ImageExportCandidate[], mosaicIds: readonly string[], stop: AbortSignal) {
    const signal = lifetime.current?.signal;
    if (!signal || submittingRef.current || latest.current.pending) throw new Error("已有图片成品包任务，请等待结束");
    const sources = exportSources(candidates, mosaicIds);
    if (!sources.length) return false;
    const scoped = AbortSignal.any([signal, stop]);
    submittingRef.current = automaticPolling.current = true;
    try {
      setSubmitting("generate");
      let path = latest.current.package?.packagePath;
      const current = path ? await readDisposition(gamePath, path, scoped) : undefined;
      if (current?.status?.needsRecovery) throw new Error("上次图片应用或恢复未完成，请先在应用面板恢复原图。");
      if (current?.state) throw new Error(hasAppliedImages(current.state)
        ? "已有图片成品包正在使用，请先恢复并删除旧包。"
        : "请先删除已恢复的旧成品包，再生成当前版本。");
      if ((await withExportLockRetry(() => gameImageExportApi.legacyStatus(gamePath, scoped), scoped)).installed) {
        setLegacyInstalled(true);
        throw new Error(migrationHint);
      }
      const selected = await readConfirmations(gamePath, sources, scoped);
      if (selected.needsConfirmation) throw new Error(`有 ${selected.needsConfirmation} 张图需要重新确认，先在图片翻译或去码页确认。`);
      if (!selected.images.length) return false;
      const wait = async (kind: "generate" | "apply", job: GameImageExportQueued & { outputDir?: string; selectionKey?: string }) => {
        const pending = { id: job.operationId, kind, selectionKey: job.selectionKey };
        persist({ ...latest.current, pending, outputDir: job.outputDir ?? latest.current.outputDir });
        const cancelGeneration = () => { void gameImageExportApi.cancel(pending.id).catch(() => {}); };
        if (kind === "generate") {
          stop.addEventListener("abort", cancelGeneration, { once: true });
          if (stop.aborted) cancelGeneration();
        }
        try {
          const terminal = await pollGameImageExport(job.operationId, { signal, onStatus: setStatus });
          finish(pending, terminal);
          scoped.throwIfAborted();
          if (terminal.state !== "succeeded")
            throw new Error(terminal.error?.code === "LEGACY_PATCH_ACTIVE" ? migrationHint : terminal.error?.message ?? "成品包任务已取消");
        } finally { stop.removeEventListener("abort", cancelGeneration); }
      };

      if (path) {
        if (latest.current.selectionKey !== selectionKey(selected.images))
          throw new Error("请先删除现有成品包，再生成当前版本。");
      } else {
        const outputDir = latest.current.outputDir || await open({ directory: true, title: "选择成品包输出目录", defaultPath: await resourceDir() });
        scoped.throwIfAborted();
        if (typeof outputDir !== "string") throw new Error("未选择成品包输出目录");
        await wait("generate", await queueGeneration(selected.images, outputDir, signal));
        path = latest.current.package?.packagePath;
      }

      scoped.throwIfAborted();
      setSubmitting("apply");
      const packagePath = path;
      if (!packagePath) throw new Error("成品包生成未返回目录");
      // Once queued, wait for the atomic apply to finish even if the workflow is stopped.
      await wait("apply", await withExportLockRetry(() => gameImageExportApi.apply({ gamePath, packagePath }, signal), signal));
      return true;
    } finally {
      submittingRef.current = automaticPolling.current = false;
      if (!signal.aborted) {
        setSubmitting(null);
        if (latest.current.pending) setRetry(value => value + 1);
      }
    }
  }

  const model: ImageExportPackage = {
    confirmed: applied || disposition?.needsRecovery ? (record.package?.files ?? 0) + (record.package?.skipped ?? 0) : current?.images.length ?? 0,
    needsConfirmation: applied || disposition?.needsRecovery ? 0 : current?.needsConfirmation ?? 0,
    path: packagePath,
    bytes: packageReceipt ? packageReceipt.bytes : record.package?.bytes,
    targetChanged: !!record.targetChanged,
    applied,
    partiallyRestored: receiptState === "partiallyRestored",
    layers: disposition?.layers ?? {},
    layerRestoreSupported: disposition?.layerRestoreSupported ?? false,
    legacyInstalled: !receiptState && legacyInstalled,
    needsRecovery: disposition?.needsRecovery ?? false,
    used: !!receiptState,
    canRestore: disposition?.canRestore ?? false,
    canGenerate: !!current?.images.length && !current.needsConfirmation,
    canUsePackage: !!disposition,
    activity,
    percent: progress?.total ? Math.min(100, Math.max(0, Math.round(progress.completed / progress.total * 100))) : null,
    canCancel,
    cancelling,
  };
  const actions: ImageExportActions = {
    generate: () => {
      if (!model.canGenerate || packagePath || legacyInstalled) return;
      void start("generate", async signal => {
        const outputDir = await open({ directory: true, title: "选择成品包输出目录", defaultPath: latest.current.outputDir || await resourceDir() });
        if (typeof outputDir !== "string") return;
        const value = await readConfirmations(gamePath, JSON.parse(key) as ExportSource[], signal);
        setSelection({ key, value });
        if (!value.images.length || value.needsConfirmation) return;
        return queueGeneration(value.images, outputDir, signal);
      });
    },
    cancel: () => void cancel(),
    apply, restore, remove,
    openDirectory: () => { if (packagePath) void api.revealPath(packagePath).catch(notify); },
  };
  return { model, actions, deploy };
}
