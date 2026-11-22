import { resourceDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { showAppNotice } from "../components/AppNotice";
import type { useGameActionConfirm } from "../components/GameActionConfirm";
import {
  gameImageExportApi, pollGameImageExport, type GameImageExportGenerateResult, type GameImageExportImageSelection,
  type GameImageExportOperationStatus, type GameImageExportQueued, type GameImageExportReceiptStatus,
} from "../gameImageExport";

export type ImageExportCandidate = { imageId: string; sourceHash: string; renderedHash?: string };
type ExportSource = ImageExportCandidate & { mosaic: boolean };
type ConfirmationSelection = { images: GameImageExportImageSelection[]; needsConfirmation: number };
type ExportJobKind = "generate" | "apply" | "restore";
type ExportJob = { kind: ExportJobKind; id: string };
type ExportRecord = { package?: GameImageExportGenerateResult; pending?: ExportJob; outputDir?: string };
type PackageDisposition = Omit<GameImageExportReceiptStatus, "receipt"> & { used: boolean };

export type ImageExportPackage = {
  confirmed: number;
  needsConfirmation: number;
  path: string;
  count: number;
  applied: boolean;
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
  restore: () => void;
  remove: () => void;
  openDirectory: () => void;
  launch: () => void;
};

type Options = {
  gamePath: string;
  active: boolean;
  locked: boolean;
  candidates: readonly ImageExportCandidate[];
  mosaicIds: readonly string[];
  onBusyChange: (busy: boolean) => void;
  confirm: ReturnType<typeof useGameActionConfirm>["confirm"];
  launch: () => void;
};

function notify(cause: unknown) {
  showAppNotice(cause instanceof Error ? cause.message : String(cause), "error");
}

const code = (cause: unknown) => (cause as { code?: string } | null)?.code;

function readRecord(key: string): ExportRecord {
  try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; }
  catch { return {}; }
}

async function readStatus<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
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
    const translation = renderedHash ? await readStatus(() =>
      gameImageExportApi.confirmationStatus({ gamePath, imageId, layer: "translation" }, signal), signal) : undefined;
    if (translation && (translation.state !== "confirmed" || translation.candidateVersion !== renderedHash)) {
      needsConfirmation++;
      continue;
    }
    const mosaicStatus = mosaic ? await readStatus(() =>
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
    const { receipt, ...status } = await readStatus(() => gameImageExportApi.queryReceipt({ gamePath, packagePath }, signal), signal);
    return { ...status, used: !!receipt };
  } catch (cause) {
    if (code(cause) !== "RECEIPT_NOT_FOUND") throw cause;
    const status = (cause as { response?: Partial<GameImageExportReceiptStatus> }).response;
    return { applied: false, needsRecovery: !!status?.needsRecovery, canRestore: !!status?.canRestore, used: false };
  }
}

