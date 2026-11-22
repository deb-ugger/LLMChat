import { requestApiJson } from "./api";
import { toFriendlyError } from "./friendlyError";

export type GameImageExportEngine = "rpg-maker-mv" | "rpg-maker-mz" | "wolf";

export type GameImageExportDigest = {
  bytes: number;
  sha256: string;
};

type GameImageExportBox<Role extends string> = {
  id: string;
  role: Role;
  rect: [left: number, top: number, right: number, bottom: number];
};

type GameImageExportLayerBase = {
  confirmationId: string;
  groupId: string | null;
  candidateVersion: string;
  pngSha256: string;
};

export type GameImageExportTranslationLayer = GameImageExportLayerBase & {
  layer: "translation";
  targetLanguage: string;
} & (
  | { renderedKind: "generated"; maskMode: "boxes"; boxes: GameImageExportBox<"translate">[] }
  | { renderedKind: "imported"; maskMode: "whole-image"; boxes: [] }
);

export type GameImageExportMosaicLayer = GameImageExportLayerBase & {
  layer: "mosaic";
  modelId: string | null;
  maskMode: "boxes";
  boxes: GameImageExportBox<"repair" | "protect">[];
};

export type GameImageExportFile = GameImageExportDigest & {
  relativePath: string;
  kind: "translated" | "mosaic" | "composed";
  original: GameImageExportDigest;
  sourceImage: {
    id: string;
    relativePath: string;
    sourceHash: string;
    width: number;
    height: number;
    layers: (GameImageExportTranslationLayer | GameImageExportMosaicLayer)[];
  };
  boxIds: string[];
};

export type GameImageExportManifest = {
  schemaVersion: 1;
  packageId: string;
  engine: GameImageExportEngine;
  gameRootFingerprint: string;
  composeRuleVersion: 1;
  generatedAt: string;
  toolVersion: string;
  baseline: {
    algorithm: "sha256-anchors-and-targets-v1";
    marker: GameImageExportDigest & { relativePath: string };
  };
  files: GameImageExportFile[];
};

type TranslationSelection = { confirmationId: string; renderedHash: string };
type MosaicSelection = { confirmationId: string; pngSha256: string };

export type GameImageExportImageSelection = {
  imageId: string;
  sourceHash: string;
} & (
  | { translation: TranslationSelection; mosaic?: MosaicSelection }
  | { translation?: never; mosaic: MosaicSelection }
);

export type GameImageExportGenerateRequest = {
  gamePath: string;
  outputDir: string;
  images: GameImageExportImageSelection[];
};

export type GameImageExportApplyRequest = {
  gamePath: string;
  packagePath: string;
  mirrorReceipt: boolean;
};

export type GameImageExportReceiptLookup = { gamePath: string } & (
  | { receiptId: string; packagePath?: never }
  | { receiptId?: never; packagePath: string }
);

export type GameImageExportGenerateResult = {
  packageId: string;
  packagePath: string;
  manifestSha256: string;
  files: number;
  skipped: number;
};

export type GameImageExportApplyResult = {
  receiptId: string;
  packageId: string;
  state: "applied";
  unchanged: boolean;
  mirrored: boolean;
  warnings: string[];
};

export type GameImageExportRestoreResult = {
  receiptId: string;
  packageId: string;
  state: "restored";
  unchanged: boolean;
};

export type GameImageExportConflict = {
  relativePath: string;
  expectedSha256?: string;
  actualSha256?: string | null;
};

export type GameImageExportReceipt = {
  schemaVersion: 1;
  receiptId: string;
  packageId: string;
  manifestSha256: string;
  rootKey: string;
  gameRootFingerprint: string;
  engine: GameImageExportEngine;
  outcome: "applied" | "restored" | "rolledBack" | "recoveryRequired";
  appliedAt: string | null;
  restoredAt: string | null;
  files: {
    relativePath: string;
    before: GameImageExportDigest & { backupPath: string };
    after: GameImageExportDigest;
  }[];
  conflicts: GameImageExportConflict[];
};

export type GameImageExportFailure = {
  code: string;
  message: string;
  details?: {
    imageId?: string;
    relativePath?: string;
    conflicts?: GameImageExportConflict[];
    [key: string]: unknown;
  };
};

