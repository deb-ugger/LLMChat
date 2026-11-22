import type { Settings } from "../../api";
import type { MosaicBox, MosaicDevice, MosaicModel } from "../../gameMosaic";
import type { MosaicInitialScreeningSnapshot, MosaicStatus } from "../../gameMosaicStatus";
import type { StepPerformance } from "../../gameModelPerformance";
import type { UnityImage } from "../../unityOffline";
import type { GameProgressState } from "../GameStepProgress";

export type RefineMovement = { from: MosaicStatus; to: MosaicStatus; checkedBefore: boolean; checkedAfter: boolean };
export type Result = { source: string; beforeRefine?: MosaicInitialScreeningSnapshot; refineMovement?: RefineMovement; boxes: MosaicBox[]; checked: boolean; group?: string; manualGroup?: boolean;
  scanned?: boolean; detector?: string; manualBoxes?: boolean; manualChecked?: boolean; reason?: string; review?: string; refineError?: string; redrawError?: string; refined?: string; refineQuickExcluded?: boolean; signature?: string | number[]; saved?: boolean; reference?: boolean; discardedHash?: string };
export type Results = Record<string, Result>;
type Candidates = Partial<Record<MosaicModel, Blob>>;
export type MosaicCandidate = { revision: string; values: Candidates; seconds: Partial<Record<MosaicModel, number>> };
export type MaskEdit = { image: UnityImage; boxes: MosaicBox[] };
export type MaskUndoItem = {
  id: string;
  source: string;
  mask: Pick<Result, "boxes" | "manualBoxes" | "review" | "redrawError" | "saved" | "reference" | "checked">;
  candidate?: MosaicCandidate;
};
export type RedrawPlan = {
  targets: { image: UnityImage; boxes: MosaicBox[]; keep: MosaicBox[]; pending: Set<MosaicModel> }[];
  models: MosaicModel[];
  steps: number;
  seed: number;
  reference?: UnityImage;
  referenceBlob?: Blob;
};
export type ResultVersion = { id: MosaicModel; blob: Blob; seconds?: number };
export type MosaicStep = "screen" | "refine" | "redraw";
export type StepRun = {
  state: GameProgressState; completed: number; total: number; started?: number; elapsed?: number;
  summary?: string; device?: MosaicDevice; prepared?: number; models?: StepPerformance["models"];
  batchStarted?: number; batchElapsed?: number; processed?: number; failed?: number;
} & Partial<StepPerformance>;
export type StepReport = number | Partial<Pick<StepRun, "completed" | "prepared" | "processed" | "failed">>;

export type ImagePreview = { id: string; revision: string; blob?: Blob; error?: string };
export type MosaicGroupMenu = { group: string; x: number; y: number };

export type GameMosaicDeploymentHandle = {
  prepare: (signal: AbortSignal, ids?: string[]) => Promise<{ ids: string[]; patchId: string; path: string }>;
  automatic: (signal: AbortSignal) => Promise<string[]>;
  selectedIds: () => string[];
  apply: (ids: string[], undo?: boolean, patchId?: string) => Promise<number>;
};

export type MosaicCandidateIndex = Record<string, { source: string; hash: string; included: boolean }>;
type MosaicStorage = {
  index: MosaicCandidateIndex;
  savedDrafts?: ReadonlySet<string>;
  consumeSavedDrafts?: () => void;
  read: (image: UnityImage, signal: AbortSignal) => Promise<Blob>;
  save: (image: UnityImage, blob: Blob, signal: AbortSignal) => Promise<void>;
  select: (images: UnityImage[], include: boolean, signal: AbortSignal) => Promise<void>;
};
export type MosaicWorkbenchProps = {
  settings?: Settings; gamePath: string; images: readonly UnityImage[]; backupMode?: string; storage?: MosaicStorage;
  read: (image: UnityImage, signal: AbortSignal) => Promise<Blob>;
  prepareSources?: (images: readonly UnityImage[], signal: AbortSignal) => Promise<Record<string, string>>;
  controls: HTMLElement; visible?: boolean; disabled?: boolean; onBusy?: (busy: boolean) => void;
  deploymentHandle?: { current: GameMosaicDeploymentHandle | null };
};