export function useGameImageExportPackage({ gamePath, active, locked, candidates, mosaicIds, onBusyChange, confirm, launch }: Options) {
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
  const chosenMosaics = new Set(mosaicIds);
  const key = JSON.stringify(candidates.map(image => ({ ...image, mosaic: chosenMosaics.has(image.imageId) }))
    .filter(row => row.mosaic || row.renderedHash !== undefined));
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
    const pending = record.pending;
    if (!pending) { setStatus(null); setCancelling(false); return; }
    const controller = new AbortController();
    let reconnect: number | undefined;
    void pollGameImageExport(pending.id, { signal: controller.signal, onStatus: setStatus }).then(terminal => {
      if (controller.signal.aborted) return;
      const previous = latest.current.package;
      if (terminal.state === "succeeded" && "packagePath" in terminal.result) {
        setReceipt({ path: terminal.result.packagePath, status: { applied: false, canRestore: false, needsRecovery: false, used: false } });
        persist({ package: terminal.result, outputDir: latest.current.outputDir });
        return;
      }
      if (terminal.state === "succeeded" && previous && "state" in terminal.result) {
        const applied = terminal.result.state === "applied";
        setReceipt({ path: previous.packagePath, status: { applied, canRestore: applied, needsRecovery: false, used: true } });
      } else if (terminal.state === "failed") {
        notify(terminal.error.message);
      }
      persist({ package: previous, outputDir: latest.current.outputDir });
    }).catch(cause => {
      if (controller.signal.aborted) return;
      if (code(cause) === "OPERATION_NOT_FOUND") {
        persist({ package: latest.current.package, outputDir: latest.current.outputDir });
        return;
      }
      if (pollWarning.current !== pending.id) { pollWarning.current = pending.id; notify(cause); }
      reconnect = window.setTimeout(() => setRetry(value => value + 1), 1500);
    });
    return () => { controller.abort(); window.clearTimeout(reconnect); };
  }, [record.pending, persist, retry]);

  async function start(kind: ExportJobKind | "remove", work: (signal: AbortSignal) => Promise<(GameImageExportQueued & { outputDir?: string }) | void>) {
    const signal = lifetime.current?.signal;
    if (locked || submittingRef.current || latest.current.pending || !signal || signal.aborted) return;
    submittingRef.current = true;
    setSubmitting(kind);
    try {
      const queued = await work(signal);
      if (queued && kind !== "remove") persist({ ...latest.current, outputDir: queued.outputDir ?? latest.current.outputDir, pending: { id: queued.operationId, kind } });
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
    if (!packagePath || !disposition || disposition.used || disposition.needsRecovery) return;
    void start("apply", async signal => {
      if (await confirm("请先关闭游戏，再将成品包写入游戏目录。", { title: "应用到游戏", okLabel: "应用到游戏" }))
        return gameImageExportApi.apply({ gamePath, packagePath }, signal);
    });
  };
  const restore = () => {
    if (!packagePath || !(disposition?.canRestore || disposition?.needsRecovery)) return;
    void start("restore", async signal => {
      if (await confirm("请先关闭游戏。恢复会将目标图片还原到应用成品包之前的版本。", { title: "恢复原图", okLabel: "恢复原图" }))
        return gameImageExportApi.restore({ gamePath, packagePath }, signal);
    });
  };
  const remove = () => {
    if (!packagePath || !disposition || disposition.applied || disposition.needsRecovery) return;
    void start("remove", async signal => {
      if (!await confirm("删除这个成品包目录？", { title: "删除成品包", okLabel: "删除成品包" })) return;
      await gameImageExportApi.remove(packagePath, signal);
      persist({ outputDir: latest.current.outputDir });
    });
  };

  const model: ImageExportPackage = {
    confirmed: current?.images.length ?? 0,
    needsConfirmation: current?.needsConfirmation ?? 0,
    path: packagePath,
    count: record.package?.files ?? 0,
    applied: disposition?.applied ?? false,
    needsRecovery: disposition?.needsRecovery ?? false,
    used: disposition?.used ?? false,
    canRestore: disposition?.canRestore ?? false,
    canGenerate: !!current?.images.length && !current.needsConfirmation,
    canUsePackage: !!disposition,
    activity,
    percent: progress?.total ? Math.min(100, Math.max(0, Math.round(progress.completed / progress.total * 100))) : null,
    canCancel: !!canCancel,
  };
  const actions: ImageExportActions = {
    generate: () => {
      if (!model.canGenerate || packagePath) return;
      void start("generate", async signal => {
        const outputDir = await open({ directory: true, title: "选择成品包输出目录", defaultPath: latest.current.outputDir || await resourceDir() });
        if (typeof outputDir !== "string") return;
        const value = await readConfirmations(gamePath, JSON.parse(key) as ExportSource[], signal);
        setSelection({ key, value });
        if (!value.images.length || value.needsConfirmation) return;
        const job = await gameImageExportApi.generate({ gamePath, outputDir, images: value.images }, signal);
        return { ...job, outputDir };
      });
    },
    cancel: () => void cancel(),
    apply, restore, remove, launch,
    openDirectory: () => { if (packagePath) void api.revealPath(packagePath).catch(notify); },
  };
  return { model, actions };
}
