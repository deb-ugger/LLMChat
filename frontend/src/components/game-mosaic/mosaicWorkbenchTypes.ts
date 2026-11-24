import type { RecordImageBenchmarkOutcome } from "../../benchmark/imageBenchmarkHistory";
import type { BenchmarkParameter } from "../../benchmark/benchmarkParameters";
import type { ReactNode } from "react";
import type { Settings } from "../../api";
import type { createMosaicGridScanner, loadMosaicDetector, mosaicInputKey, openDeploymentDetector, redrawMosaic,
  MosaicBox, MosaicDevice, MosaicModel, MosaicSettings } from "../../gameMosaic";
import type { readMosaicReviews, refineMosaicBatch, savedMosaicScan } from "../../gameMosaicRefine";
import type { MosaicInitialScreeningSnapshot, MosaicManualStatus, MosaicStatus } from "../../gameMosaicStatus";
import type { gameStepSelections, measureGameAsync, recordGameCacheHit, reportGameStepItems, StepPerformance } from "../../gameModelPerformance";
import type { UnityImage } from "../../unityOffline";
import type { GameProgressState } from "../GameStepProgress";
import type { useMosaicMasks } from "./useMosaicMasks";

export type RefineMovement = { from: MosaicStatus; to: MosaicStatus; checkedBefore: boolean; checkedAfter: boolean };
export type Result = { source: string; beforeRefine?: MosaicInitialScreeningSnapshot; refineMovement?: RefineMovement; boxes: MosaicBox[]; checked: boolean; group?: string; manualGroup?: boolean; manualStatus?: MosaicManualStatus;
  scanned?: boolean; detector?: string; manualBoxes?: boolean; manualChecked?: boolean; reason?: string; review?: string; refineError?: string; redrawError?: string; refined?: string; refineQuickExcluded?: boolean; signature?: string | number[]; saved?: boolean; reference?: boolean; discardedHash?: string };
export type Results = Record<string, Result>;
export type MosaicCandidate = { revision: string; versions: ResultVersion[] };
export type MaskEdit = { image: UnityImage; boxes: MosaicBox[] };
export type MaskUndoItem = {
  id: string;
  source: string;
  mask: Pick<Result, "boxes" | "manualBoxes" | "review" | "redrawError" | "saved" | "reference" | "checked">;
  candidate?: MosaicCandidate;
};
export type RedrawStyle = { group: string; seed: number; reference?: UnityImage };
export type MosaicRedrawReference = {
  image: UnityImage;
  source: "generate" | "adopted" | "candidate";
  boxes?: MosaicBox[];
  blob?: Blob;
};
export type RedrawPlan = {
  targets: { image: UnityImage; boxes: MosaicBox[]; keep: MosaicBox[]; pending: Set<MosaicModel>; style: RedrawStyle;
    promptIds?: Partial<Record<MosaicModel, string>> }[];
  models: MosaicModel[];
  steps: number;
  referenceGuide?: boolean;
  groupReferences?: ReadonlyMap<string, MosaicRedrawReference>;
};
export type ResultVersion = {
  id: string; model: MosaicModel; blob: Blob; seconds: number; boxes: MosaicBox[]; keep: MosaicBox[]; referenceGroup?: string;
};
export type MosaicStep = "screen" | "refine" | "redraw";
export type StepRun = {
  state: GameProgressState; completed: number; total: number; started?: number; elapsed?: number;
  summary?: string; parameters?: readonly BenchmarkParameter[]; device?: MosaicDevice; prepared?: number; models?: StepPerformance["models"];
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
  saveDraftChanges: (imageId: string) => Promise<void>;
};
export type MosaicWorkbenchProps = {
  settings?: Settings; gamePath: string; images: readonly UnityImage[]; backupMode?: string; storage?: MosaicStorage;
  read: (image: UnityImage, signal: AbortSignal) => Promise<Blob>;
  prepareSources?: (images: readonly UnityImage[], signal: AbortSignal) => Promise<Record<string, string>>;
  controls: HTMLElement; visible?: boolean; disabled?: boolean; onBusy?: (busy: boolean) => void;
  deploymentHandle?: { current: GameMosaicDeploymentHandle | null };
};

