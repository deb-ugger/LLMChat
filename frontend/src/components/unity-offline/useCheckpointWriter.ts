import { useEffect, useRef, type RefObject } from "react";
import type { OcrMode, TranslateProvider } from "../../api";
import type { GameWrapMode } from "../../gameTextLayout";
import type { StyleRedrawProfileId } from "../../gameImagePlacement";
import type { UnityEngineChoice } from "../../unityEnginePool";
import type { UnityImageScreeningOptions } from "../../unityImageFiltering";
import type { UnityLineMode } from "../../unityLineLayout";
import { unityRun, type UnityProgress, type UnityProject } from "../../unityOffline";
import type { GameTranslationKind } from "../../unityTranslation";
import type { UnityTranslationPart } from "../../unityTranslationJobs";
import type { DeploymentPatch } from "./offlineExport";
import type { UnityImagePhase } from "./useImageOrchestration";
import { createCheckpointQueue } from "./checkpointQueue";

export type GenerationProgress = UnityProgress & { step: number; elapsedMs?: number; state: "pending" | "running" | "done" | "stopped" | "error" | "skipped"; failure?: string };

export type RunCheckpoint = {
  step: number; endStep: number; automatic: boolean; finished: boolean;
  projectFolder: string; scanFolder: string; patchFolder: string; patch: DeploymentPatch | null;
  previousProjectFolder?: string; scopeVersion?: number; translationFailure?: string; scanElapsedMs?: number;
  translationRuns?: Record<UnityTranslationPart, GenerationProgress>;
  imageOnly?: boolean; imageVisionModel?:string; imageLayoutModel?:string; imageRedrawProfile?: StyleRedrawProfileId; imageOcrMode?: OcrMode; imageConcurrency?:number; imageConfidenceThreshold?: number; imageTask?: UnityImagePhase;
  imageScreeningOptions?: UnityImageScreeningOptions;
  imageChain?: boolean;
  partial?: boolean; textScreenModel?: string; joinLines?: boolean; wrapMode?:GameWrapMode; includeContext?: boolean; skipTargetLanguage?: boolean; onlySourceLanguage?: boolean; lineMode?: UnityLineMode; lineModel?: string; layoutOnly?: boolean;
  textMode?: "lines" | "paragraphs" | "smart"; codeAssemblies?: string[] | null; typeDirectory?: string; extraCharacters?: string;
  translationKind: GameTranslationKind; llmModel?: string; dialogueModel?: string; nameModel?: string; imageModel?: string; imageReviewModel?: string; engine: TranslateProvider; engines?: UnityEngineChoice[]; source: string; target: string; includeCode: boolean; fontPath: string;
  progress: GenerationProgress;
};

type Options = {
  root: string;
  checkpointRef: RefObject<RunCheckpoint | null>;
  setCheckpoint: (value: RunCheckpoint) => void;
  setGeneration: (value: GenerationProgress) => void;
  getActiveParameters: () => Partial<RunCheckpoint> | undefined;
  setError: (message: string) => void;
};

export function useCheckpointWriter({ root, checkpointRef, setCheckpoint, setGeneration, getActiveParameters, setError }: Options) {
  const queueRef = useRef<ReturnType<typeof createCheckpointQueue<RunCheckpoint>> | null>(null);
  const queue = queueRef.current ??= createCheckpointQueue<RunCheckpoint>();
  const queuedSignature = useRef("");
  const elapsedOrigins = useRef<Partial<Record<"scan" | UnityTranslationPart, number>>>({});
  const resetQueuedSignature = () => { queuedSignature.current = ""; };
  const remember = (value: RunCheckpoint) => {
    const parameters = value.step >= 2 ? getActiveParameters() : undefined;
    const checkpoint = parameters ? { ...value, ...parameters } : value;
    checkpointRef.current = checkpoint; setCheckpoint(checkpoint); setGeneration(checkpoint.progress);
    const { progress, translationRuns, scanElapsedMs: _elapsed, ...fields } = checkpoint;
    const parts = translationRuns && Object.fromEntries(Object.entries(translationRuns).map(([part, value]) => [part, { state: value.state, total: value.total, failure: value.failure,
      completed: value.completed, redrawFailed: value.redrawFailed,
      engineStats: value.engineStats?.map(({ id, characters }) => ({ id, characters })) }]));
    const signature = JSON.stringify({ root, ...fields, translationRuns: parts, progress: { step: progress.step, state: progress.state, folder: progress.folder, total: progress.total, failure: progress.failure } });
    if (signature !== queuedSignature.current) {
      queuedSignature.current = signature;
      const job = structuredClone(checkpoint);
      const now = performance.now(), clocks = elapsedOrigins.current;
      if (clocks.scan !== undefined) job.scanElapsedMs = now - clocks.scan;
      for (const part of ["text", "images"] as const) {
        const origin = clocks[part];
        if (job.translationRuns && origin !== undefined) job.translationRuns[part].elapsedMs = now - origin;
      }
      const stage = JSON.stringify([root, job.step, job.progress.state, job.finished, job.imageTask,
        job.translationRuns?.text.state, job.translationRuns?.images.state, job.scanFolder, job.patchFolder]);
      queue.queueTaskWrite(stage, job, job.progress.state === "running",
        task => unityRun("save-task", { root, task }),
        e => { resetQueuedSignature(); setError(`任务检查点保存失败：${String(e)}`); });
    }
  };
  return { remember, taskWrites: queue.taskWrites, projectWrites: queue.projectWrites,
    queueProjectWrite: queue.queueProjectWrite, elapsedOrigins, resetQueuedSignature };
}

export function useCheckpointParameterWrite(parameterSignature: string, restoring: boolean, project: UnityProject | null, write: () => void) {
  const previousParameters = useRef(parameterSignature);
  const parameterWrite = useRef<(() => void) | null>(null);
  useEffect(() => {
    const changed = previousParameters.current !== parameterSignature;
    previousParameters.current = parameterSignature;
    if (!changed || restoring || !project) return;
    let timer: number;
    const commit = () => {
      window.clearTimeout(timer); parameterWrite.current = null;
      write();
    };
    parameterWrite.current = commit; timer = window.setTimeout(commit, 350);
    return () => { window.clearTimeout(timer); if (parameterWrite.current === commit) parameterWrite.current = null; };
  }, [parameterSignature, restoring, project?.folder]);
  return parameterWrite;
}
