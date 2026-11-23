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
type ConfirmationSelection = { images: GameImageExportImageSelection[]; needsConfirmation: number };
type ExportJobKind = "generate" | "apply" | "restore";
type ExportJob = { kind: ExportJobKind; id: string; selectionKey?: string };
type ExportRecord = { package?: GameImageExportGenerateResult; selectionKey?: string; pending?: ExportJob; outputDir?: string };
type PackageDisposition = Omit<GameImageExportReceiptStatus, "receipt"> & { receiptState?: GameImageExportReceiptState };
const unusedPackage: PackageDisposition = {
  applied: false, canRestore: false, needsRecovery: false, layerRestoreSupported: false, layers: {},
};
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

async function readConfirmations(gamePath: string, sources: ExportSource[], signal: AbortSignal): Promise<ConfirmationSelection> {
  const images: GameImageExportImageSelection[] = [];
  let needsConfirmation = 0;
  // Confirmation reads take the same per-game directory lock as export operations.
  for (const { imageId, sourceHash, renderedHash, mosaic } of sources) {
    if (renderedHash === "") { needsConfirmation++; continue; }
    const translation = renderedHash ? await withExportLockRetry(() =>
      gameImageExportApi.confirmationStatus({ gamePath, imageId, layer: "translation" }, signal), signal) : undefined;
    if (translation && (translation.state !== "confirmed" || translation.candidateVersion !== renderedHash)) {
      needsConfirmation++;
      continue;
    }
    const mosaicStatus = mosaic ? await withExportLockRetry(() =>
      gameImageExportApi.confirmationStatus({ gamePath, imageId, layer: "mosaic" }, signal), signal) : undefined;
    if (mosaicStatus && mosaicStatus.state !== "confirmed") { needsConfirmation++; continue; }
    const repair = mosaicStatus?.state === "confirmed" ? { confirmationId: mosaicStatus.confirmationId, pngSha256: mosaicStatus.pngSha256 } : undefined;
    if (translation?.state === "confirmed" && renderedHash)
      images.push({ imageId, sourceHash, translation: { confirmationId: translation.confirmationId, renderedHash }, mosaic: repair });
    else if (repair) images.push({ imageId, sourceHash, mosaic: repair });
  }
  return { images, needsConfirmation };
}