export type MosaicStepUsage = {
  scope: string;
  snapshot: () => StepPerformance;
  recordItems: (itemsDone: number, failures?: number) => void;
  measure: <T>(model: string, concurrency: number, work: () => Promise<T>) => Promise<T>;
  refresh: () => void;
  recordImage?: RecordImageBenchmarkOutcome;
  finish: (completed: boolean, failed?: boolean, detail?: string) => void | Promise<void>;
};

export type MosaicBatchStep = { id: MosaicStep; targets?: readonly UnityImage[]; total: number; completed?: number; summary: string; parameters?: readonly BenchmarkParameter[]; resume?: boolean };
export type MosaicBatchWork = (signal: AbortSignal, report: (progress: StepReport) => void, usage?: MosaicStepUsage) => Promise<void | boolean>;

export type MosaicBatchPorts = {
  blocked: () => boolean;
  start: (controller: AbortController, id?: MosaicStep) => void;
  resumableElapsed: (step: MosaicBatchStep) => number;
  setProgressStep: (id?: MosaicStep) => void;
  setStepRuns: (change: (previous: Partial<Record<MosaicStep, StepRun>>) => Partial<Record<MosaicStep, StepRun>>) => void;
  setRunning: (label: string) => void;
  beginUsage: (step: MosaicBatchStep, refresh: () => void) => MosaicStepUsage;
  setProgress: (message: string) => void;
  setError: (message: string) => void;
  finish: () => void;
};

type MosaicRead = MosaicWorkbenchProps["read"];
type MosaicPrepare = MosaicWorkbenchProps["prepareSources"];
type MosaicWriteRows = (change: (previous: Results) => Results) => void;
type MosaicUpdateRow = (image: UnityImage, edit: Partial<Result>) => void;
type MosaicResetPorts = {
  replaceRows: (rows: Results) => void;
  clearReviews: (ids: string[]) => void;
  resetRedraw: (ids: ReadonlySet<string>) => void;
};

export type MosaicScreenPlan = {
  targets: readonly UnityImage[];
  usable: readonly UnityImage[];
  rows: Results;
  initial: number;
  screening?: MosaicSettings["screening"];
  detectorKind: MosaicSettings["detector"];
  detectorKey: string;
  detectorFile?: File;
  modelName: string;
  concurrency?: number;
};

export type MosaicScreenPorts = MosaicResetPorts & {
  setRows: MosaicWriteRows;
  read: MosaicRead;
  prepareSources?: MosaicPrepare;
  loadMosaicDetector: typeof loadMosaicDetector;
  createMosaicGridScanner: typeof createMosaicGridScanner;
  setProgress: (message: string) => void;
  onDevice: (device: MosaicDevice) => void;
};

export type MosaicReviewMetrics = { onPreparation: (prepared: number) => void; onFailure: () => void; usage?: MosaicStepUsage };
export type MosaicReviewSession = { key: string; images: Map<string, string> };

export type MosaicReviewPlan = {
  targets: readonly UnityImage[];
  rows: Results;
  gamePath: string;
  preferences: MosaicSettings;
  reviewKey: string;
  detectorFile?: File;
  restart: boolean;
  automatic: boolean;
  metrics?: MosaicReviewMetrics;
  deploymentScope?: string;
};

export type MosaicReviewPorts = {
  read: MosaicRead;
  prepareSources?: MosaicPrepare;
  refineBatch: typeof refineMosaicBatch;
  readMosaicReviews: typeof readMosaicReviews;
  setRows: MosaicWriteRows;
  setRefineRetries: (change: ReadonlyMap<string, string> | ((previous: ReadonlyMap<string, string>) => ReadonlyMap<string, string>)) => void;
  beginUsage: (resume: boolean) => MosaicStepUsage;
  gameStepSelections: typeof gameStepSelections;
  prepareRequest: NonNullable<Parameters<typeof refineMosaicBatch>[1]["prepareRequest"]>;
  request: (model: string, prompt: string, image: string, signal: AbortSignal, selection?: object) => Promise<unknown>;
};