export type GameImageExportProgress = {
  phase: "snapshot" | "compose" | "publish" | "validate" | "baseline" | "verifyPayload"
    | "backup" | "commit" | "rollback" | "verifyRestore" | "restore";
  completed: number;
  total: number | null;
  unit: "bytes" | "files";
  relativePath?: string;
};

export type GameImageExportQueued = { operationId: string; state: "queued" };

export type GameImageExportCancelResult = { state: "cancelling" | "cancelled" };

export type GameImageExportResult = GameImageExportGenerateResult | GameImageExportApplyResult | GameImageExportRestoreResult;

type StatusBase = {
  operationId: string;
  lastSeq: number;
  progress: GameImageExportProgress | null;
  canCancel?: boolean;
};

export type GameImageExportTerminalStatus<Result = GameImageExportResult> = StatusBase & (
  | { state: "succeeded"; result: Result; error: null }
  | { state: "failed"; result: null; error: GameImageExportFailure }
  | { state: "cancelled"; result: null; error: GameImageExportFailure | null }
);

export type GameImageExportOperationStatus<Result = GameImageExportResult> =
  | (StatusBase & { state: "queued" | "running" | "cancelling"; result: null; error: null })
  | GameImageExportTerminalStatus<Result>;

const BASE = "/api/game-image-exports";

async function request<Result>(path: string, init?: RequestInit): Promise<Result> {
  try {
    return await requestApiJson<Result>(BASE + path, init);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const transportError = error as Error & { status?: number; response?: { error?: Partial<GameImageExportFailure> } };
    const failure = transportError.response?.error;
    if (typeof failure?.code !== "string" || typeof failure.message !== "string") throw error;
    throw Object.assign(new Error(toFriendlyError(failure.message), { cause: error }), {
      status: transportError.status,
      code: failure.code,
      details: failure.details,
      response: transportError.response,
    });
  }
}

function post<Result>(path: string, body: object, signal?: AbortSignal) {
  return request<Result>(path, { method: "POST", body: JSON.stringify(body), signal });
}

function operationPath(operationId: string) {
  return "/operations/" + encodeURIComponent(operationId);
}

export const gameImageExportApi = {
  generate: (body: GameImageExportGenerateRequest, signal?: AbortSignal) =>
    post<GameImageExportQueued>("/generate", body, signal),
  status: <Result = GameImageExportResult>(operationId: string, signal?: AbortSignal) =>
    request<GameImageExportOperationStatus<Result>>(operationPath(operationId), { signal }),
  apply: (body: GameImageExportApplyRequest, signal?: AbortSignal) =>
    post<GameImageExportQueued>("/apply", body, signal),
  restore: (body: GameImageExportReceiptLookup, signal?: AbortSignal) =>
    post<GameImageExportQueued>("/restore", body, signal),
  queryReceipt: (body: GameImageExportReceiptLookup, signal?: AbortSignal) =>
    post<{ receipt: GameImageExportReceipt }>("/receipts/query", body, signal),
  cancel: (operationId: string, signal?: AbortSignal) =>
    post<GameImageExportCancelResult>(operationPath(operationId) + "/cancel", {}, signal),
  remove: async (packagePath: string, signal?: AbortSignal): Promise<void> => {
    // Provisional until the package deletion route is specified.
    await post<unknown>("/remove", { packagePath }, signal);
  },
};

type PollOptions<Result> = {
  signal?: AbortSignal;
  intervalMs?: number;
  onStatus?: (status: GameImageExportOperationStatus<Result>) => void;
};

function pause(intervalMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, intervalMs);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Aborting the poll stops observation. Use the cancel request to stop the operation. */
export async function pollGameImageExport<Result = GameImageExportResult>(
  operationId: string,
  { signal, intervalMs = 500, onStatus }: PollOptions<Result> = {},
): Promise<GameImageExportTerminalStatus<Result>> {
  for (;;) {
    signal?.throwIfAborted();
    const status = await gameImageExportApi.status<Result>(operationId, signal);
    onStatus?.(status);
    if (status.state === "succeeded" || status.state === "failed" || status.state === "cancelled") return status;
    await pause(intervalMs, signal);
  }
}