async function readDisposition(gamePath: string, packagePath: string, signal: AbortSignal): Promise<PackageDisposition> {
  try {
    const { receipt, ...status } = await withExportLockRetry(() => gameImageExportApi.queryReceipt({ gamePath, packagePath }, signal), signal);
    return { ...status, receiptState: receipt.state, layers: status.layers ?? {} };
  } catch (cause) {
    if (code(cause) !== "RECEIPT_NOT_FOUND") throw cause;
    const status = (cause as { response?: Partial<GameImageExportReceiptStatus> }).response;
    return { ...unusedPackage, needsRecovery: !!status?.needsRecovery, canRestore: !!status?.canRestore };
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
  const [cancelling, setCancelling] = useState(false);
  const [retry, setRetry] = useState(0);
  const pollWarning = useRef<string | undefined>(undefined);
  const [selection, setSelection] = useState<{ key: string; value: ConfirmationSelection }>();
  const [receipt, setReceipt] = useState<{ path: string; status: PackageDisposition }>();
  const packagePath = record.package?.packagePath ?? "";
  const activity = record.pending?.kind ?? submitting;
  const busy = activity !== null;
  const key = JSON.stringify(exportSources(candidates, mosaicIds));
  const current = selection?.key === key ? selection.value : undefined;
  const disposition = receipt?.path === packagePath ? receipt.status : undefined;

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
      if (packagePath) {
        try {
          const status = await readDisposition(gamePath, packagePath, signal);
          if (!signal.aborted) setReceipt({ path: packagePath, status });
          if (status.applied || status.needsRecovery) return;
        } catch (cause) {
          if (!signal.aborted) { setReceipt(undefined); notify(cause); }
        }
      }
      if (signal.aborted) return;
      try {
        const value = await readConfirmations(gamePath, JSON.parse(key) as ExportSource[], signal);
        if (!signal.aborted) setSelection({ key, value });
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
    if (terminal.state === "succeeded" && "packagePath" in terminal.result) {
      setReceipt({ path: terminal.result.packagePath, status: unusedPackage });
      persist({ ...previous, package: terminal.result, selectionKey: pending.selectionKey });
    } else {
      if (terminal.state === "succeeded") setReceipt(undefined);
      if (terminal.state === "failed" && terminal.error.code === "LEGACY_PATCH_ACTIVE") setLegacyInstalled(true);
      persist(previous);
    }
  }, [persist]);

  useEffect(() => {
    if (automaticPolling.current) return;
    const pending = record.pending;
    if (!pending) { setStatus(null); setCancelling(false); return; }
    const controller = new AbortController();
    let reconnect: number | undefined;
    void pollGameImageExport(pending.id, { signal: controller.signal, onStatus: setStatus }).then(terminal => {
      if (controller.signal.aborted) return;
      finish(pending, terminal);
      if (terminal.state === "failed")
        notify(terminal.error.code === "LEGACY_PATCH_ACTIVE" ? migrationHint : terminal.error.message);
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

  async function start(kind: ExportJobKind | "remove", work: (signal: AbortSignal) => Promise<(GameImageExportQueued & { outputDir?: string; selectionKey?: string }) | void>) {
    const signal = lifetime.current?.signal;
    if (locked || submittingRef.current || latest.current.pending || !signal || signal.aborted) return;
    submittingRef.current = true;
    setSubmitting(kind);
    try {
      const queued = await work(signal);
      if (queued && kind !== "remove") persist({ ...latest.current, outputDir: queued.outputDir ?? latest.current.outputDir, pending: { id: queued.operationId, kind, selectionKey: queued.selectionKey } });
    } catch (cause) {
      if (!signal.aborted) notify(cause);
    } finally {
      if (!signal.aborted) { submittingRef.current = false; setSubmitting(null); }
    }
  }

  const progress = status?.progress;
  const canCancel = record.pending?.kind === "generate" && !cancelling &&
    status?.state !== "cancelling" && progress?.phase !== "publish";
  const cancel = async () => {
    const pending = latest.current.pending;
    if (!pending || !canCancel || cancelling) return;
    setCancelling(true);
    try { await gameImageExportApi.cancel(pending.id); }
    catch (cause) { setCancelling(false); notify(cause); }
  };

  const apply = () => {
    if (!packagePath || !disposition || disposition.receiptState || disposition.needsRecovery || legacyInstalled) return;
    void start("apply", async signal => {
      if (await confirm("请先关闭游戏，再将成品包写入游戏目录。", { title: "应用成品包", okLabel: "应用成品包" }))
        return withExportLockRetry(() => gameImageExportApi.apply({ gamePath, packagePath }, signal), signal);
    });
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
    if (!packagePath || !disposition || disposition.applied || disposition.needsRecovery) return;
    void start("remove", async signal => {
      if (!await confirm("删除这个成品包目录？", { title: "删除成品包", okLabel: "删除成品包" })) return;
      await withExportLockRetry(() => gameImageExportApi.remove(packagePath, signal), signal);
      persist({ outputDir: latest.current.outputDir });
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
      if (current?.needsRecovery) throw new Error("上次图片应用或恢复未完成，请先在应用面板恢复原图。");
      if (current?.receiptState) throw new Error(current.applied
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
    confirmed: disposition?.applied || disposition?.needsRecovery ? (record.package?.files ?? 0) + (record.package?.skipped ?? 0) : current?.images.length ?? 0,
    needsConfirmation: disposition?.applied || disposition?.needsRecovery ? 0 : current?.needsConfirmation ?? 0,
    path: packagePath,
    applied: disposition?.applied ?? false,
    partiallyRestored: disposition?.receiptState === "partiallyRestored",
    layers: disposition?.layers ?? {},
    layerRestoreSupported: disposition?.layerRestoreSupported ?? false,
    legacyInstalled: !disposition?.receiptState && legacyInstalled,
    needsRecovery: disposition?.needsRecovery ?? false,
    used: !!disposition?.receiptState,
    canRestore: disposition?.canRestore ?? false,
    canGenerate: !!current?.images.length && !current.needsConfirmation,
    canUsePackage: !!disposition,
    activity,
    percent: progress?.total ? Math.min(100, Math.max(0, Math.round(progress.completed / progress.total * 100))) : null,
    canCancel: !!canCancel,
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