type PerformMosaicReviews = (targets: readonly UnityImage[], signal: AbortSignal, report?: (completed: number, detail: string) => void,
  restart?: boolean, automatic?: boolean, metrics?: MosaicReviewMetrics, deploymentScope?: string) => ReturnType<typeof refineMosaicBatch>;

export type MosaicRefinePlan = {
  targets: readonly UnityImage[];
  rows: Results;
  restart: boolean;
  initial: number;
  previousReview?: MosaicReviewSession;
  checkedReviewScope: readonly UnityImage[];
  reviewSessionKey: string;
};

export type MosaicRefinePorts = MosaicResetPorts & {
  performReviews: PerformMosaicReviews;
  setProgress: (message: string) => void;
  setError: (message: string) => void;
  trackReview: (session: MosaicReviewSession) => void;
};

export type MosaicRedrawPorts = {
  read: MosaicRead;
  readSaved: MosaicRead;
  mosaicInputKey: typeof mosaicInputKey;
  redrawMosaic: typeof redrawMosaic;
  recordGameCacheHit: typeof recordGameCacheHit;
  update: MosaicUpdateRow;
  setProgress: (message: string) => void;
  setError: (message: string) => void;
  setPending: (plan: RedrawPlan | null) => Promise<void>;
  onCandidate: (image: UnityImage, version: ResultVersion) => Promise<void>;
};

export type MosaicAutomaticPlan = {
  selected: readonly UnityImage[];
  scoped: readonly UnityImage[];
  usable: readonly UnityImage[];
  rows: Results;
  detectorKey: string;
  protect: boolean;
  refine?: boolean;
  model: MosaicModel;
  steps: number;
  timingScope: string;
};

export type MosaicAutomaticPorts = {
  read: MosaicRead;
  readSaved: MosaicRead;
  performReviews: PerformMosaicReviews;
  openDetector: (signal: AbortSignal, timingScope: string) => ReturnType<typeof openDeploymentDetector>;
  savedMosaicScan: typeof savedMosaicScan;
  redrawMosaic: typeof redrawMosaic;
  reportGameStepItems: typeof reportGameStepItems;
  recordGameCacheHit: typeof recordGameCacheHit;
  measureGameAsync: typeof measureGameAsync;
  update: MosaicUpdateRow;
  setProgress: (message: string) => void;
  clearReviews: (ids: string[]) => void;
  readExisting: (signal: AbortSignal) => Promise<Record<string, string>>;
  writeCandidate: (image: UnityImage, blob: Blob, signal: AbortSignal) => Promise<unknown>;
};

export type MosaicMaskCommit = {
  rows?: Results;
  candidates: readonly Pick<MaskUndoItem, "id" | "candidate">[];
};

export type MosaicMaskOptions = {
  gamePath: string;
  active?: UnityImage;
  activeResult?: Result;
  members: readonly UnityImage[];
  usable: readonly UnityImage[];
  rows: Results;
  getRows: () => Results;
  candidates: Record<string, MosaicCandidate>;
  blocked: () => boolean;
  actionsDisabled: boolean;
  commit: (edits: MosaicMaskCommit) => boolean;
};

export type MosaicPreviewProps = {
  active?: UnityImage;
  activeResult?: Result;
  visibleCount: number;
  paneVisible: boolean;
  activeSaved: boolean;
  candidate?: MosaicCandidate;
  source?: ImagePreview;
  approved?: ImagePreview;
  preferredResult?: string;
  setPreferredResult: (version: string) => void;
  masks: ReturnType<typeof useMosaicMasks>;
  actionsDisabled: boolean;
  busyReason?: string;
  redrawReason?: string;
  testTitle?: string;
  model: MosaicModel;
  getViewerNeighbors: () => { previous?: UnityImage; next?: UnityImage };
  onViewerImage: (image: UnityImage) => void;
  onRedraw: (models: MosaicModel[]) => void;
  onApprove: (blob: Blob) => void;
  referenceCandidate?: Blob;
  header: ReactNode;
  resultActions: ReactNode;
  notice: ReactNode;
  footer: ReactNode;
};
