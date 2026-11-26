import { hasMosaicDrafts, mosaicDraftsOf, saveMosaicDrafts, useHasMosaicDrafts } from "./game-mosaic/mosaicDrafts";
import { GameTextParameters } from "./GameTextParameters";
import { showAppNotice } from "./AppNotice";
import { benchmarkBlockingReason, isBenchmarkRunning, useBenchmarkRunning, useFormalWorkflowActivity } from "../benchmark/benchmarkRunner";
import { automaticMosaicRedrawStyle } from "./game-mosaic/mosaicBatchRunner";
import { createMosaicTargetResolver, mosaicRegionTargeting } from "../mosaicRegionTargets";
import { clearMosaicRows, persistMosaicErrorUpdates, readMosaicRows, refineMosaicBatch, savedMosaicScan, type MosaicErrorUpdate } from "../gameMosaicRefine";
import { prepareMosaicReviewModel, requestGameModelJson } from "../gameModelRequest";
import { useOutputMessage, writeOutput, type OutputLevel } from "../appOutput";
import { writeDownloadedFile } from "../outputFiles";
import { loadGameStage, rememberGameStage, rememberRecentGameFailures } from "../unityLastGame";
import { clearImageGroupHistory, resetImageGroupHistory } from "../gameImageGroupChanges";
import { useGameTestConfigurationSource } from "../gameAuxWindows";
import { GameBatchResults, type BatchRow } from "./GameBatchResults";
import type { MosaicCandidateIndex } from "./GameMosaicWorkbench";
import { canDisableOllamaNameThinking, prepareGameOllamaModels, translateGameWithOllama } from "../gameOllama";
import { screenGameText } from "../gameTextScreening";
import { GAME_CONTEXT_HINT } from "../gameTranslationContext";
import { openGameTextBenchmark } from "./GameTextBenchmarkDialog";
import { useProjectBenchmarkLauncher } from "../gameBenchmarkWindow";
import { sameTextEdit } from "../gameTextProject";
import { beginGameStep, finishGameStep, gameModelExecution, modelConcurrency, clearGamePerformance, stepPerformance, measureGameAsync, measureGameWork, recordGameCacheHit, reportGameStepItems, gameStepSelections } from "../gameModelPerformance";
import { type GameWrapMode } from "../gameTextLayout";
import { useGamePromptSelection, gameTaskPrompt } from "../gamePrompts";
import { GamePageNumber } from "./GamePageNumber";
import { gameImageTranslationProblem, recognizeGameImage, renderGameImage } from "../gameImageModel";
import { savedGameImageRedraw, defaultGameImageReview, defaultGameImageTranslation, defaultGameImageVision, gameImageCleanBase, gameImageRedrawSelected, gameImageRedrawSummary, gameImageVisionForAsset, redrawGameImages, styleRedrawLabels, type StyleRedrawProfileId } from "../gameImagePlacement";
import { collectGameImageNames, translateNamedImageText } from "../gameImageNames";
import { applyGameTestRoles, captureGameTestRoles, recommendedGameModels, type GameTestConfigurationAccess } from "../gameModelPreset";
import type { GameStepConfigurationCommit } from "./GameFlowSequence";
import { formatFlowThroughput } from "../gameFlowMetrics";
import { GameProgressBar, gameProgressLabels } from "./GameStepProgress";
import { GameFlowNumberChip, GameFlowParameterGroup, type GameFlowActivity } from "./GameFlowCard";
import { gameAvailableModels, GameModelSelect, GameProcessingMethod, GameProcessingTabs, GameTranslationMethod } from "./GameTranslationTabs";
import { prepareUnityImageSources, readUnitySourceImage } from "../unityImagePreview";
import { useGameActionConfirm, logGameButton } from "./GameActionConfirm";
import { defaultGameTextFilters, matchesGameTextFilters, limitGameText } from "./GameTextFilterMenu";
import { GameWorkDirectory } from "./GameWorkDirectory";
import { useGameFileDrop } from "../hooks/useGameFileDrop";
import { imageImportPng,type GameImportSource } from "../gameImageImport";
import type { ImageArchiveReplacement } from "../gameImageArchive";
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GAME_IMAGE_SCREENING_LANES, LOCAL_REFINE_MODELS, gameImageRegionLanguageFilter, gameImageTranslationReadiness, localGameImageScreeningLanes } from "../gameImageScreening";
import { defaultUnityImageScreening, needsUnityImageScreening, recognizeUnityReviewCrops, refineUnityImages, refineUnityImagesLocally, screenUnityImages, unityImageRefinementPending, type UnityImageScreeningOptions } from "../unityImageFiltering";
import { gameImageJapaneseTextIssue, gameTextNeedsNoTranslation, preserveTargetGameText } from "../gameDisplayText";
import { dirname, join, resourceDir } from "@tauri-apps/api/path";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readFileBytes } from "../localDocFile";
import { exportUnityTranslations, readUnityTranslationRows, applyUnityTranslationRows, unityTranslationFileName, UnityTranslationImportError, type UnityTranslationImportMode, type UnityTranslationImportIssue } from "../unityTranslationFiles";
import { ClosingProgress } from "./ClosingProgress";
import { unityTranslationQuality } from "../unityTranslationQuality";
import { unityTranslationReadiness, unityCurrentPartProgress } from "../unityTranslationReadiness";
import { UnityExitDialog } from "./UnityExitDialog";
import { api, type Settings, type TranslateProvider, type UnityGameInfo, type OcrMode } from "../api";
import { loadLocalModelProfiles, resolveFeatureLlm } from "../modelPresets";
import { engineReady, parseEngineKeys } from "../translateEngines";
import { gameLocalModelConnection, type GameTranslationKind, buildUnityTranslateOptions, sameUnityGamePath, UNITY_LANGUAGES } from "../unityTranslation";
import { legacyUnityOutputDirectory, mergeUnityProject, UnityPaused, unityRun, unityTranslationError, type UnityEntry, type UnityPatch, type UnityProgress, type UnityProject, type UnityWorkspace, type UnityInspection, type UnityFontPlan, type UnityImage } from "../unityOffline";
import { explainUnityFailure, explainUnityWarning } from "../unityOfflineFeedback";
import { UNITY_STAGE_TABS, unityImageWorkDone, unityImageReadyForTarget, tagLegacyImageTargets, tagEditedImageTranslations, rememberLegacyGameTarget, UNITY_STEPS, unityLanguageScope, unityStageState, unityEntryLanguage, unityLanguageLabel, unityScanUpdate, deploymentMetrics, deploymentMetricScope, isGameDeploymentComplete, measureDeploymentStage } from "../unityWorkflow";
import { unityTranslationStats, unityTranslationContextKey, textTranslationMatchesTarget, tagLegacyTextTargets } from "../unityTranslationSession";
import { type UnityLineMode } from "../unityLineLayout";
import { deploymentSequence, deploymentPhases, loadDeploymentPlan, saveDeploymentPlan, validateDeploymentPlan, type DeploymentActions, type DeploymentModel, type DeploymentPhase, type DeploymentPlan, type DeploymentRun, type DeploymentStep } from "./UnityDeploymentPanel";
import { redrawMosaic, gameDetectorFile, mosaicDetectorKey, openDeploymentDetector, readMosaicSettings, saveMosaicSettings, type MosaicBox } from "../gameMosaic";
import { UnityProjectLoading } from "./UnityProjectLoading";
import { reconcileImageEdit } from "../unityImageEdits";
import { mergeUnityTranslationProject, UnityTranslationStopped, type UnityTranslationPart } from "../unityTranslationJobs";
import { normalizeUnityImageSelection, createUnityImageOcr, translateCurrentUnityImage, processUnityImages, maskUnityImageRegions, unityImageUsesRegionMask, unityImageTranslationRegions } from "../unityImages";
import { OCR_MODE_OPTIONS } from "../ocr/modes";
import { UnityEngineList } from "./UnityEngineList";
import { createUnityEnginePool, loadUnityEngines, normalizeUnityEngines, defaultUnityEngines, UNITY_ENGINE_CHOICES_KEY, type UnityEngineChoice } from "../unityEnginePool";
import { UnityDescriptionSelect, UNITY_WRAP_CHOICES, UNITY_LINE_CHOICES, UNITY_SEGMENT_CHOICES } from "./UnityDescriptionSelect";
import { runImageRegionTranslation, runImageTranslation, unityImagePhaseNames, unityImagePhases,
  useImageOrchestration, type UnityImagePhase } from "./unity-offline/useImageOrchestration";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import { useGameWorkspaceSplit } from "../hooks/useGameWorkspaceSplit";
import { generateOfflinePatch, offlineExportMessage } from "./unity-offline/offlineExport";
import { mapOfflineDeploymentProgress, useOfflineDeploy } from "./unity-offline/useOfflineDeploy";
import { useProjectMount } from "./unity-offline/projectMount";
import { useProjectSwitch, type UnityOfflineHandle } from "./unity-offline/useProjectSwitch";
import { runTextRetry, runTextScreening, runTextTranslation, useTextOrchestration, type UnityTranslationOptions } from "./unity-offline/useTextOrchestration";
import { StepCards, StepProgressDetails, type TranslationCardFlow, type WorkflowTrack } from "./unity-offline/StepCards";
import { DeploySlot, WorkspaceSlots } from "./unity-offline/WorkspaceSlots";
import { useCheckpointParameterWrite, useCheckpointWriter, type GenerationProgress, type RunCheckpoint } from "./unity-offline/useCheckpointWriter";
import { getPausedScanState, usePauseResume } from "./unity-offline/usePauseResume";
import "../unityOffline.css";

export type { UnityOfflineHandle } from "./unity-offline/useProjectSwitch";
const GENERATION_STEPS = UNITY_STEPS;
type TranslationFileStatus = { action: "download" | "import"; state: "working" | "preview" | "done" | "cancelled" | "error"; detail: string; path?: string; folder?: string; issues?: UnityTranslationImportIssue[]; needsValidation?: boolean };
type ImportPreview = { path: string; entries: UnityEntry[]; issues?: UnityTranslationImportIssue[]; remapped?: number; view: { search: string; reviewFilter: "all" | "unfinished" | "quality" | "target"; page: number; imagePart: boolean; activeStep: number } };
const EMPTY_ENTRIES: UnityEntry[] = [];
type UnityImageResetPhase = Exclude<UnityImagePhase, "redraw">;
const imageResetDescriptions: Record<UnityImageResetPhase, string> = {
  filter: "清除初筛、复筛、识别、图片译文和译图，保留原图和文本译文。",
  refine: "恢复初筛结果，清除复筛、正式识别、图片译文和译图，保留原图和文本译文。",
  recognize: "清除识别、图片译文和译图，保留筛选结果。",
  translate: "清除全部图片的区域译文、复核结果和译图，保留筛选与识别结果。",
  review: "恢复复核前的区域译文并清除译图，保留识别和初译结果。",
  render: "清除译图，保留识别结果和图片译文。",
};
const deploymentLabel: Record<DeploymentStep, string> = { scan: "扫描资源", text: "文本翻译", image: "图片翻译", mosaic: "图片去码", apply: "生成与应用" };
const deploymentStageId = { scan: "1", text: "2.1", image: "2.2", mosaic: "2.3", apply: "3" } as const satisfies Record<DeploymentStep, (typeof UNITY_STAGE_TABS)[number]["id"]>;

type Props = {
  active: boolean; game: UnityGameInfo | null; settings: Settings;
  onOpenGeneralSettings?: () => void;
  onBusyChange?: (busy: boolean) => void;
  onInstallationChange?: (root: string, installed: boolean) => void;
  toolbarTarget: HTMLElement | null;
};
function WorkflowElapsed({ elapsed, origin }: { elapsed: number; origin?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (origin === undefined) return;
    const timer = window.setInterval(() => tick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [origin]);
  const ms = origin === undefined ? elapsed : performance.now() - origin;
  return <>{[3600000, 60000, 1000].map((unit, index) => {
    const count = Math.floor(ms / unit);
    return String(index ? count % 60 : count).padStart(2, "0");
  }).join(":")}</>;
}

export const UnityOfflineView = forwardRef<UnityOfflineHandle, Props>(function UnityOfflineView({ active, game, settings, onBusyChange, onInstallationChange, toolbarTarget }, ref) {
  const root = game?.gameDir || "";
  const mosaicDirty = useHasMosaicDrafts(root);
  const [output, setOutput] = useState("");
  const [project, setProject] = useState<UnityProject | null>(null);
  const [deploymentPlanState, setDeploymentPlanState] = useState<{ root: string; plan: DeploymentPlan }>();
  const [deploymentRun, setDeploymentRun] = useState<DeploymentRun | null>(null);
  const [deploymentStop, setDeploymentStop] = useState<{ root: string; step: DeploymentStep }>();
  const [mosaicCompleted, setMosaicCompleted] = useState("");
  const deploymentController = useRef<AbortController | null>(null);
  const [translationKind, setTranslationKind] = useState<GameTranslationKind>("llm");
  const [llmModel, setLlmModel] = useState(() => recommendedGameModels().text || "");
  const [dialogueModel, setDialogueModel] = useState("");
  const [nameModel, setNameModel] = useState("");
  const [imageModel, setImageModel] = useState(() => defaultGameImageTranslation(gameAvailableModels(settings)) || "");
  const [imageReviewModel, setImageReviewModel] = useState(() => defaultGameImageReview(gameAvailableModels(settings)) || "");
  const [engine, setEngine] = useState<TranslateProvider>("bing");
  const [engineChoices, setEngineChoices] = useState<UnityEngineChoice[]>(loadUnityEngines);
  const [engineListExpanded, setEngineListExpanded] = useState(true);
  useEffect(() => { localStorage.setItem(UNITY_ENGINE_CHOICES_KEY, JSON.stringify(engineChoices)); }, [engineChoices]);
  const [source, setSource] = useState("auto");
  const [imagePart, setImagePart] = useState(false);
  const [imageResetRevision, setImageResetRevision] = useState(0);
  const [imageVisionModel,setImageVisionModel] = useState<string|undefined>(() => defaultGameImageVision(gameAvailableModels(settings))), [imageLayoutModel,setImageLayoutModel] = useState<string|undefined>(undefined);
  const { redrawingId, setRedrawingId, imageTask } = useImageOrchestration();
  const [imageRedrawProfile, setImageRedrawProfile] = useState<StyleRedrawProfileId>("turbo");
  const [imageOcrMode, setImageOcrMode] = useState<OcrMode>("fast");
  const [imageConcurrency,setImageConcurrency]=useState(() => navigator.hardwareConcurrency >= 4 ? GAME_IMAGE_SCREENING_LANES : 1);
  const [imageConfidenceThreshold, setImageConfidenceThreshold] = useState(50);
  const [imageScreeningOptions, setImageScreeningOptions] = useState(defaultUnityImageScreening);
  const [textScreenModel, setTextScreenModel] = useState<string | undefined>();
  const { textScreened, setTextScreened, textScreening, setTextScreening, textScreenStarted, setTextScreenStarted,
    textScreenPaused, setTextScreenPaused, translationQueue, retryFailureIds } = useTextOrchestration();
  const [textFilters, setTextFilters] = useState({ ...defaultGameTextFilters });
  const confirmation = useGameActionConfirm(text => logAction(text)); const confirm = confirmation.confirm;
  const [target, setTarget] = useState("zh-CN");
  const [joinLines, setJoinLines] = useState(true);
  const [wrapMode,setWrapMode]=useState<GameWrapMode>("join");
  const [includeContext, setIncludeContext] = useState(false);
  const [skipTargetLanguage, setSkipTargetLanguage] = useState(true);
  const [onlySourceLanguage, setOnlySourceLanguage] = useState(true);
  type PictureTranslation = NonNullable<import("../gameModelPreset").GameTestImageOptions["translation"]>;
  const [pictureRevision, refreshPictureSettings] = useState(0);
  const pictureKey = "llmchat-unity-image-translation:" + root;
  const savedPicture = useMemo((): PictureTranslation | null => {
    const value = localStorage.getItem(pictureKey);
    return value ? JSON.parse(value) : null;
  }, [pictureKey, pictureRevision]);
  const picture: PictureTranslation = savedPicture ?? { source, target, onlySourceLanguage, skipTargetLanguage,
    kind: translationKind, engines: engineChoices, provider: translationKind === "engine" ? engineChoices.find(e=>e.enabled)?.id || "llm" : "llm" };
  function changePicture(patch: Partial<PictureTranslation>) {
    localStorage.setItem(pictureKey, JSON.stringify({ ...picture, ...patch }));
    refreshPictureSettings(value => value + 1);
    invalidatePatch();
  }
  const promptState=useGamePromptSelection(root + ":unity");
  const [lineMode, setLineMode] = useState<UnityLineMode>("local");
  const [lineModel, setLineModel] = useState("");
  const [includeCode, setIncludeCode] = useState(false);
  const [textMode, setTextMode] = useState<"lines" | "paragraphs" | "smart">("smart");
  const [preparingRescan, setPreparingRescan] = useState(false);
  const [codeAssemblies, setCodeAssemblies] = useState<string[] | null>(null);
  const [typeDirectory, setTypeDirectory] = useState("");
  const [extraCharacters, setExtraCharacters] = useState("");
  const [inspection, setInspection] = useState<UnityInspection | null>(null);
  const [inspectionError, setInspectionError] = useState("");
  const [fontPlan, setFontPlan] = useState<UnityFontPlan | null>(null);
  const [activeStep, setWorkflowStep] = useState(1);
  const [mosaicPage, setMosaicPage] = useState(false);
  const [mosaicBusy, setMosaicBusy] = useState(false);
  const [mosaicWorkbenchState, setMosaicWorkbenchState] = useState<{ root: string; complete: boolean }>();
  const [mosaicControls, setMosaicControls] = useState<HTMLDivElement | null>(null);
  const [mosaicStatus, setMosaicStatus] = useState<{ root: string; candidates: MosaicCandidateIndex; savedDrafts?: ReadonlySet<string>; error?: string }>();
  const setActiveStep = useCallback((step: number) => { setMosaicPage(false); setWorkflowStep(Math.min(step, 3)); }, []);
  const followProgress = useRef(true);
  const restoredStageRoot = useRef("");
  const [fontPath, setFontPath] = useState("");
  const [search, setSearch] = useState("");
  const [reviewFilter, setReviewFilter] = useState<"all" | "unfinished" | "quality" | "target">("all");
  const lastDownloadScope = useRef<"all" | "filtered">("all");
  const errorsOnly = reviewFilter === "unfinished";
  const [qualityIssueId, setQualityIssueId] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<UnityTranslationImportMode>("fill");
  const [page, setPage] = useState(0);
  const [workflowBusy, setBusy] = useState("");
  const busy = workflowBusy || (mosaicBusy ? "图片去码" : "");
  const imageLeaveGuard=useRef<((change:()=>void)=>void)|null>(null);
  const outputStage = mosaicPage ? "图片去码" : activeStep === 2 ? imagePart ? "图片翻译" : "文本翻译" :
    activeStep === 3 ? "生成与应用" : GENERATION_STEPS[activeStep - 1] || "工程";
  const [localActivity, setLocalActivity] = useState<{ images: boolean; value: GenerationProgress } | null>(null);
  const lastOperationError = useRef("");
  const logAction = (text: string, level: OutputLevel = "info", stage = outputStage, task?: string) =>
    writeOutput(["游戏翻译", "Unity", "嵌入翻译", stage], text, level, level === "error" || level === "warning", task);
  const textLog = (text: string, level?: OutputLevel) => logAction(text, level, "文本翻译");
  const imageLog = (text: string, level?: OutputLevel) => logAction(text, level, "图片翻译");
  const showLocalActivity = (detail: string, state: GenerationProgress["state"] = "running", images = imagePart, completed = 0, total: number | null = null) => setLocalActivity({ images, value: { step: activeStep, detail, state, completed, total } });
  useEffect(() => { setLocalActivity(null); }, [root]);
  const [imageEditorBusy,setImageEditorBusy]=useState("");
  const imageEditorWork=useRef<Promise<void>|null>(null),imageEditorAbort=useRef<AbortController|null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [fileStatus, setFileStatus] = useState<TranslationFileStatus | null>(null);
  const [importIssuePage, setImportIssuePage] = useState(0);
  const importIssues = fileStatus?.issues || [];
  const importIssuePages = Math.max(1, Math.ceil(importIssues.length / 20));
  const visibleImportIssuePage = Math.min(importIssuePage, importIssuePages - 1);
  const visibleImportIssues = importIssues.slice(visibleImportIssuePage * 20, (visibleImportIssuePage + 1) * 20);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const importPreviewRef = useRef(importPreview); importPreviewRef.current = importPreview;
  const applyImportRef = useRef<() => Promise<boolean>>(async () => false);
  const pendingEdits = useRef(new Set<string>());
  const tableEntries = importPreview?.entries ?? project?.entries ?? EMPTY_ENTRIES;
  const [message, setMessage] = useState("");
  const [patch, setPatch] = useState<UnityPatch | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false), [saveNotice, setSaveNotice] = useState("");
  const [applyingTestConfiguration, setApplyingTestConfiguration] = useState(false);
  const [configurationRevision, setConfigurationRevision] = useState(0);
  const [saveComplete, setSaveComplete] = useState(false);
  const [savedChanges, setSavedChanges] = useState<string[]>([]);
  const imageDraftOriginals=useRef(new Map<string,UnityImage>());
  const textDraftOriginals = useRef(new Map<string,UnityEntry>());
  const pendingImageMasks = useRef(new Map<string, boolean>());
  const [generationState, setGeneration] = useState<GenerationProgress | null>(null);
  const { applied, setApplied, installed, setInstalled, applyPatch, uninstallPatch: runUninstall, removeLayer } = useOfflineDeploy({
    root, run: unityRun, measure: measureDeploymentStage, setBusy, setMessage, logAction, onInstallationChange,
  });

  const [checkpoint, setCheckpoint] = useState<RunCheckpoint | null>(null);
  const checkpointRef = useRef<RunCheckpoint | null>(null);
  const { translationJobs, abort, startWorkflow, runWorkflow, startTranslationPart, stop, stopPart, resumeTask } = usePauseResume(() => ({
    root, project, patch, checkpoint, checkpointRef, latest, running, taskWrites, projectWrites, elapsedOrigins,
    translationKind, llmModel, dialogueModel, nameModel, imageModel, imageReviewModel, engine, engineChoices,
    source, target, joinLines, wrapMode, textScreenModel, includeContext, skipTargetLanguage, onlySourceLanguage,
    lineMode, lineModel, imageOcrMode, imageVisionModel, imageLayoutModel, imageRedrawProfile, imageConcurrency,
    imageConfidenceThreshold, imageScreeningOptions, includeCode, fontPath, textMode, codeAssemblies, typeDirectory, extraCharacters,
    picture, imagePart, imageTask, imageThreshold, imageMode, imageEditorAbort, imageEditorWork,
    imageConfigurationCommit, textConfigurationCommit, retryFailureIds, textScreened, followProgress,
    importPreviewRef, applyingTestConfiguration, restoring, preparingRescan, needsScan, scanUpdate, busy, dirty, mosaicBusy,
    settings, promptState, isTextReady: () => textReady, getExecution: () => execution.current,
    publish, projectCheckpoint, remember, save, saveTranslation, loadProject, scan, exportPatch, applyPatch, operation,
    confirm, logAction, setActionError, setPreparingRescan, setPatch, setFontPlan, setActiveStep, setImagePart, setBusy,
    setMessage, setTextScreened, setLocalActivity,
  }));
  const imageMode = useRef(imageOcrMode); imageMode.current = imageOcrMode;
  const imageThreshold = useRef(imageConfidenceThreshold); imageThreshold.current = imageConfidenceThreshold;
  const [restoring, setRestoring] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState("");
  const reportRestore = (notices: string[]) => {
    for (const notice of notices) writeOutput(["游戏翻译", "Unity", "工程恢复"], notice);
  };
  useOutputMessage(["游戏翻译", "Unity", "工程状态"], message);
  const taskError = error || actionError;
  useOutputMessage(["游戏翻译", "Unity", "任务错误"], taskError !== lastOperationError.current ? taskError : "", "error");
  useOutputMessage(["游戏翻译", "Unity", "文本翻译", fileStatus?.action === "import" ? "导入" : "下载"], fileStatus?.detail,
    fileStatus?.state === "error" ? "error" : "info", fileStatus?.state === "error" || fileStatus?.state === "preview");
  useOutputMessage(["游戏翻译", "Unity", "生成补丁", "字体"], patch?.fontMappings?.join("\n"));
  const [workRoot, setWorkRoot] = useState("");
  const [rowIssue, setRowIssue] = useState<UnityEntry | null>(null);
  const [rowJump, setRowJump] = useState<{ id: string; sequence: number; error: boolean } | null>(null);
  const { workspaceRef, workspaceStyle, panelRef, panelStyle, dividerProps } = useGameWorkspaceSplit(active && activeStep !== 3, mosaicPage);
  const workflowRef = useRef<HTMLElement>(null);
  const sourceWidth = usePersistedWidth("unity-offline-source-width", 112, 80, 280);
  const [originalRatio, setOriginalRatio] = useState(() => Math.min(70, Math.max(20, Number(localStorage.getItem("unity-offline-original-ratio")) || 45)));
  const tableRef = useRef<HTMLTableElement>(null);
  const columnDrag = useRef<{ x: number; ratio: number; width: number; latest: number } | null>(null);
  const checkpointKey = "llmchat-unity-run:" + root.toLowerCase();
  const textConfigurationCommit = useRef<GameStepConfigurationCommit | null>(null);
  const imageConfigurationCommit = useRef<GameStepConfigurationCommit | null>(null);
  const { remember, taskWrites, projectWrites, queueProjectWrite, elapsedOrigins, resetQueuedSignature } = useCheckpointWriter({
    root, checkpointRef, setCheckpoint, setGeneration, setError,
    getActiveParameters: () => abort.current ? execution.current.parameters : undefined,
  });
  const running = useRef<Promise<void> | null>(null);
  const latest = useRef(project); latest.current = project;
  const publish = (value: UnityProject) => { latest.current = value; setProject(value); };
  const scanUpdate = unityScanUpdate(project, checkpoint, { includeCode, textMode, typeDirectory, codeAssemblies });
  const needsScan = scanUpdate.level === "required";
  useEffect(() => { workflowRef.current?.scrollTo({ top: 0 }); }, [activeStep, imagePart, mosaicPage]);
  useProjectMount<RunCheckpoint>(root, {
    run: unityRun, outputDirectory: legacyUnityOutputDirectory,
    readLegacyTask: () => localStorage.getItem(checkpointKey),
    removeLegacyTask: () => localStorage.removeItem(checkpointKey),
    resetView: () => {
      restoredStageRoot.current = "";
      setProject(null); setPatch(null); setDirty(false); textDraftOriginals.current.clear(); imageDraftOriginals.current.clear();pendingImageMasks.current.clear(); pendingEdits.current.clear(); setImportPreview(null); setSaveComplete(false); setPage(0); setSearch(""); setFileStatus(null); setRowJump(null);
      setReviewFilter("all"); setQualityIssueId(null); setImportMode("fill");
      setError(""); setActionError(""); setMessage(""); setFontPath(""); setLlmModel(recommendedGameModels().text || ""); setDialogueModel(""); setNameModel(""); setImageModel(""); setImageReviewModel(""); setJoinLines(true); setIncludeContext(false); setOnlySourceLanguage(true);
      setLineMode("local"); setLineModel("");
      setImageConfidenceThreshold(50);
      setGeneration(null); setApplied(false); setInstalled(false);
      setTextMode("smart"); setCodeAssemblies(null); setTypeDirectory(""); setExtraCharacters(""); setFontPlan(null);
      setPreparingRescan(false);
      setActiveStep(1); setImagePart(false); followProgress.current = true;

      setWorkRoot(""); setOutput(""); setRowIssue(null); resetQueuedSignature();
      setCheckpoint(null); checkpointRef.current = null;
    },
    resetScreening: () => setImageScreeningOptions(defaultUnityImageScreening),
    setLoadingDetail, setRestoring, setInspection, setInspectionError, reportError: setError, reportRestore,
    setWorkspaceFolders: workspace => { setWorkRoot(workspace.workRoot); setOutput(workspace.projectsRoot); },
    loadProject, projectCheckpoint,
    restoreView: (workspace, p, value) => {
      if (p) {
        const legacyTarget = rememberLegacyGameTarget(root, "unity", value?.target || "zh-CN");
        tagLegacyTextTargets(p.entries, legacyTarget);
        tagLegacyImageTargets(p.images || [], legacyTarget);
        if (p.images) p.images = p.images.map(normalizeUnityImageSelection);
      }
      setProject(p);
      setInstalled(workspace.installed);
      setApplied(workspace.installed && !!value?.patch && value.step === 4 && value.progress.state === "done"); onInstallationChange?.(root, workspace.installed);
      if (value) {
        if ((value.lineMode as string) === "hanlp") value.lineMode = "wtp";
        if (value.scopeVersion !== 1) value = { ...value, source: value.finished && !value.patch && value.endStep < 3 ? value.source : "all", scopeVersion: 1 };
        setPatch(value.patch); setTextScreenModel(value.textScreenModel); setIncludeContext(value.includeContext ?? false); setSkipTargetLanguage(value.skipTargetLanguage ?? true); setOnlySourceLanguage(value.onlySourceLanguage ?? true);
        setTranslationKind(value.translationKind); setLlmModel(value.llmModel || recommendedGameModels().text || ""); setDialogueModel(value.dialogueModel || ""); setNameModel(value.nameModel || ""); setImageModel(value.imageModel || ""); setImageReviewModel(value.imageReviewModel || ""); setEngine(value.engine); setSource(value.source); setTarget(value.target); setJoinLines(value.joinLines ?? true); setWrapMode(value.wrapMode||(value.joinLines===false?"keep":"join")); setIncludeCode(value.includeCode); setFontPath(value.fontPath);
        setEngineChoices(value.engines ? normalizeUnityEngines(value.engines) : defaultUnityEngines());
        setLineMode(value.lineMode || "local"); setLineModel(value.lineModel || "");
        setTextMode(value.textMode || p?.textMode || "paragraphs"); setCodeAssemblies(value.codeAssemblies ?? null); setTypeDirectory(value.typeDirectory || ""); setExtraCharacters(value.extraCharacters || "");
        if (!value.finished && value.step === 2 && !value.imageOnly && p) {
          const ids = unityLanguageScope(p.entries, value.source, value.onlySourceLanguage !== false).ids;
          const rows = p.entries.filter(e => e.selected && ids.has(e.id));
          value.progress = { ...value.progress, ...unityTranslationStats(rows, unityTranslationError, unityTranslationContextKey), translation: undefined, detail: "已恢复有效译文；主进度按语境内去重后的原文计算，未完成项可继续" };
        }
        if (value.translationRuns && p) {
          const ids = unityLanguageScope(p.entries, value.source, value.onlySourceLanguage !== false).ids;
          const rows = p.entries.filter(entry => entry.selected && ids.has(entry.id));
          value.translationRuns.text = { ...value.translationRuns.text, ...unityTranslationStats(rows, unityTranslationError, unityTranslationContextKey), translation: undefined };
          const images = (p.images || []).filter(image => image.selected);
          value.translationRuns.images = { ...value.translationRuns.images, completed: images.filter(image => image.completed).length, total: images.length };
          if (!value.finished) for (const progress of Object.values(value.translationRuns)) if (progress.state === "running") progress.state = "stopped";
        }
        const prepared = value.step === 1 && value.progress.state === "pending" && !!value.previousProjectFolder && !value.scanFolder;
        setPreparingRescan(prepared);
        if (!value.finished && value.progress.state !== "error" && !prepared) value.progress.state = "stopped";
        remember(value);
        setActiveStep(value.step); setImagePart(!!value.imageOnly); setImageVisionModel(value.imageVisionModel); setImageLayoutModel(value.imageLayoutModel); setImageRedrawProfile(value.imageRedrawProfile ?? "turbo"); setImageOcrMode(value.imageOcrMode || "fast"); imageTask.current = value.imageTask || "filter";
        setImageConcurrency(value.imageConcurrency??2);setImageConfidenceThreshold(value.imageConfidenceThreshold ?? 50);
        setImageScreeningOptions(value.imageScreeningOptions ?? defaultUnityImageScreening);
        if (value.finished && value.endStep !== 4) setGeneration(null);
        if (value.progress.state === "error") setError(value.progress.failure || "上次任务未能完成，可以重试。已有工程和译文仍保留。");
        else if (!value.finished) setMessage("已从游戏工作目录加载未完成任务，点击恢复可继续。");
        else if (p) setMessage("已自动加载上次保存的工程。");
      }
      const stage = loadGameStage(root, true);
      if (stage && (p || stage.step === 1)) {
        setWorkflowStep(Math.min(stage.step, 3));
        setImagePart(stage.step === 2 && stage.part === "images");
        setMosaicPage(stage.part === "mosaic");
        followProgress.current = false;
      }
      restoredStageRoot.current = root;
    },
    waitForTaskWrites: () => taskWrites.current,
  });
  useEffect(() => {
    if (root && active && !restoring && restoredStageRoot.current === root) {
      rememberGameStage(root, activeStep, mosaicPage ? "mosaic" : imagePart ? "images" : "text");
    }
  }, [root, active, restoring, activeStep, imagePart, mosaicPage]);
  const formalUnfinished = !preparingRescan && !!checkpoint && !checkpoint.finished &&
    ["stopped", "error"].includes(checkpoint.progress.state);
  const formalProgress = localActivity?.value.state === "running" ? localActivity.value :
    generationState?.state === "running" ? generationState : formalUnfinished ? checkpoint.progress : undefined;
  const formalImagePhase = checkpoint?.imageTask ?? imageTask.current;
  const formalLabel = restoring ? "恢复工程" : textScreening ? "筛选文本" : imageEditorBusy ||
    deploymentRun?.steps.map(step => deploymentLabel[step]).join("、") ||
    (formalProgress?.step === 2 && (checkpoint?.imageOnly || localActivity?.images) ? unityImagePhaseNames[formalImagePhase] :
      formalProgress ? GENERATION_STEPS[formalProgress.step - 1] : workflowBusy || "工程处理");
  useFormalWorkflowActivity(!!workflowBusy || restoring || textScreening || !!imageEditorBusy, game?.gameDir || root,
    formalLabel, formalProgress?.completed ?? undefined, formalProgress?.total ?? undefined, formalUnfinished,
    formalProgress?.failure || formalProgress?.detail);
  const testing = useBenchmarkRunning();
  const testTitle = testing ? benchmarkBlockingReason : undefined;
  useEffect(() => { onBusyChange?.(!!busy || restoring || applyingTestConfiguration); }, [busy, restoring, applyingTestConfiguration, onBusyChange]);
  useEffect(() => {
    if (!root || !project?.folder) return;
    let current = true;
    void unityRun<{ candidates: MosaicCandidateIndex }>("mosaic-status", { root }).then(
      result => { if (current) setMosaicStatus({ root, candidates: result.candidates }); },
      error => { if (current) setMosaicStatus({ root, candidates: {}, error: String(error) }); },
    );
    return () => { current = false; };
  }, [root, project?.folder]);
  useEffect(() => {
    if (!saveComplete) return;
    const timer = window.setTimeout(() => setSaveComplete(false), 4500);
    return () => window.clearTimeout(timer);
  }, [saveComplete]);
  const parameterSignature = JSON.stringify({ translationKind, llmModel, dialogueModel, nameModel, imageModel, imageReviewModel, engine, engineChoices, source, target, joinLines, wrapMode, textScreenModel, includeContext, skipTargetLanguage, onlySourceLanguage, lineMode, lineModel, imageOcrMode, imageVisionModel, imageLayoutModel, imageRedrawProfile, imageConcurrency, imageConfidenceThreshold, imageScreeningOptions, includeCode, fontPath, textMode, codeAssemblies, typeDirectory, extraCharacters });
  const saveConfiguration=async()=>{
    parameterWrite.current?.();const current=latest.current;if(!current)throw new Error("请先扫描资源");
    remember({...(checkpointRef.current||projectCheckpoint(current)),translationKind,llmModel,dialogueModel,nameModel,imageModel,imageReviewModel,engine,engines:engineChoices,source,target,joinLines,wrapMode,textScreenModel,includeContext,skipTargetLanguage,onlySourceLanguage,lineMode,lineModel,imageOcrMode,imageVisionModel,imageLayoutModel,imageRedrawProfile,imageConcurrency,imageConfidenceThreshold, imageScreeningOptions,includeCode,fontPath,textMode,codeAssemblies,typeDirectory,extraCharacters});
    await taskWrites.current;
  };
  const parameterWrite = useCheckpointParameterWrite(parameterSignature, restoring, project, () => {
    const current = latest.current; if (!current) return;
    remember({ ...(checkpointRef.current || projectCheckpoint(current)), translationKind, llmModel, dialogueModel, nameModel, imageModel, imageReviewModel, engine, engines: engineChoices, source, target, joinLines, wrapMode, textScreenModel, includeContext, skipTargetLanguage, onlySourceLanguage, lineMode, lineModel, imageOcrMode, imageVisionModel, imageLayoutModel, imageRedrawProfile, imageConcurrency, imageConfidenceThreshold, imageScreeningOptions, includeCode, fontPath, textMode, codeAssemblies, typeDirectory, extraCharacters });
  });

  const { closing, closingPhase, showClosing, exitPrompt, resolveExitChoice } = useProjectSwitch({
    ref, active, hasProject: project !== null, restoring, busy, imageEditorBusy, dirty, importPreview,
    pendingChanges: () => [...pendingEdits.current],
    importPreviewCount: () => importPreviewRef.current?.entries.length,
    hasRunningWork: () => !!(imageEditorWork.current || running.current),
    flushParameters: () => parameterWrite.current?.(),
    waitForProjectWrites: () => projectWrites.current, waitForTaskWrites: () => taskWrites.current,
    abortWork: () => { deploymentController.current?.abort(); abort.current?.abort(); imageEditorAbort.current?.abort(); },
    waitForRunningWork: async () => { await running.current?.catch(() => {}); await imageEditorWork.current?.catch(() => {}); },
    hasCurrentProject: () => !!latest.current,
    applyImportPreview: () => applyImportRef.current(),
    saveProject: () => save(),
    reportError: setError,
  });

  const scope = useMemo(() => unityLanguageScope(project?.entries || [], source, onlySourceLanguage), [project, source, onlySourceLanguage]);
  const sourceLanguages = useMemo(() => [...new Set(["ja", "en", "ko", "zh", "ru", ...(project?.entries.map(unityEntryLanguage) || [])])].filter(language => !["und", "cjk", "all"].includes(language)), [project]);
  const selected = useMemo(() => project?.entries.filter(e => e.selected && scope.ids.has(e.id)) || [], [project, scope]);
  const engineConfigured = engineChoices.some(row => row.enabled && engineReady(parseEngineKeys(settings.translateEngineKeys), row.id));
  const gameModels = gameAvailableModels(settings);
  const stageModels = imagePart ? [imageModel, imageReviewModel] : [llmModel, dialogueModel, nameModel];
  const connectionReady = translationKind === "engine" ? engineConfigured : stageModels.every((model, index) => {
    if (index && !model) return true;
    if (!gameModels.includes(model)) return false;
    const connection = translationKind === "local" && !model ? gameLocalModelConnection(settings.model) : resolveFeatureLlm(settings, model);
    return !!connection.model.trim() && !!connection.apiUrl.trim();
  });
  const readiness = useMemo(() => unityTranslationReadiness(project, selected, unityTranslationError, !!checkpoint?.partial, target, picture.target), [project, selected, checkpoint?.partial, target, picture.target]);
  const done = readiness.validText;
  useOutputMessage(["游戏翻译", "Unity", "恢复任务"], checkpoint?.translationFailure, "error");
  useOutputMessage(["游戏翻译", "Unity", "生成补丁"], checkpoint?.partial ? `仅回写 ${done} 条有效译文，其余 ${selected.length - done} 条保持原文。` : null);
  const currentParts = checkpoint?.translationRuns && {
    text: unityCurrentPartProgress(checkpoint.translationRuns.text, "text", readiness, !!checkpoint.layoutOnly)!,
    images: checkpoint.imageTask === "redraw" ? checkpoint.translationRuns.images : unityCurrentPartProgress(checkpoint.translationRuns.images, "images", readiness)!,
  };
  const generation = localActivity && localActivity.value.step === activeStep && (activeStep !== 2 || localActivity.images === imagePart) ? localActivity.value : (activeStep === 2 && currentParts ? currentParts[imagePart ? "images" : "text"]
    : generationState?.step === 2 && !(checkpoint?.imageOnly && checkpoint.imageTask === "redraw")
      ? unityCurrentPartProgress(generationState, checkpoint?.imageOnly ? "images" : "text", readiness, !!checkpoint?.layoutOnly) : generationState) ?? null;
  const qualityCache = useMemo(() => new WeakMap<UnityEntry, { source: string; translation: string; warnings: string[] }>(), [target]);
  const qualityIssues = useMemo(() => {
    const issues = new Map<string, string[]>();
    for (const entry of tableEntries) {
      if (!importPreview && !scope.ids.has(entry.id)) continue;
      let cached = qualityCache.get(entry);
      if (!cached || cached.source !== entry.source || cached.translation !== entry.translation) {
        cached = { source: entry.source, translation: entry.translation, warnings: unityTranslationQuality(entry.source, entry.translation, target) };
        qualityCache.set(entry, cached);
      }
      const warnings = cached.warnings;
      if (warnings.length) issues.set(entry.id, warnings);
    }
    return issues;
  }, [tableEntries, importPreview, scope.ids, target, qualityCache]);
  const qualityIssue = qualityIssueId ? qualityIssues.get(qualityIssueId) : undefined;
  const entryProblem = (entry: UnityEntry) => entry.error || (!importPreview && entry.translation ? unityTranslationError(entry.source, entry.translation) : "");
  const textSearchSnapshot = useRef<{ key: string; ids: Set<string> } | null>(null);
  const targetTextIds = useMemo(() => new Set((project?.entries || []).filter(entry => gameTextNeedsNoTranslation(entry.source, target)).map(entry => entry.id)), [project?.folder, project?.entries.length, target]);
  const [locateAcrossLanguages, setLocateAcrossLanguages] = useState(false);
  useEffect(() => setLocateAcrossLanguages(false), [project?.folder, source, onlySourceLanguage]);
  const textSearchKey = JSON.stringify([locateAcrossLanguages, project?.folder, importPreview?.path, search, source, target, reviewFilter, errorsOnly, textFilters]);
  const hasTextDraft = !!importPreview || dirty && [...pendingEdits.current].some(key => key.startsWith("文本与译文：") || key.startsWith("文本勾选："));
  const matched = useMemo(() => {
    // Preserve result membership while typing; render the latest entry values.
    if (search && hasTextDraft && textSearchSnapshot.current?.key === textSearchKey) {
      const ids = textSearchSnapshot.current.ids;
      return tableEntries.filter(entry => ids.has(entry.id));
    }
    const results = tableEntries.filter(e => matchesGameTextFilters(textFilters, e.selected, !!e.translation && !unityTranslationError(e.source, e.translation) && !e.error, !!e.error, qualityIssues.has(e.id), targetTextIds.has(e.id)) && (importPreview || locateAcrossLanguages || scope.ids.has(e.id)) && (!errorsOnly || (importPreview ? e.error : e.error || unityTranslationError(e.source, e.translation))) && (reviewFilter !== "quality" || qualityIssues.has(e.id)) && (reviewFilter !== "target" || targetTextIds.has(e.id)) && (!search || `${e.source}\n${e.translation}\n#${e.id} · ${e.kind}${e.locale ? ` · ${unityLanguageLabel(unityEntryLanguage(e))}` : ""}\n${e.file}\n${e.container}\n${e.locator}\n对象 #${e.objectId === "0" ? e.id : e.objectId}`.toLowerCase().includes(search.toLowerCase())));
    textSearchSnapshot.current = search ? { key: textSearchKey, ids: new Set(results.map(entry => entry.id)) } : null;
    return results;
  }, [tableEntries, importPreview, search, scope, errorsOnly, reviewFilter, qualityIssues, hasTextDraft, textSearchKey, targetTextIds, textFilters, locateAcrossLanguages]);
  const filtered = useMemo(() => limitGameText(matched, textFilters.limit), [matched, textFilters.limit]);
  const checkedCount = filtered.reduce((count, entry) => count + Number(entry.selected), 0);
  const hasMixedSelection = checkedCount > 0 && checkedCount < filtered.length;
  const pageCount = Math.max(1, Math.ceil(filtered.length / 40));
  const visiblePage = Math.max(0, Math.min(page, pageCount - 1));
  const rows = filtered.slice(visiblePage * 40, (visiblePage + 1) * 40);
  const translationFailures = useMemo(() => project?.entries.filter(entry => !!entry.error) || [], [project?.entries]);
  useEffect(() => {
    if (project?.root && !dirty && !saving && !importPreview) rememberRecentGameFailures(project.root, "text", translationFailures.length);
  }, [project?.root, dirty, saving, importPreview, translationFailures.length]);
  const locateTranslationFailure = (id: string) => {
    const item = tableEntries.find(entry => entry.id === id);
    if (!item) return;
    let index = filtered.findIndex(entry => entry.id === id);
    if (index < 0) {
      const allLanguages = locateAcrossLanguages || (!importPreview && !scope.ids.has(id));
      const candidates = tableEntries.filter(entry => importPreview || allLanguages || scope.ids.has(entry.id));
      index = candidates.findIndex(entry => entry.id === id);
      setLocateAcrossLanguages(allLanguages);
      textSearchSnapshot.current = null;
      setSearch(""); setReviewFilter("all"); setTextFilters({ ...defaultGameTextFilters });
    }
    setRowIssue(null); setQualityIssueId(null);
    setPage(Math.floor(index / 40));
    setRowJump(previous => ({ id, sequence: (previous?.sequence || 0) + 1, error: !!(entryProblem(item) || fileStatus?.issues?.some(issue => issue.id === id)) }));
  };
  useEffect(() => {
    if (!rowJump) return;
    const row = Array.from(tableRef.current?.querySelectorAll<HTMLTableRowElement>("tbody tr[data-entry-id]") || []).find(element => element.dataset.entryId === rowJump.id);
    row?.scrollIntoView({ block: "center", inline: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    row?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => setRowJump(previous => previous === rowJump ? null : previous), 2200);
    return () => window.clearTimeout(timer);
  }, [rowJump]);
  const update = (id: string, value: Partial<UnityProject["entries"][number]>) => {
    if (importPreviewRef.current) {
      setImportPreview(previous => previous && { ...previous, entries: previous.entries.map(entry => {
        if (entry.id !== id) return entry;
        return { ...entry, ...value, error: entry.error };
      }) });
      setFileStatus(previous => previous && { ...previous, needsValidation: true });
      return;
    }
    editTextEntries(new Set([id]), value);
  };
  const editTextEntries = (ids: ReadonlySet<string>, value: Partial<UnityEntry>) => {
    const project = latest.current;
    if (!project) return;
    let changed = false;
    const entries = project.entries.map(entry => {
      if (!ids.has(entry.id) || Object.entries(value).every(([key, next]) => entry[key as keyof UnityEntry] === next)) return entry;
      changed = true;
      const original = textDraftOriginals.current.get(entry.id) || entry;
      const next = value.translation === undefined
        ? { ...entry, ...value }
        : value.translation === original.translation ? { ...original, selected: entry.selected } : { ...entry, ...value, translationTarget: target, error: "" };
      const key = "文本与译文：第 " + entry.id + " 条";
      if (sameTextEdit(next, original)) {
        textDraftOriginals.current.delete(entry.id);
        pendingEdits.current.delete(key);
      } else {
        textDraftOriginals.current.set(entry.id, original);
        pendingEdits.current.add(key);
      }
      return next;
    });
    if (!changed) return;
    publish({ ...project, entries });
    setDirty(pendingEdits.current.size > 0);
    if (textDraftOriginals.current.size) { invalidatePatch(); setFontPlan(null); }
  };
  async function operation(label: string, task: () => Promise<void>, keepProgress = true, reportError: (message: string) => void = setError) {
    if (isBenchmarkRunning() || mosaicBusy || running.current || imageEditorWork.current) return false;
    if (importPreviewRef.current && label !== "应用导入预览" && label !== "导入翻译文件") { setActionError("请先应用或取消右侧的导入预览"); return false; }
    if (!keepProgress) setGeneration(null);
    setBusy(label); setError(""); setActionError(""); setMessage(""); logAction(`开始${label}`); if (label === "准备任务") setLocalActivity(null); else showLocalActivity(`${label}：正在准备…`);
    const taskKey = label === "准备任务" ? undefined : JSON.stringify([root, outputStage, label]);
    lastOperationError.current = "";
    const work = task(); running.current = work;
    try { await work; logAction(`${label}完成`, "success", outputStage, taskKey); if (label !== "准备任务") showLocalActivity(`${label}完成${label === "重新识别准备" ? "，请点击开始识别" : ""}`, /准备|清理/.test(label) ? "pending" : "done", imagePart, /准备|清理/.test(label) ? 0 : 1, 1); return true; } catch (e) { const text = e instanceof Error ? e.message : String(e); lastOperationError.current = text; reportError(text); logAction(`${label}失败：${text}`, "error", outputStage, taskKey); showLocalActivity(`${label}失败：${text}`, "error"); return false; }
    finally { running.current = null; setBusy(""); }
  }
  function projectCheckpoint(p: UnityProject, incomplete = false, completed: number | null = 1, total: number | null = 1): RunCheckpoint {
    return { step: 1, endStep: 1, automatic: false, finished: !incomplete, projectFolder: p.folder, scanFolder: incomplete ? p.folder : "", patchFolder: "", patch: null,
      translationKind, llmModel, dialogueModel, nameModel, imageModel, imageReviewModel, engine, engines: engineChoices, source, target, joinLines, wrapMode, textScreenModel, includeContext, skipTargetLanguage, onlySourceLanguage, lineMode, lineModel, includeCode, fontPath, textMode, codeAssemblies, typeDirectory, extraCharacters, scopeVersion: 1,
      progress: { step: 1, state: incomplete ? "stopped" : "done", detail: incomplete ? "已加载扫描检查点" : "已加载保存工程", completed: completed || 0, total } };
  }
  async function loadProject(folder: string, previousFolder?: string, onLoading?: (detail: string) => void) {
    onLoading?.("正在加载工程原文、译文及字体信息…");
    let p = await unityRun<UnityProject>("load", { path: folder + "/unity-project.json" });
    if (!sameUnityGamePath(p.root, root)) throw new Error("工作目录中的工程不属于当前游戏，请检查游戏工作文件夹");
    if (previousFolder && !sameUnityGamePath(previousFolder, folder)) {
      onLoading?.("正在读取旧工程并匹配可复用译文…");
      const previous = await unityRun<UnityProject>("load", { path: previousFolder + "/unity-project.json" });
      if (!sameUnityGamePath(previous.root, root)) throw new Error("旧工程不属于当前游戏");
      p = mergeUnityProject(previous, p);
      await unityRun("save", { project: p });
    }
    return p;
  }
  async function restartStage(step: number, restart = false, phase?: UnityImageResetPhase) {
    if (busy || restoring) return;
    const imageReset = step === 2 && imagePart ? phase ?? "recognize" : undefined;
    if (imageReset && (!project || saving || imageEditorBusy || importPreview)) return;
    if (step === 1) {
      if (!project || !await confirm("重新读取游戏资源，匹配后复用已有译文、图片处理结果和勾选状态。旧扫描进度、字库检查和未安装补丁将重新生成。", { title: "重新扫描资源", kind: "warning", okLabel: "继续重新扫描", cancelLabel: "取消" })) return;
      await operation("准备重新扫描", async () => {
        if (dirty) await save(); await taskWrites.current; await projectWrites.current;
        const workspace = await unityRun<UnityWorkspace<RunCheckpoint>>("prepare-rescan", { root, path: project.folder, task: { ...(checkpointRef.current || projectCheckpoint(project)), translationKind, llmModel, dialogueModel, nameModel, imageModel, imageReviewModel, engine, engines: engineChoices, source, target, joinLines, wrapMode, textScreenModel, includeContext, skipTargetLanguage, onlySourceLanguage, lineMode, lineModel, includeCode, fontPath, textMode, codeAssemblies, typeDirectory, extraCharacters } });
        publish(workspace.saved.project!); remember(workspace.task!); await taskWrites.current;
        setPreparingRescan(true); setActiveStep(1); followProgress.current = false;
        setPatch(null); setFontPlan(null);
        setRowIssue(null); setFileStatus(null); setMessage(""); setDirty(false);
      });
      return;
    }
    const cleanup = step === 3 ? "当前工程的字库检查、补丁及应用记录，保留扫描和译文" : "应用记录，恢复游戏原件，保留校验通过的补丁、扫描和译文";
    const imageResetLabel = imageReset ? "清理" + unityImagePhaseNames[imageReset] : "";
    if (step === 2) {
      if (!await confirmation.ask(imageReset ? imageResetLabel : restart ? "重新翻译" : "清理译文缓存",
        imageReset ? imageResetDescriptions[imageReset] : "将删除已有译文和排版草稿。")) return;
    } else if (!await confirm(`重做此步骤将清除${cleanup}，已安装补丁保留至下次应用。`, { title: "重做步骤", kind: "warning", okLabel: "清理", cancelLabel: "取消" })) return;
    await operation(imageReset ? imageResetLabel : step === 2 ? restart ? "重新翻译准备" : "清理译文缓存" : "清理旧产物", async () => {
      if (imageReset) imageTask.current = imageReset;
      showLocalActivity("正在保存当前修改并等待清理…", "running");
      if (dirty) await save(); await taskWrites.current; await projectWrites.current;
      const beforeCleanup = latest.current;
      const cleanupCounts = { text: beforeCleanup?.entries.filter(e => !!e.translation).length || 0, drafts: beforeCleanup?.entries.filter(e => !!e.layoutDraft).length || 0, errors: beforeCleanup?.entries.filter(e => !!e.error).length || 0, images: beforeCleanup?.images?.filter(e => e.ocrCompleted || e.regions.length || e.renderedFile).length || 0 };
      const task = checkpointRef.current || (project && projectCheckpoint(project));
      const applyWorkspace = (workspace: UnityWorkspace<RunCheckpoint>) => {
        const p = workspace.saved.project;
        if (p?.images) p.images = p.images.map(normalizeUnityImageSelection);
        if (p && imageReset && workspace.task?.imageTask === imageReset && workspace.task.progress.state === "pending" &&
            (imageReset === "filter" || imageReset === "refine" || imageReset === "recognize")) {
          resetImageGroupHistory(p.folder);
          setImageResetRevision(value => value + 1);
        }
        latest.current = p; setProject(p);
        checkpointRef.current = workspace.task; setCheckpoint(workspace.task); resetQueuedSignature();
        setPatch(workspace.task?.patch || null); setInstalled(workspace.installed); setApplied(false); onInstallationChange?.(root, workspace.installed); setGeneration(null); setDirty(false); setPage(0); setRowIssue(null);
        setFontPlan(null);
        reportRestore(workspace.saved.notices);
      };
      try {
        const result = await unityRun<{ step: number; workspace: UnityWorkspace<RunCheckpoint> }>("reset-step", { root, step, imageOnly: !!imageReset, imageResetPhase: imageReset, path: project?.folder || "", task: task && { ...task, translationKind, llmModel, dialogueModel, nameModel, imageModel, imageReviewModel, engine, engines: engineChoices, source, target, joinLines, wrapMode, textScreenModel, includeContext, skipTargetLanguage, onlySourceLanguage, lineMode, lineModel, includeCode, fontPath, textMode, codeAssemblies, typeDirectory, extraCharacters } }, progress => { setMessage(progress.detail); showLocalActivity(progress.detail, "running", imagePart, progress.completed, progress.total); });
        applyWorkspace(result.workspace);
        if (imageReset) clearGamePerformance(promptState.scope + ":images", unityImagePhases.slice(unityImagePhases.indexOf(imageReset)));
        else if (step === 2) {
          clearGamePerformance(promptState.scope + ":text", ["translate"]);
          logAction(`清理完成：译文 ${cleanupCounts.text} 条，排版草稿 ${cleanupCounts.drafts} 条，错误记录 ${cleanupCounts.errors} 条；原文和图片结果保留`, "success");
        }
        setActiveStep(step === 2 ? 2 : result.step); followProgress.current = false;
        if (step === 2 && !imagePart) { const retainedScreen = textScreened || restart; if(retainedScreen && latest.current){const kept={...latest.current,entries:latest.current.entries.map(entry=>({...entry}))};preserveTargetGameText(kept.entries.filter(entry=>entry.selected),target,onlySourceLanguage?source:"auto",skipTargetLanguage);await saveTranslation(kept,"text");} setTextScreened(retainedScreen);  setTextScreenStarted(retainedScreen); setTextScreenPaused(false); }
        setMessage(step === 4 ? "游戏原件已恢复，应用记录已清理，可复用已生成的补丁重新应用。" : "本步及后续失效产物已清理，可调整参数后重新开始。");
      } catch (error) {
        // The native reset checkpoint finishes any interrupted cleanup before loading results.
        try { applyWorkspace(await unityRun<UnityWorkspace<RunCheckpoint>>("workspace", { root })); } catch { /* Keep the original cleanup failure visible. */ }
        throw error;
      }
    }, false);
  }
  async function clearResourceScan() {
    if (busy || mosaicBusy || restoring || saving || !project) return;
    if (!await confirmation.ask("清理扫描及后续结果", "将清除扫描工程、文本译文、图片处理结果、去码候选和未安装补丁。游戏原件、已安装补丁及其恢复备份保留。")) return;
    await operation("清理扫描及后续结果", async () => {
      await taskWrites.current; await projectWrites.current;
      const current = latest.current;
      if (!current) return;
      const { workspace } = await unityRun<{ workspace: UnityWorkspace<RunCheckpoint> }>("reset-step", {
        root, step: 1, path: current.folder, task: checkpointRef.current || projectCheckpoint(current),
      });
      clearImageGroupHistory(current.folder);
      try { clearMosaicRows(root); } catch { /* Storage can be unavailable. */ }
      clearGamePerformance(promptState.scope + ":text", ["screen", "translate"]);
      clearGamePerformance(promptState.scope + ":images", unityImagePhases);
      latest.current = null;
      setProject(null); setPreparingRescan(false); setPatch(null); setFontPlan(null); setApplied(false);
      setGeneration(null); setLocalActivity(null); setMosaicStatus(undefined);
      textDraftOriginals.current.clear(); imageDraftOriginals.current.clear();
      pendingImageMasks.current.clear(); pendingEdits.current.clear(); setDirty(false);
      if (workspace.task) remember(workspace.task);
      setActiveStep(1);
      setMessage("扫描及后续结果已清理，可以从头扫描");
    });
  }
  async function save(p = latest.current, area: "all" | "text" | "images" = "all", editsOnly = false) {
    if (!p) return;
    await queueProjectWrite(async () => {
      let current = latest.current?.folder === p.folder ? latest.current : p;
      for (const [id, completed] of area === "text" ? [] : pendingImageMasks.current) {
        const image = current.images?.find(item => item.id === id); if (!image?.renderedFile||!unityImageUsesRegionMask(image)) { pendingImageMasks.current.delete(id); continue; }
        if (closing.current) await showClosing(`正在保存图片修改：${image.name || image.id}`);
        const source = await readUnitySourceImage(current, image);
        const translated = new Blob([await readFileBytes(current.folder + "/" + image.renderedFile)], { type: "image/png" });
        const blob = await maskUnityImageRegions(source, translated, unityImageTranslationRegions(image.regions, imageConfidenceThreshold,image));
        const result = await writeImage(current, image, blob);
        current = { ...current, images: current.images!.map(item => item.id === id ? { ...image, completed, renderedFile: result.path, renderedHash: result.hash } : item) };
        publish(current); pendingImageMasks.current.delete(id);
      }
      if (closing.current) await showClosing("正在写入 Unity 工程文件…");
      if (!editsOnly) publish(current);
      if (editsOnly) {
        const { root, folder } = current;
        if (area !== "images" && textDraftOriginals.current.size) {
          const entries = current.entries.filter(entry => textDraftOriginals.current.has(entry.id));
          await unityRun("save-text-states", { project: { root, folder, entries } });
        }
        if (area !== "text" && imageDraftOriginals.current.size) {
          const images = current.images?.filter(image => imageDraftOriginals.current.has(image.id)) ?? [];
          for (let offset = 0; offset < images.length; offset += 128) {
            const batch = images.slice(offset, offset + 128);
            const obsoleteRenderedFiles = Object.fromEntries(batch.flatMap(image => {
              const previous = imageDraftOriginals.current.get(image.id)?.renderedFile;
              return previous && previous !== image.renderedFile ? [[image.id, previous]] : [];
            }));
            const { cacheErrors } = await unityRun<{ cacheErrors?: string[] }>("save-image-states", {
              project: { root, folder, images: batch }, obsoleteRenderedFiles, resumeImageWork: !current.imagesSkipped,
            });
            if (cacheErrors?.length) setActionError("工程已保存，部分译图缓存未能清理：" + cacheErrors.join("；"));
          }
        }
      } else {
        const saved = { ...current,
          entries: area === "images" ? current.entries.map(entry => textDraftOriginals.current.get(entry.id) || entry) : current.entries,
          images: area === "text" ? current.images?.map(image => imageDraftOriginals.current.get(image.id) || image) : current.images };
        const cache = await unityRun<{ cacheErrors?: string[] }>("save", { project: saved, cleanImageCache: area !== "text" && !deploymentController.current });
        if (cache.cacheErrors?.length) setActionError("工程已保存，部分译图缓存未能清理：" + cache.cacheErrors.join("；"));
      }
      for (const key of pendingEdits.current) {
        const image = key.startsWith("图片") || key.startsWith("译图");
        if (area === "all" || (area === "images") === image) pendingEdits.current.delete(key);
      }
      if (area !== "text") imageDraftOriginals.current.clear();
      if (area !== "images") textDraftOriginals.current.clear();
    });
    setDirty(pendingEdits.current.size > 0);
  }
  async function saveUserChanges(area: "all" | "text" | "images" = "all") {
    if (saving || importPreviewRef.current) return false;
    const changes = [...pendingEdits.current].filter(key => area === "all" || (area === "images") === (key.startsWith("图片") || key.startsWith("译图")));
    if (!changes.length) { logAction("当前没有需要保存的修改"); return true; }
    setSavedChanges(changes.map(change => {
      const id = change.match(/^文本与译文：第 (.+) 条$/)?.[1]; const entry = id && latest.current?.entries.find(row => row.id === id);
      return entry ? `${change} · ${entry.translation.slice(0, 80) || "空译文"}` : change;
    })); setSaving(true); setSaveNotice(""); setSaveComplete(false); logAction(`正在保存${area === "images" ? "图片" : area === "text" ? "文本" : "工程"}修改`);
    try { await save(undefined, area, true); setSaveNotice("已保存"); setSaveComplete(true); logAction("修改已保存", "success"); return true; }
    catch (error) { setDirty(true); setActionError(`保存失败：${String(error)}`); setSaveNotice("保存失败"); logAction(`保存失败：${String(error)}`, "error"); return false; }
    finally { setSaving(false); }
  }

  async function discardImageChanges(){
    const current=latest.current; if(!current)return false;
    if (!imageDraftOriginals.current.size) { logAction("当前没有未保存的图片修改"); return true; }
    const next={...current,images:current.images?.map(image=>imageDraftOriginals.current.get(image.id)||image)};
    const count = imageDraftOriginals.current.size;
    publish(next); imageDraftOriginals.current.clear(); pendingImageMasks.current.clear();
    for(const key of pendingEdits.current)if(key.startsWith("图片")||key.startsWith("译图"))pendingEdits.current.delete(key);
    setDirty(pendingEdits.current.size>0);setSaveNotice(""); logAction(`已取消 ${count} 张图片的未保存修改`, "success");
    const cleanupProject = { folder: next.folder, images: next.images?.map(({id, renderedFile}) => ({id, renderedFile})) };
    void queueProjectWrite(()=>unityRun<{errors:string[]}>("save-image",{project:cleanupProject,cleanImageCache:true})).then(cleanup=>{
      if(cleanup.errors.length)logAction("图片修改已取消，部分缓存清理失败："+cleanup.errors.join("；"),"warning");
    }).catch(error=>logAction(`图片修改已取消，缓存清理失败：${String(error)}`,"warning"));
    return true;
  }
  const discardTextChanges=async()=>{
    if(!project||busy||restoring||saving||importPreviewRef.current)return;
    if(!await confirm("取消当前未保存的文本勾选和译文修改？图片与处理参数保留。",{title:"取消修改",kind:"warning",okLabel:"取消修改",cancelLabel:"返回"}))return;
    const current = latest.current; if (!current) return;
    if (!textDraftOriginals.current.size) { logAction("当前没有未保存的文本修改"); return; }
    const count = textDraftOriginals.current.size;
    publish({ ...current, entries: current.entries.map(entry => textDraftOriginals.current.get(entry.id) || entry) });
    textDraftOriginals.current.clear();
    for (const key of pendingEdits.current) if (key.startsWith("文本与译文：") || key.startsWith("文本勾选：")) pendingEdits.current.delete(key);
    setDirty(pendingEdits.current.size > 0); setSaveNotice(""); setRowIssue(null);
    logAction(`已取消 ${count} 条文本的未保存修改`, "success");

  };
  function publishTranslation(p: UnityProject, part: UnityTranslationPart) {
    const merged = mergeUnityTranslationProject(latest.current || p, p, part); publish(merged); return merged;
  }
  async function saveTranslation(p: UnityProject, part: UnityTranslationPart) {
    publishTranslation(p, part);
    await measureGameAsync(promptState.scope + ":" + part, "saveMs", () => save(undefined, part));
  }

  async function translationOptions(run?: RunCheckpoint, forImages = false): Promise<UnityTranslationOptions> {
    const general = await api.getSettings();
    const languageOptions = forImages ? picture : { source: run?.source ?? source, target: run?.target ?? target,
      onlySourceLanguage: run?.onlySourceLanguage ?? onlySourceLanguage, skipTargetLanguage: run?.skipTargetLanguage ?? skipTargetLanguage,
      engines: run?.engines || engineChoices, kind: run?.translationKind || translationKind };
    const engineIds = languageOptions.engines.filter(row => row.enabled && engineReady(parseEngineKeys(general.translateEngineKeys), row.id)).map(row => row.id);
    const kind = languageOptions.kind;
    const provider = kind === "engine" ? engineIds[0] : "llm";
    if (!provider) throw new Error("请在并行翻译列表中至少启用一个免 Key 或已配置凭证的引擎");
    const language = forImages ? languageOptions.source : unityLanguageScope(latest.current?.entries || [], languageOptions.source, languageOptions.onlySourceLanguage).language;
    const locals = loadLocalModelProfiles();
    const buildOptions = (model: string, scene: "text"|"dialogue"|"names"|"image"|"review" = "text") => buildUnityTranslateOptions(general, provider, !(languageOptions.onlySourceLanguage) || language === "all" || language === "und" ? "auto" : language, languageOptions.target, model, forImages ? false : run?.joinLines ?? joinLines, !!locals[model || general.model] || kind === "local" && !model,provider==="llm"?gameTaskPrompt(scene,promptState.selection,{source:language,target:languageOptions.target}):undefined,forImages?"keep":run?.wrapMode||wrapMode,{selection:promptState.selection,role:scene});
    const main = run ? run.llmModel || "" : llmModel;
    const dialogue = run ? run.dialogueModel : dialogueModel;
    const name = run ? run.nameModel : nameModel;
    const image = run ? run.imageModel : imageModel;
    const reviewer = run ? run.imageReviewModel : imageReviewModel;
    if (provider === "llm" && !(forImages ? image : main)) throw new Error(forImages ? "请选择图片文字翻译模型" : "请选择常规文本模型");
    return {
      ...buildOptions(forImages ? image! : main,forImages?"image":"text"),
      wrapMode:run?.wrapMode||wrapMode,
      imageReviewOptions: forImages && provider === "llm" && reviewer ? buildOptions(reviewer,"review") : undefined,
      dialogueOptions: !forImages && provider === "llm" ? buildOptions(dialogue||main,"dialogue") : undefined,
      nameOptions: !forImages && provider === "llm" ? buildOptions(name||main,"names") : undefined,
      skipTargetLanguage: languageOptions.skipTargetLanguage, onlySourceLanguage: languageOptions.onlySourceLanguage, includeContext: !forImages && (run?.includeContext ?? includeContext), engineIds: provider === "llm" ? undefined : engineIds
    };
  }
  async function scan(onProgress?: (value: UnityProgress) => void, signal?: AbortSignal, run?: RunCheckpoint, deploymentBatch?: string) {
    const p = await measureDeploymentStage(root, "scan",
      () => unityRun<UnityProject>("scan", { root, outputRoot: output, includeCode: run?.includeCode ?? includeCode, textMode: run?.textMode || textMode, codeAssemblies: run?.codeAssemblies ?? codeAssemblies, typeDirectory: run?.typeDirectory ?? typeDirectory, path: run?.scanFolder || "", reusePath: run?.previousProjectFolder || "", deploymentBatch }, onProgress, signal),
      scanned => scanned.scanMetrics ? scanned.scanMetrics.parsed + scanned.scanMetrics.reused : undefined);
    if (!run?.previousProjectFolder) publish(p);
    setPage(0); setDirty(false); setPatch(null);
    setFontPlan(null);
    setMessage(p.entries.length ? `扫描完成：${p.entries.length} 条文本，${p.fonts.length} 个字体` : "未找到可处理的文本，请查看扫描提示中的跳过原因。");
    return p;
  }
  function translateProject(p: UnityProject, controller: AbortController, options: UnityTranslationOptions, onProgress?: (value: UnityProgress) => void,
    languageSource = source, mergeLines = joinLines, breakMode: UnityLineMode = "local", helperModel = "", layoutOnly = false, onlyIds?: Set<string>) {
    return runTextTranslation(p, controller, options, onProgress, languageSource, mergeLines, breakMode, helperModel, layoutOnly, onlyIds, {
      settings, promptState, textLog, getSettings: () => api.getSettings(), loadLocalModelProfiles, measureGameWork,
      translateGameWithOllama, prepareGameOllamaModels, canDisableOllamaNameThinking, gameModelExecution,
      readEngineStats: () => checkpointRef.current?.translationRuns?.text.engineStats || (!checkpointRef.current?.imageOnly && checkpointRef.current?.progress.step === 2 ? checkpointRef.current.progress.engineStats : undefined),
      saveTranslation: project => saveTranslation(project, "text"),
      persist: async (next, entries) => {
        publishTranslation({ ...next, entries: [...next.entries] }, "text");
        const rows = entries.map(entry => ({ ...entry }));
        await queueProjectWrite(() => measureGameAsync(promptState.scope + ":text", "saveMs", () =>
          unityRun("save-text-states", { project: { root: next.root, folder: next.folder, entries: rows } })));
      },
      setQueue: queue => { translationQueue.current = queue; }, setDirty, setMessage,
    });
  }
  const imageBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("图片读取失败")); reader.readAsDataURL(blob);
  });
  const imageRequest = (p: UnityProject, image: UnityImage) => ({ root: p.root, folder: p.folder, images: [image] });
  async function writeImage(p: UnityProject, image: UnityImage, blob: Blob) {
    const result=await unityRun<{ path: string; hash: string;cacheErrors?:string[] }>("save-image", { project: imageRequest(p, image), imageId: image.id, imageData: await imageBase64(blob),savedRenderedFile:deploymentController.current?undefined:imageDraftOriginals.current.get(image.id)?.renderedFile??image.renderedFile });if(result.cacheErrors?.length)setActionError("译图已写入，部分旧缓存未能清理："+result.cacheErrors.join("；"));return result;
  }
  function requestImageTranslation(options: UnityTranslationOptions, provider: string, text: string, parentSignal: AbortSignal, phase?: "translate" | "review") {
    return runImageRegionTranslation(options, provider, text, parentSignal, phase, { translateGameWithOllama, imageLog });
  }
  function translateImages(p: UnityProject, controller: AbortController, run: RunCheckpoint, onProgress: (value: UnityProgress) => void) {
    return runImageTranslation(p, controller, run, onProgress, {
      root, settings, picture, promptState, imageTask: () => imageTask.current, imageConcurrency, imageConfidenceThreshold, gameModels,
      translationOptions, setRedrawingId, setMessage, imageLog, measureGameAsync, modelConcurrency, loadLocalModelProfiles,
      resolveFeatureLlm, prepareGameOllamaModels, translateGameWithOllama, readUnitySourceImage, collectGameImageNames, recognizeGameImage,
      renderGameImage, recognizeUnityReviewCrops, screenUnityImages, refineUnityImages, refineUnityImagesLocally, redrawGameImages, processUnityImages,
      publishTranslation: project => publishTranslation(project, "images"), saveTranslation: project => saveTranslation(project, "images"),
      invalidatePatch, writeImage,
      persistImageStates: (p, images, scope) => queueProjectWrite(() => measureGameAsync(scope, "saveMs", () =>
        unityRun("save-image-states", { project: { root: p.root, folder: p.folder, images } }))),
      persistRenderedState: (next, snapshot) => queueProjectWrite(() => measureGameAsync(promptState.scope + ":images", "saveMs", () =>
        unityRun("save-image", { project: imageRequest(next, snapshot), imageId: snapshot.id }))),
    });
  }
  const editImages = (values: UnityImage[], fromEditor = true) => {
    const project = latest.current;
    if (!project?.images || !values.length) return;
    const proposed = new Map(values.map(image => [image.id, normalizeUnityImageSelection(image)]));
    const draftKey = (image: UnityImage) => `图片与译文：${image.name || image.id}`;
    const touched = new Set<string>();
    const images = project.images.map(previous => {
      const value = proposed.get(previous.id);
      if (!value) return previous;
      const saved = imageDraftOriginals.current.get(previous.id) ?? previous;
      tagEditedImageTranslations(value, previous, picture.target);
      const image = reconcileImageEdit(value, previous, saved, imageConfidenceThreshold, fromEditor);
      if (image === previous) return previous;
      touched.add(draftKey(saved));
      if (image === saved) imageDraftOriginals.current.delete(image.id);
      else imageDraftOriginals.current.set(image.id, saved);

      const maskBase = saved.renderedFile === image.renderedFile && saved.renderedHash === image.renderedHash ? saved : previous;
      if (image !== saved && maskBase.renderedFile && image.renderedFile && unityImageUsesRegionMask(image)) {
        const before = unityImageTranslationRegions(maskBase.regions, imageConfidenceThreshold, maskBase);
        const after = unityImageTranslationRegions(image.regions, imageConfidenceThreshold, image);
        if (before.some((region, index) => region.selected && !after[index]?.selected)) {
          const payload = (regions: UnityImage["regions"]) => regions.map(({ selected: _selected, manualSelected: _manual, error: _error, ...region }) => region);
          const selectionOnly = JSON.stringify(payload(maskBase.regions)) === JSON.stringify(payload(image.regions)) &&
            !after.some((region, index) => region.selected && !before[index]?.selected);
          pendingImageMasks.current.set(image.id, selectionOnly && maskBase.completed);
        } else if (maskBase === saved) pendingImageMasks.current.delete(image.id);
      } else pendingImageMasks.current.delete(image.id);
      return image;
    });
    if (!touched.size) return;
    const drafted = new Set([...imageDraftOriginals.current.values()].map(draftKey));
    for (const key of touched) {
      if (drafted.has(key)) pendingEdits.current.add(key);
      else pendingEdits.current.delete(key);
    }
    publish({ ...project, images, ...(drafted.size ? { imagesSkipped: false } : {}) });
    setDirty(pendingEdits.current.size > 0);
    setSaveNotice("");
    if (drafted.size) invalidatePatch();
  };
  const editImage = (value: UnityImage, fromEditor = true) => editImages([value], fromEditor);
  async function imageOperation(label:string,task:()=>Promise<void>){
    if(isBenchmarkRunning()||mosaicBusy||imageEditorWork.current||restoring||saving||importPreviewRef.current)return false;
    if(running.current&&(!translationJobs.current||translationJobs.current.state("images")==="running"))return false;
    setImageEditorBusy(label);setActionError("");logAction(`开始${label}`);showLocalActivity(`${label}：正在准备…`,"running",true);
    const work=Promise.resolve().then(task);imageEditorWork.current=work;
    try{await work;logAction(`${label}完成`,"success");showLocalActivity(`${label}完成`,"done",true,1,1);return true;}catch(error){const text=error instanceof Error?error.message:String(error);const stopped=imageEditorAbort.current?.signal.aborted;setActionError(stopped?"":text);logAction(`${label}${stopped?"已中止":"失败"}：${text}`,stopped?"warning":"error");showLocalActivity(stopped?`${label}已中止`:text,stopped?"stopped":"error",true);return false;}
    finally{imageEditorWork.current=null;setImageEditorBusy("");}
  }
  const importImageArchive=(items:ImageArchiveReplacement[])=>imageOperation("导入图片压缩包",async()=>{
    const failures:string[]=[],changed:UnityImage[]=[];
    for(const item of items){const p=latest.current;if(!p)throw new Error("图片工程已关闭");const image=p.images?.find(row=>row.id===item.image.id);
      if(!image||image.sourceHash!==item.image.sourceHash){failures.push(`${item.image.name}：导入期间原资源已改变`);continue;}
      try{const result=await writeImage(p,image,item.blob);changed.push({...image,renderedFile:result.path,renderedHash:result.hash,renderedKind:"imported",completed:true,error:""});}
      catch(error){failures.push(`${image.name}（${image.file} / ${image.container} / ${image.objectId}）：${error instanceof Error?error.message:String(error)}`);}
    }
    editImages(changed,false);await save();if(failures.length)throw new Error(`已导入 ${changed.length} 张，失败 ${failures.length} 张：${failures.join("；")}`);
  });
  const translateCurrentImage=(image:UnityImage)=>imageOperation("翻译当前图片",async()=>{
    const controller=new AbortController();imageEditorAbort.current=controller;
    const options=await translationOptions(undefined,true);const provider=options.provider;if(!provider)throw new Error("未选择图片翻译引擎");
    const imageNames = collectGameImageNames(latest.current?.entries || [], root, options.target || target, settings.textGlossary);
    const request = (engine: string, text: string) => translateNamedImageText(text,
      input => requestImageTranslation(options, engine, input, controller.signal), options.target || "", imageNames);
    const pool=provider!=="llm"&&options.engineIds?.length?createUnityEnginePool(options.engineIds.map(id=>({id,enabled:true})),controller.signal,request):null;
    try{const next=await translateCurrentUnityImage(image,controller.signal,text=>pool?pool.translate(text):request(provider,text),unityTranslationError,imageConfidenceThreshold,!options.localModel&&!options.imageReviewOptions?.localModel&&provider==="llm"?16:1,
      gameImageRegionLanguageFilter(options.source || "auto", options.target || "zh-CN", !!options.onlySourceLanguage, !!options.skipTargetLanguage), options.target);editImage(next,false);await save();if(next.error)throw new Error(next.error);setMessage("当前图片译文已更新");}
    finally{pool?.dispose();imageEditorAbort.current=null;}
  });
  const recognizeImage = (image: UnityImage, mode: OcrMode) => imageOperation("重新识别图片", async () => {
    if (image.regions.some(region => region.translation) && !await confirm("重新识别会替换这张图片的识别区域和译文，是否继续？", { title: "重新识别", okLabel: "重新识别", cancelLabel: "取消" })) return;
    const controller = new AbortController(); imageEditorAbort.current = controller;
    const ocr = createUnityImageOcr(mode);
    const cancel = () => { void ocr.dispose(); }; controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      showLocalActivity(`${image.name || image.id} · 正在读取原图`, "running", true, 0, 1);
      const current = latest.current || project!;
      const blob = await readUnitySourceImage(current, image, controller.signal);
      const stage = (detail: string) => { setMessage(detail); showLocalActivity(`${image.name || image.id} · ${detail}`, "running", true, 0, 1); };
      const names = collectGameImageNames(current.entries, root, picture.target, settings.textGlossary);
      const cleanBase = gameImageCleanBase(image, current.images || [], candidate => readUnitySourceImage(current, candidate, controller.signal));
      const lines = imageVisionModel !== undefined ? await ocr.recognizeVision(blob, stage, controller.signal,
        fallback => recognizeGameImage(settings, gameImageVisionForAsset(imageVisionModel, image.name, gameModels), blob, controller.signal,
          "recognize", promptState.selection, { source:picture.source, target:picture.target, assetName: image.name, cleanBase, names }, logAction, fallback),
        message => logAction(message, "warning")) : await ocr.recognize(blob, stage);
      controller.signal.throwIfAborted();
      editImage({ ...image, completed: false, ocrCompleted: true, renderedFile: "", renderedHash: "", error: "", regions: lines.filter(line => line.text.trim()).map(line => ({ ...line, translation: "", error: "", selected: line.confidence >= imageConfidenceThreshold })) });
      setMessage("图片识别完成");
    } finally { controller.signal.removeEventListener("abort", cancel); await ocr.dispose(); imageEditorAbort.current = null; }
  });
  const updateImagePreview = (image: UnityImage, imported = false,importSource?:GameImportSource, modelCandidate = false) => imageOperation(imported ? "替换译图" : "生成译图", async () => {
    const base=latest.current;if(!base)return;
    let blob: Blob;
    if (imported) { const selected = importSource||await open({ filters: [{ name: "静态图片", extensions: ["png","jpg","jpeg","webp","bmp"] }] }); if (!selected) return; blob = await imageImportPng(selected,image); }
    else {const controller=new AbortController();imageEditorAbort.current=controller;try{if(imageLayoutModel!==undefined&&!imageLayoutModel)throw new Error("请选择断行排版模型");const include=gameImageRegionLanguageFilter(picture.source,picture.target,picture.onlySourceLanguage !== false,picture.skipTargetLanguage !== false);const regions=unityImageTranslationRegions(image.regions,imageConfidenceThreshold,image).map(region=>include(region.text)?region:{...region,selected:false});if(regions.some(region=>region.selected&&region.translationTarget&&region.translationTarget!==picture.target))throw new Error("请先翻译成当前目标语言");const issue=regions.filter(region=>region.selected).map(region=>gameImageJapaneseTextIssue(region.text,region.translation,target)).find(Boolean);if(issue)throw new Error(issue);blob=await renderGameImage(settings,imageLayoutModel||"",await readUnitySourceImage(base,image,controller.signal),regions,controller.signal,promptState.selection,{source:picture.source,target:picture.target},logAction,{assetName:image.name,cleanBase:gameImageCleanBase(image,base.images||[],candidate=>readUnitySourceImage(base,candidate,controller.signal))});}finally{imageEditorAbort.current=null;}}
    const result = await writeImage(base, image, blob);
    pendingImageMasks.current.delete(image.id);
    const current=latest.current||base;if(!imageDraftOriginals.current.has(image.id))imageDraftOriginals.current.set(image.id,image);const next = { ...current, imagesSkipped: false, images: (current.images || []).map(item => item.id === image.id ? { ...image, completed: true, error: "", renderedFile: result.path, renderedHash: result.hash,...(modelCandidate ? { screening: savedGameImageRedraw(image,result.hash) } : {}),renderedKind:imported?"imported" as const:"generated" as const,renderedTarget:imported?undefined:target,noTranslationNeeded:false } : item) };
    pendingEdits.current.add(`译图${imported ? "替换" : "生成"}：${image.name || image.id}`);
    publish(next); setDirty(true); setSaveNotice(""); invalidatePatch(); setMessage(imported ? "译图已替换" : "译图已生成");
  });
  async function skipTranslationPart(images = imagePart) {
    if (!project || restoring || busy && !translationJobs.current) return;
    if (!await confirm(images ? "跳过尚未完成的图片？已完成的译图保留，其余图片保持原样。" : "跳过尚未完成的文本？已有有效译文保留，其余文本保持原文。", { title: images ? "跳过 2.2" : "跳过 2.1", okLabel: "跳过剩余", cancelLabel: "取消" })) return;
    const jobs = translationJobs.current;
    if (jobs) {
      const p = latest.current!; publish({ ...p, ...(images ? { imagesSkipped: true } : { textSkipped: true }) });
      const saved = save(); await Promise.all([saved, jobs.skip(images ? "images" : "text")]); return;
    }
    await operation("保存跳过选择", async () => {
      const next = { ...project, ...(images ? { imagesSkipped: true } : { textSkipped: true }) }; publish(next); await save(next);
      const task = checkpointRef.current || projectCheckpoint(next);
      remember({ ...task, step: 2, endStep: 2, imageOnly: images, automatic: false, finished: true, partial: !!next.textSkipped, progress: { step: 2, state: "done", completed: 0, total: 0, detail: images ? "已跳过剩余图片，未完成图片保持原样" : "已跳过剩余文本，未完成文本保持原文" } });
      await taskWrites.current; setActiveStep(images ? 3 : 2); setImagePart(!images);
    });
  }
  async function exportPatch(p: UnityProject, onProgress?: (value: UnityProgress) => void, signal?: AbortSignal, run?: RunCheckpoint, excluded: DeploymentPhase[] = loadDeploymentPlan(root).disabled.filter((id): id is DeploymentPhase => id !== "scan" && id !== "apply"), deploymentBatch?: string) {
    setBusy("生成补丁");
    const generated = await generateOfflinePatch(root, p, { source, target, onlySourceLanguage, imageTarget: picture.target, fontPath, extraCharacters },
      run, excluded, deploymentBatch, onProgress, signal, {
        run: unityRun, measure: measureDeploymentStage, readFile: readFileBytes, reportFontPlan: setFontPlan,
      });
    setPatch(generated); setApplied(false); setDirty(false);
    setMessage(offlineExportMessage(generated));
    return generated;
  }
  const progressPercent = generation?.total ? Math.floor(generation.completed / generation.total * 100) : generation?.state === "done" && generation.total === 0 ? 100 : null;
  const progressIsImage = generation?.step === 2 && (localActivity && generation === localActivity.value ? localActivity.images : activeStep === 2 && checkpoint?.translationRuns ? imagePart : !!checkpoint?.imageOnly);
  const resumable = !preparingRescan && !!checkpoint && !checkpoint.finished;
  const { pausedScan, scanOptionsChanged } = getPausedScanState(checkpoint, { includeCode, textMode, typeDirectory, codeAssemblies });
  const locked = !!busy || restoring || resumable || saving || applyingTestConfiguration || !!importPreview;
  const entriesLocked = !!busy || restoring || saving || resumable && (checkpoint.step !== 2 || !!checkpoint.imageOnly);
  async function skipRemaining() { await skipTranslationPart(!!checkpoint?.imageOnly); }

  const currentPart: UnityTranslationPart = imagePart ? "images" : "text";
  const selectedJob = currentParts?.[currentPart];
  const taskAction = translationJobs.current ? <>
    {selectedJob?.state === "running" && <button className="unity-btn" disabled={translationJobs.current.isStopping(currentPart)} onClick={() => stopPart(currentPart)}>中止 {imagePart ? "2.2" : "2.1"}</button>}
    {Object.values(checkpoint?.translationRuns || {}).filter(part => part.state === "running").length > 1 && <button className="unity-btn" onClick={stop}>中止全部</button>}
  </> : <>{busy && abort.current ? <button className="unity-btn" onClick={stop} disabled={abort.current.signal.aborted}>中止</button> : !busy && resumable && <button className="unity-btn" onClick={resumeTask} disabled={testing || restoring} title={testTitle}>{needsScan || scanOptionsChanged ? "重新扫描并继续" : checkpoint.layoutOnly ? "恢复断行" : `${generation?.state === "error" && progressPercent === null ? "重试" : "恢复"}${checkpoint.automatic ? "一键流程" : checkpoint.imageOnly ? "图片翻译" : GENERATION_STEPS[checkpoint.step - 1]}`}</button>}{!busy && resumable && checkpoint.step === 2 && <button className="unity-btn unity-btn-warning unity-important-action" disabled={restoring || needsScan} data-tooltip={needsScan ? "需要先重新扫描" : "保留已完成结果，未处理内容保持原样"} aria-label={needsScan ? "需要先重新扫描" : "保留已完成结果，未处理内容保持原样"} onClick={() => void skipRemaining()}>{checkpoint?.imageOnly ? "跳过剩余图片" : "跳过剩余文本"}</button>}</>;
  const failureMessage = generation?.state === "error" ? generation.failure || error : error;
  const failure = failureMessage ? explainUnityFailure(failureMessage) : null;
  const currentRowIssue = rowIssue && tableEntries.find(entry => entry.id === rowIssue.id);
  const rowFailure = rowIssue ? explainUnityFailure(currentRowIssue && entryProblem(currentRowIssue) || rowIssue.error) : null;
  const rowQueueStatus = rowIssue ? translationQueue.current?.status(rowIssue.id) : undefined;
  const rowRetryQueued = rowQueueStatus === "pending" || rowQueueStatus === "active" || !!rowIssue && busy === `重试条目 #${rowIssue.id}`;
  useEffect(() => {
    if (currentRowIssue && currentRowIssue.translation && !entryProblem(currentRowIssue)) setRowIssue(null);
  }, [tableEntries, rowIssue?.id]);
  const errorPanel = failure && <details className="unity-current-failure" open role="alert" aria-label="当前任务失败">
    <summary>{generation?.state === "error" ? `${generation.step === 2 && progressIsImage ? "图片翻译" : GENERATION_STEPS[generation.step - 1]} · 失败` : "当前操作 · 失败"}</summary><p>{failure.reason}</p><p>处理方法：{failure.action}</p>
    {/所选字体缺少/.test(failureMessage || "") && <div className="unity-row-error-actions"><button className="unity-btn" disabled={!!busy || restoring} onClick={() => { setActiveStep(3); followProgress.current = false; if (!fontPlan) void checkFontPlan(); else requestAnimationFrame(() => workflowRef.current?.querySelector(".unity-font-plan")?.scrollIntoView({ block: "center", behavior: "smooth" })); }}>查看缺字清单</button>{fontPlan && <button className="unity-btn" onClick={() => void openTranslationFile(fontPlan.folder + "/字库检查.txt")}>打开检查报告</button>}</div>}
    {failure.technical && <details><summary>技术详情</summary><pre>{failure.technical}</pre></details>}
  </details>;
  const progressRunning = !!busy && generation?.state === "running";
  useEffect(() => {
    if (progressRunning && followProgress.current)
      workflowRef.current?.querySelector<HTMLElement>('[aria-label="任务状态"]')?.scrollIntoView({ block: "nearest" });
  }, [progressRunning, generation?.step, activeStep]);
  const scanWarnings = (project?.warnings || []).filter(warning => warning !== "加密资源、未识别的自定义文本格式不在本次自动回写范围内。");
  const warningDetails = scanWarnings.map(explainUnityWarning);
  const streamWarnings = warningDetails.filter(w => w.category === "stream");
  const scanReady = !preparingRescan && !!project && !needsScan && (checkpoint?.step !== 1 || checkpoint.progress.state === "done");
  useEffect(() => { setTextScreened(false); setTextScreenStarted(false); setTextScreenPaused(false);  }, [project?.folder, source, target, skipTargetLanguage, onlySourceLanguage]);
  const screenCurrentText = () => operation("筛选文本", () => runTextScreening({
    latestProject: () => latest.current,
    startScreening: controller => { abort.current = controller; setTextScreening(true); setTextScreenStarted(true); setTextScreenPaused(false); },
    endScreening: () => { abort.current = null; setTextScreening(false); },
    settings, textScreenModel, promptState, source, onlySourceLanguage, target, skipTargetLanguage, logAction,
    reportScreening: (completed, total) => {
      reportGameStepItems(promptState.scope + ":text", "screen", completed);
      showLocalActivity("正在用大模型筛选文本", "running", false, completed, total);
    },
    saveTranslation: project => saveTranslation(project, "text"),
    setTextScreened, setTextScreenPaused, setMessage, beginGameStep, finishGameStep, screenGameText,
  }));
  const clearTextScreening = async () => {
    if(!project || !await confirmation.ask("清理筛选及后续结果","清除筛选状态、文本译文和后续补丁，原文与图片结果保留。"))return;
    await operation("清理文本筛选及后续结果",async()=>{
      if(dirty)await save();await taskWrites.current;
      const result=await unityRun<{workspace:UnityWorkspace<RunCheckpoint>}>("reset-step",{root,step:2,imageOnly:false,path:project.folder,task:checkpointRef.current||projectCheckpoint(project)});
      if(result.workspace.saved.project)publish(result.workspace.saved.project);
      if(result.workspace.task)remember(result.workspace.task);
      setTextScreened(false);setTextScreenStarted(false);setTextScreenPaused(false);setPatch(null);setFontPlan(null);setGeneration(null);setDirty(false);
      clearGamePerformance(promptState.scope + ":text", ["screen", "translate"]);
      logAction("文本筛选及后续译文、补丁已清理","success");
    });
  };
  const retryTranslationEntry = async (id: string) => {
    const queue = translationQueue.current;
    if (queue) {
      if (queue.retry(id)) { setMessage(`条目 #${id} 已重新加入翻译队列`); setRowIssue(previous => previous ? { ...previous } : null); }
      return;
    }
    if (busy || restoring || !scanReady || applied || patch || !connectionReady) return;
    const p = latest.current, item = p?.entries.find(entry => entry.id === id);
    if (!p || !item || !item.error && item.translation && !unityTranslationError(item.source, item.translation)) return;
    await operation(`重试条目 #${id}`, async () => {
      await runTextRetry(p, id, {
        setController: controller => { abort.current = controller; },
        getCheckpoint: () => checkpointRef.current, projectCheckpoint, remember, getCurrent: () => latest.current,
        selectedIds: scope.ids, translateProject, translationOptions: () => translationOptions(),
        source, joinLines, lineMode, lineModel, setError, clearRowIssue: () => setRowIssue(null), setMessage,
      });
    }, true, setActionError);
  };
  const scanStarted = !!project || !!(checkpoint?.projectFolder || checkpoint?.scanFolder) || checkpoint?.step === 1 && !checkpoint.finished;
  useEffect(() => {
    if (!scanReady) { setSearch(""); setReviewFilter("all"); setQualityIssueId(null); setPage(0); setRowIssue(null); setRowJump(null); }
  }, [scanReady]);
  const textReady = scanReady && readiness.textReady;
  const imageRedrawCount = (project?.images || []).filter(gameImageRedrawSelected).length;
  const imageRenderReady = scanReady && readiness.imagesReady && (project?.imagesSkipped || !(project?.images || []).some(image =>
    needsUnityImageScreening(image, picture.source, picture.target, imageScreeningOptions) || unityImageRefinementPending(image, imageScreeningOptions.refine)));
  const imagesReady = imageRenderReady && (!!project?.imagesSkipped || imageRedrawCount === 0);
  const translationReady = textReady && imagesReady;
  const mosaicIndex = mosaicStatus?.root === root && !mosaicStatus.error ? mosaicStatus.candidates : undefined;
  const hasMosaic = scanReady && (project?.images || []).some(image => {
    const candidate = mosaicIndex?.[image.id];
    return image.sourceFile && candidate?.included && candidate.source === image.sourceHash;
  });
  const patchReady = hasMosaic || translationReady && readiness.hasPatchContent;
  const completedThrough = preparingRescan ? 0 : patch ? applied ? 4 : 3 : translationReady ? 2 : scanReady ? 1 : 0;
  const displayedCompletedThrough = preparingRescan ? 0 : Math.max(completedThrough, checkpoint?.step === 2 && !translationReady ? 1 : project && checkpoint && !checkpoint.layoutOnly ? checkpoint.finished && checkpoint.progress.state === "done" ? checkpoint.endStep : checkpoint.step - 1 : 0);
  const executingStep = generation && generation.state !== "done" ? generation.step : completedThrough < 4 ? completedThrough + 1 : undefined;
  const scanParametersLocked = !!busy || restoring || scanStarted && !preparingRescan && !pausedScan;
  const parametersLocked = activeStep === 1 ? scanParametersLocked : locked || activeStep <= completedThrough || activeStep === 2 && (imagePart ? imagesReady : textReady);
  const testConfigurationDisabled = !scanReady || !project || !!busy || restoring || saving || applyingTestConfiguration || !!importPreview || !!imageEditorBusy;
  const testConfigurations: GameTestConfigurationAccess = {
    scope: "unity:" + root, models: gameModels,
    capture: () => ({
      detectedSource: scope.language,
      text: { options: { kind: translationKind, source, target, onlySourceLanguage, skipTargetLanguage, includeContext, joinLines, wrapMode, lineMode, engines: engineChoices },
        roles: captureGameTestRoles({ textScreen: textScreenModel, text: llmModel, dialogue: dialogueModel, names: nameModel, line: lineModel }, promptState,
          { textScreen: textScreenModel, text: llmModel || settings.model, dialogue: dialogueModel || llmModel || settings.model,
            names: nameModel || llmModel || settings.model, line: lineModel || settings.model }) },
      images: { options: { translation: picture, mosaic: readMosaicSettings(root), redrawProfile: imageRedrawProfile, mode: imageOcrMode, concurrency: imageConcurrency, confidence: imageConfidenceThreshold,
        strategy: imageScreeningOptions.strategy, refine: imageScreeningOptions.refine },
        roles: captureGameTestRoles({ screen: imageScreeningOptions.filterModel, refine: imageRefineModel, recognize: imageVisionModel, image: imageModel, review: imageReviewModel, layout: imageLayoutModel }, promptState,
          { screen: imageScreeningOptions.filterModel, refine: imageRefineModel, recognize: imageVisionModel, image: imageModel || settings.model, review: imageReviewModel, layout: imageLayoutModel }) },
    }),
    apply: async preset => {
      const current = latest.current;
      if (testConfigurationDisabled || !current || running.current || imageEditorWork.current) throw new Error("请先完成工程读取或等待当前任务结束");
      setApplyingTestConfiguration(true);
      try {
        const { options, roles } = preset.text;
        const images = preset.images;
        const next = {
          translationKind: options.kind, source: options.source, target: options.target, joinLines: options.joinLines,
          wrapMode: options.wrapMode || (options.joinLines ? "join" as const : "keep" as const), lineMode: options.lineMode || "local" as const,
          onlySourceLanguage: options.onlySourceLanguage !== false, skipTargetLanguage: options.skipTargetLanguage !== false,
          includeContext: !!options.includeContext, engines: normalizeUnityEngines(options.engines),
          llmModel: roles.text?.model || "", dialogueModel: roles.dialogue?.model || "", nameModel: roles.names?.model || "",
          textScreenModel: roles.textScreen?.model, lineModel: roles.line?.model || "",
          imageModel: images ? images.roles.image?.model || "" : imageModel, imageReviewModel: images ? images.roles.review?.model || "" : imageReviewModel,
          imageVisionModel: images ? images.roles.recognize?.model : imageVisionModel, imageLayoutModel: images ? images.roles.layout?.model : imageLayoutModel,
          imageScreeningOptions: images?.options.strategy || images?.options.refine ? {
            strategy: images.options.strategy ?? imageScreeningOptions.strategy,
            filterModel: images.roles.screen?.model,
            refine: { ...(images.options.refine ?? imageScreeningOptions.refine), model: images.roles.refine?.model },
          } : imageScreeningOptions,
          imageRedrawProfile: images?.options.redrawProfile ?? imageRedrawProfile,
          imageOcrMode: images?.options.mode ?? imageOcrMode, imageConcurrency: images?.options.concurrency ?? imageConcurrency,
          imageConfidenceThreshold: images?.options.confidence ?? imageConfidenceThreshold,
        };
        parameterWrite.current?.();
        const previous = checkpointRef.current;
        remember({ ...(previous || projectCheckpoint(current)), ...execution.current.parameters, ...next });
        try { await taskWrites.current; }
        catch (error) {
          checkpointRef.current = previous; setCheckpoint(previous); setGeneration(previous?.progress ?? null);
          throw error;
        }
        setTranslationKind(next.translationKind); setLlmModel(next.llmModel); setDialogueModel(next.dialogueModel); setNameModel(next.nameModel);
        setSource(next.source); setTarget(next.target); setOnlySourceLanguage(next.onlySourceLanguage); setSkipTargetLanguage(next.skipTargetLanguage);
        setTextScreenModel(next.textScreenModel); setIncludeContext(next.includeContext); setEngineChoices(next.engines);
        setWrapMode(next.wrapMode); setJoinLines(next.joinLines); setLineMode(next.lineMode); setLineModel(next.lineModel);
        setImageModel(next.imageModel); setImageReviewModel(next.imageReviewModel); setImageVisionModel(next.imageVisionModel); setImageLayoutModel(next.imageLayoutModel);
        setImageOcrMode(next.imageOcrMode); setImageConcurrency(next.imageConcurrency); setImageConfidenceThreshold(next.imageConfidenceThreshold);
        setImageScreeningOptions(next.imageScreeningOptions);
        setImageRedrawProfile(next.imageRedrawProfile);
        if (images?.options.translation) changePicture(images.options.translation);
        if (images?.options.mosaic) saveMosaicSettings(root, images.options.mosaic);
        const main = next.llmModel || settings.model;
        applyGameTestRoles(roles, promptState, { text: main, dialogue: next.dialogueModel || main, names: next.nameModel || main, line: next.lineModel || settings.model });
        if (images) applyGameTestRoles(images.roles, promptState, { image: next.imageModel || settings.model });
        setConfigurationRevision(value => value + 1);
        logAction("已应用文本和图片测试配置", "success");
      } finally { setApplyingTestConfiguration(false); }
    },
  };
  useGameTestConfigurationSource(testConfigurations);
  const viewingProgress = !!generation && activeStep === Math.min(generation.step, 3) && (activeStep !== 2 || (!!checkpoint?.translationRuns || imagePart === !!checkpoint?.imageOnly));
  const currentExecution = {
    parameters: { translationKind, llmModel, dialogueModel, nameModel, imageModel, imageReviewModel, engine, engines: engineChoices,
      source, target, joinLines, wrapMode, textScreenModel, includeContext, skipTargetLanguage, onlySourceLanguage,
      lineMode, lineModel, imageOcrMode, imageVisionModel, imageLayoutModel, imageRedrawProfile, imageConcurrency, imageConfidenceThreshold, imageScreeningOptions },
    prompts: promptState.selection, translationOptions, translateImages, translateProject,
  };
  const execution = useRef(currentExecution);
  execution.current = currentExecution;
  const updateEngineChoices = (value: UnityEngineChoice[]) => {
    const engines = normalizeUnityEngines(value);
    setEngineChoices(engines);
    const saved = checkpointRef.current;
    if (saved && !saved.finished && saved.step === 2) remember({ ...saved, engines });
  };
  const updateLineOptions = (mode: UnityLineMode, model: string) => {
    setLineMode(mode); setLineModel(model);
    const saved = checkpointRef.current;
    if (saved && !saved.finished && saved.step === 2) remember({ ...saved, lineMode: mode, lineModel: model });
  };
  const invalidatePatch = () => {
    setPatch(null); if (!translationJobs.current) setGeneration(null);
    const saved = checkpointRef.current;
    if (!translationJobs.current && saved?.finished && saved.translationRuns) {
      remember({ ...saved, patch: null, patchFolder: "" }); setGeneration(null); return;
    }
    if (saved?.finished && saved.patch) {
      const value = { ...saved, patch: null, patchFolder: "" };
      remember(value); setGeneration(null);
    }
  };
  const readMosaicSource = useCallback((image: UnityImage, signal: AbortSignal) => {
    const current = latest.current;
    if (!current) throw new Error("请先扫描图片资源");
    return readUnitySourceImage(current, image, signal);
  }, []);
  const prepareMosaicSources = useCallback((images: readonly UnityImage[], signal: AbortSignal) => {
    const current = latest.current;
    if (!current) throw new Error("请先扫描图片资源");
    return prepareUnityImageSources(current, images, signal);
  }, []);
  const mosaicRequest = { root, path: project?.folder || "" };
  async function selectMosaicCandidates(selectedIds: string[], include: boolean, signal?: AbortSignal) {
    const result = await unityRun<{ candidates: MosaicCandidateIndex }>("mosaic-select",
      { ...mosaicRequest, selectedIds, includeMosaic: include }, undefined, signal);
    setMosaicStatus({ root, candidates: result.candidates });
    invalidatePatch();
  }

  async function saveMosaicUserChanges(imageId?: string) {
    const drafts = mosaicDraftsOf(root);
    if (imageId === undefined ? !drafts.size : !drafts.has(imageId)) return;
    setSaving(true);
    try {
      const removeFromPatch: string[] = [];
      for (const [id, draft] of drafts) {
        if (imageId !== undefined && id !== imageId) continue;
        if (!draft.base.saved || draft.patch.saved !== false) continue;
        const entry = mosaicIndex?.[id];
        if (!entry) continue;
        if (entry.source !== draft.base.source || entry.hash !== draft.patch.discardedHash)
          throw new Error("采用结果已更新，请取消撤回后重新操作");
        if (entry.included) removeFromPatch.push(id);
      }
      if (removeFromPatch.length) await selectMosaicCandidates(removeFromPatch, false);
      if (saveMosaicDrafts(root, imageId)) showAppNotice(imageId === undefined ? "已保存图片去码修改" : "已保存当前图片改动");
    } catch (cause) {
      showAppNotice(cause instanceof Error ? cause.message : "无法保存图片去码修改", "error");
    } finally {
      setSaving(false);
    }
  }

  async function readSavedMosaicImage(image: UnityImage, signal: AbortSignal, path = mosaicRequest.path) {
    const result = await unityRun<{ data: string }>("mosaic-preview", { root, path, imageId: image.id }, undefined, signal);
    return new Blob([Uint8Array.from(atob(result.data), c => c.charCodeAt(0))], { type: "image/png" });
  }

  const mosaicStorage = mosaicIndex && {
    index: mosaicIndex,
    saveDraftChanges: (imageId: string) => saveMosaicUserChanges(imageId),
    savedDrafts: mosaicStatus?.root === root ? mosaicStatus.savedDrafts : undefined,
    consumeSavedDrafts: () => setMosaicStatus(value => value?.root === root && value.savedDrafts === mosaicStatus?.savedDrafts
      ? { ...value, savedDrafts: undefined } : value),
    read: readSavedMosaicImage,
    save: async (image: UnityImage, blob: Blob, signal: AbortSignal) => {
      const result = await unityRun<{ candidates: MosaicCandidateIndex }>("mosaic-save",
        { ...mosaicRequest, imageId: image.id, imageSourceHash: image.sourceHash, imageData: await imageBase64(blob) }, undefined, signal);
      setMosaicStatus({ root, candidates: result.candidates });
      if (result.candidates[image.id]?.included) invalidatePatch();
    },
    select: (images: UnityImage[], include: boolean, signal: AbortSignal) =>
      selectMosaicCandidates(images.map(image => image.id), include, signal),
  };
  const openFolder = async (path: string) => {
    setActionError("");
    try { await api.revealPath(path); }
    catch (e) { setActionError(`打开目录失败：${e instanceof Error ? e.message : String(e)}`); }
  };
  const downloadTranslations = (range = lastDownloadScope.current) => operation("下载翻译文件", async () => {
    if (!project || !scanReady) return;
    lastDownloadScope.current = range;
    const entries = range === "all" ? project.entries : filtered;
    if (!entries.length) throw new Error(range === "all" ? "工程中没有可下载的条目" : "没有符合当前筛选条件的条目");
    setFileStatus({ action: "download", state: "working", detail: "请选择下载文件的保存位置…" });
    const path = await saveDialog({
      title: "下载翻译文件", defaultPath: await join(root, unityTranslationFileName(game?.gameExe || "", root)),
      filters: [{ name: "JSON 翻译文件", extensions: ["json"] }, { name: "CSV 翻译表格", extensions: ["csv"] }],
    });
    if (!path) { setFileStatus({ action: "download", state: "cancelled", detail: "已取消下载" }); return; }
    setFileStatus({ action: "download", state: "working", path, detail: `正在生成并保存 ${entries.length} 条原文与译文…` });
    const contents = new TextEncoder().encode(exportUnityTranslations(entries, /\.csv$/i.test(path)));
    await writeDownloadedFile(path, contents, "游戏译文");
    setFileStatus({ action: "download", state: "done", path, folder: await dirname(path), detail: `下载完成：${entries.length} 条 · ${(contents.byteLength / 1024).toFixed(1)} KiB` });
  }, true, detail => setFileStatus(previous => ({ ...previous, action: "download", state: "error", detail: `下载失败：${detail}` })));
  const setImportValidation = (preview: ImportPreview, issues: UnityTranslationImportIssue[] = []) => {
    const byId = new Map(issues.map(issue => [issue.id, issue.reason]));
    const checked = { ...preview, entries: preview.entries.map(entry => {
      const error = byId.get(entry.id) || "";
      return entry.error === error ? entry : { ...entry, error };
    }) };
    setImportPreview(checked); importPreviewRef.current = checked; setRowJump(null);
  };
  const checkImportPreview = (preview = importPreviewRef.current, mode = importMode) => {
    if (!project || !preview) return null;
    setImportIssuePage(0);
    try {
      const result = applyUnityTranslationRows((latest.current || project).entries, preview.entries, unityTranslationError, { mode, allowClear: mode === "replace" });
      setImportValidation(preview);
      setFileStatus({ action: "import", state: "preview", path: preview.path, issues: preview.issues, detail: `预览校验通过：将修改 ${result.changed} 条，其中清空 ${result.cleared} 条${preview.remapped ? `；已重新匹配 ${preview.remapped} 条` : ""}${preview.issues?.length ? `；${preview.issues.length} 项冲突或未匹配内容已跳过，见下方清单` : ""}。请检查后保存导入。` });
      return result;
    } catch (cause) {
      if (cause instanceof UnityTranslationImportError) setImportValidation(preview, cause.issues);
      setFileStatus({ action: "import", state: "error", path: preview.path, detail: `预览校验失败：${cause instanceof Error ? cause.message : String(cause)}`, issues: cause instanceof UnityTranslationImportError ? cause.issues : undefined });
      return null;
    }
  };
  const cancelImportPreview = () => {
    const view = importPreviewRef.current?.view;
    if (view) { setSearch(view.search); setReviewFilter(view.reviewFilter); setPage(view.page); setImagePart(view.imagePart); setActiveStep(view.activeStep); }
    setImportPreview(null); importPreviewRef.current = null; setRowIssue(null); setRowJump(null);
    setFileStatus({ action: "import", state: "cancelled", detail: "已取消导入预览，原工程与源文件保持不变。" });
  };
  async function resetGeneratedPatch(current: UnityProject) {
    const reset = await unityRun<{ workspace: UnityWorkspace<RunCheckpoint> }>("reset-step", {
      root, step: 3, path: current.folder, task: checkpointRef.current || projectCheckpoint(current),
    });
    setPatch(null);
    setFontPlan(null);
    setInstalled(reset.workspace.installed);
    setApplied(false);
    onInstallationChange?.(root, reset.workspace.installed);
  }
  const applyImportPreview = async (choice: UnityTranslationImportMode = importMode) => {
    const preview = importPreviewRef.current;
    if (!preview || !project || busy || restoring || saving) return false;
    setImportMode(choice);
    const result = checkImportPreview(preview, choice);
    if (!result) return false;
    if (!result.changed) {
      setImportPreview(null); importPreviewRef.current = null; setRowIssue(null);
      setFileStatus({ action: "import", state: "done", path: preview.path, detail: "没有需要应用的修改，当前工程和补丁保持不变。" });
      return true;
    }
    return operation("应用导入预览", async () => {
      setSaveComplete(false);
      setFileStatus({ action: "import", state: "working", path: preview.path, detail: `正在应用并保存 ${result.changed} 条译文…` });
      if (dirty) await save(undefined, "text");
      await taskWrites.current;
      await resetGeneratedPatch(project);
      const previous = latest.current || project;
      const oldTranslations = new Map(previous.entries.map(entry => [entry.id, entry.translation]));
      for (const entry of result.entries) if (entry.translation !== oldTranslations.get(entry.id)) entry.translationTarget = target;
      const next = { ...previous, entries: result.entries };
      await unityRun("save", { project: { ...next, images: next.images?.map(image => imageDraftOriginals.current.get(image.id) || image) } });
      publish(next); textDraftOriginals.current.clear(); for (const key of pendingEdits.current) if (key.startsWith("文本与译文：") || key.startsWith("文本勾选：")) pendingEdits.current.delete(key); setDirty(pendingEdits.current.size > 0); setRowIssue(null);
      setImportPreview(null); importPreviewRef.current = null;
      const stats = unityTranslationStats(next.entries.filter(entry => entry.selected && scope.ids.has(entry.id)), unityTranslationError, unityTranslationContextKey);
      const progress: GenerationProgress = { ...stats, step: 2, state: stats.completed === stats.total ? "done" : "pending", detail: "导入译文已保存，后续步骤进度已清空" };
      remember({ ...projectCheckpoint(next), step: 2, endStep: 2, finished: stats.completed === stats.total, translationRuns: { text: progress, images: checkpointRef.current?.translationRuns?.images || { step: 2, state: imagesReady ? "done" : "pending", completed: 0, total: null, detail: "图片结果已保留" } }, progress }); await taskWrites.current;
      setFileStatus({ action: "import", state: "done", path: preview.path, issues: preview.issues, folder: await dirname(preview.path), detail: `导入已应用：修改 ${result.changed} 条，其中清空 ${result.cleared} 条，保留 ${result.preservedExisting} 条已有译文。${preview.issues?.length ? `另有 ${preview.issues.length} 项冲突或未匹配内容未应用，清单已保留。` : ""}源文件未改动。` });
      setSavedChanges([`导入译文：修改 ${result.changed} 条，清空 ${result.cleared} 条`]);
      setSaveComplete(true);
    }, true, detail => setFileStatus(previous => ({ ...previous, action: "import", state: "error", detail: `${importPreviewRef.current ? "应用失败" : "译文已保存，后续处理失败"}：${detail}` })));
  };
  applyImportRef.current = applyImportPreview;
  const uploadTranslations = (retryPath?: GameImportSource, mode = importMode) => operation("导入翻译文件", async () => {
    if (!project || !scanReady) return;
    setFileStatus({ action: "import", state: "working", path: typeof retryPath==="string"?retryPath:retryPath?.name, detail: "正在读取导入文件…" });
    const path = retryPath || await open({ title: "导入翻译文件", defaultPath: root, multiple: false, filters: [{ name: "翻译文件", extensions: ["json", "csv"] }] });
    if (!path) { setFileStatus({ action: "import", state: "cancelled", detail: "已取消导入，工程未覆盖" }); return; }
    let imported: ReturnType<typeof readUnityTranslationRows>;
    try { imported = readUnityTranslationRows(project.entries, new TextDecoder("utf-8", { fatal: true }).decode(typeof path==="string"?await readFileBytes(path):await path.arrayBuffer()), /\.csv$/i.test(typeof path==="string"?path:path.name), true); }
    catch (cause) {
      if (cause instanceof UnityTranslationImportError) { setImportIssuePage(0); setFileStatus({ action: "import", state: "error", path:typeof path==="string"?path:path.name, detail: `文件校验失败：${cause.message}`, issues: cause.issues }); }
      throw cause;
    }
    const importPath=typeof path==="string"?path:path.name;
    const byId = new Map(imported.map(row => [row.id, row]));
    const preview = { path:importPath, issues: imported.issues, remapped: imported.remapped, view: { search, reviewFilter, page, imagePart, activeStep }, entries: project.entries.filter(entry => byId.has(entry.id)).map(entry => {
      const translation = byId.get(entry.id)!.translation;
      return { ...entry, translation, layoutDraft: undefined, error: "" };
    }) };
    setImportMode(mode); setImportPreview(preview); importPreviewRef.current = preview;
    setImagePart(false); setActiveStep(2); setSearch(""); setReviewFilter("all"); setPage(0); setRowIssue(null);
    checkImportPreview(preview, mode);
    if (imported.remapped || imported.issues.length) logAction(`导入定位：重新匹配 ${imported.remapped} 条，跳过 ${imported.issues.length} 项冲突或未匹配内容`, imported.issues.length ? "warning" : "info");
  }, true, detail => setFileStatus(previous => ({ ...previous, action: "import", state: "error", detail: `导入失败：${detail}` })));
  const textDropRoot=useRef<HTMLElement>(null);
  const textDrop=useGameFileDrop({active:active&&activeStep===2&&!imagePart&&!busy&&!restoring,root:textDropRoot,match:(_target,names)=>names.length<=1&&(!names[0]||/\.(json|csv)$/i.test(names[0]))?textDropRoot.current:null,label:()=>"松开以导入翻译文件",drop:async source=>{await uploadTranslations(source);},error:setActionError});
  const openTranslationFile = async (path: string) => {
    setActionError("");
    try { await api.openPath(path); } catch (error) { setActionError(`打开文件失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  const chooseFont = () => operation("选择字体", async () => {
    const path = await open({ defaultPath: await join(await resourceDir(), "fonts"), filters: [{ name: "字体", extensions: ["ttf", "otf"] }] });
    if (typeof path !== "string") return;
    setFontPath(path); setFontPlan(null); invalidatePatch(); setError("");
    const task = checkpointRef.current;
    if (task?.step === 3) { remember({ ...task, fontPath: path, patch: null, patchFolder: "", progress: { step: 3, state: "pending", completed: 0, total: null, detail: "字体已更换，请检查缺字后重新生成补丁" } }); await taskWrites.current; }
  });
  const checkFontPlan = () => operation("字库检查", async () => {
    if (!project) return;
    const controller = new AbortController(); abort.current = controller;
    const previousProgress = generation;
    if (checkpointRef.current) { remember({ ...checkpointRef.current, fontPath, extraCharacters }); setGeneration(previousProgress); }
    try {
      await taskWrites.current;
      setFontPlan(await unityRun<UnityFontPlan>("font-plan", { project, selectedIds: selected.map(entry => entry.id), fontPath, extraCharacters }, progress => setMessage(progress.detail), controller.signal));
    } catch (error) { if (error instanceof UnityPaused) setMessage("字库检查已中止，工程与译文保留，可重新检查。"); else throw error; }
    finally { abort.current = null; }
  }, true, setActionError);
  const reflowExisting = async () => {
    if (!project || busy || restoring || !scanReady) return;
    if ((patch || applied) && !await confirm(applied ? "请先关闭游戏。重新断行将保留已安装补丁，清理未安装的旧产物；完成后需重新生成并应用补丁。继续？" : "重新断行会清理现有补丁，保留扫描和译文；排版完成后需重新生成补丁。继续？", { title: "重新断行", okLabel: "清理并继续", cancelLabel: "取消" })) return;
    await operation("仅重新断行", async () => {
      if (dirty) await save(); await taskWrites.current;
      if (patch || applied) await resetGeneratedPatch(project);
      const next = structuredClone(latest.current || project);
      for (const entry of next.entries) if (entry.selected && scope.ids.has(entry.id) && /[\r\n]/.test(entry.source) && entry.translation && !unityTranslationError(entry.source, entry.translation)) {
        entry.layoutDraft = entry.translation; entry.error = "";
      }
      await unityRun("save", { project: next }); publish(next);
      remember({ ...projectCheckpoint(next), translationRuns: checkpointRef.current?.translationRuns, step: 2, endStep: 2, automatic: false, finished: false, layoutOnly: true, joinLines: true, lineMode, lineModel, progress: { step: 2, state: "running", detail: "仅重新断行，复用已有译文", completed: 0, total: null } });
      await taskWrites.current; await runWorkflow(2, 2, true);
    });
  };
  const launchGame = () => {
    if (!applied || locked || !root || error) return;
    return operation("启动游戏", async () => {
      const result = await api.unityLaunch(root);
      if (!result.ok) throw new Error(result.error || "启动游戏失败");
      setMessage("已请求启动游戏。");
    }, true, setActionError);
  };
  const uninstallPatch = () => runUninstall<RunCheckpoint>({
    locked, confirm, operation, beforeUninstall: () => taskWrites.current,
    onProgress: progress => showLocalActivity(progress.detail, "running", imagePart, progress.completed, progress.total),
    restoreWorkspace: workspace => {
      const p = workspace.saved.project;
      if (p?.images) p.images = p.images.map(normalizeUnityImageSelection);
      latest.current = p; setProject(p);
      checkpointRef.current = workspace.task; setCheckpoint(workspace.task); resetQueuedSignature();
      setPatch(null);
    },
    finishUninstall: () => { setGeneration(null); setDirty(false); setActiveStep(3); },
  });
  const textBatchErrors: BatchRow[] = translationFailures.map(entry => ({
    id: entry.id, label: "#" + entry.id, detail: explainUnityFailure(entry.error).reason, kind: "text" as const,
  }));
  const textBatch = textBatchErrors.length > 0 && <GameBatchResults errors={textBatchErrors} onLocate={row => locateTranslationFailure(row.id)}
    onRetry={!busy && !restoring && connectionReady && !applied ? () => {
      retryFailureIds.current = new Set(translationFailures.map(entry => entry.id));
      startTranslationPart("text");
    } : undefined} />;
  const textTransfer = fileStatus && <details className={`unity-transfer-output${fileStatus.state === "error" ? " unity-offline-error" : ""}${fileStatus.state === "preview" ? " is-pending" : ""}`} open aria-label="翻译文件处理结果">
        <summary>{fileStatus.action === "download" ? "翻译文件下载" : "翻译文件导入"} · {fileStatus.state === "preview" ? <span className="unity-transfer-pending-state" role="status">待应用</span> : fileStatus.state === "working" ? "处理中" : fileStatus.state === "error" ? "失败" : fileStatus.state === "cancelled" ? "已取消" : "已完成"}</summary>
        {(fileStatus.state === "working" || fileStatus.state === "done") &&
          <GameProgressBar label="翻译文件处理进度" value={fileStatus.state === "done" ? 100 : undefined} />}
        {fileStatus.needsValidation && <p className="unity-import-recheck" role="status"><span>预览已修改，以下保留上次校验结果；修改完成后统一校验。</span><button type="button" className="unity-transfer-locate" disabled={!!busy || restoring} onClick={() => checkImportPreview()}>统一校验</button></p>}
        {fileStatus.state === "error" ? <>
          <p role="alert"><button type="button" className="unity-transfer-retry" disabled={!!busy || restoring || !scanReady} data-tooltip={importPreview ? "校验右侧当前编辑的导入预览，不重新读取磁盘文件" : "重新读取并校验文件"} aria-label={importPreview ? "校验右侧当前编辑的导入预览，不重新读取磁盘文件" : "重新读取并校验文件"} onClick={() => void (importPreview ? checkImportPreview() : fileStatus.action === "import" ? uploadTranslations(fileStatus.path) : downloadTranslations())}>{fileStatus.detail} · {fileStatus.action === "import" ? importPreview ? "点击校验预览" : "点击重新读取文件" : "点击重试下载"}</button></p>
          {fileStatus.action === "import" && <p>{importPreview ? "请检查导入内容后重试，或取消此次导入。" : "请修正文件格式或条目标识后重新选择导入；工程尚未覆盖。"}</p>}
          {!!importIssues.length && <div className="unity-import-issues" aria-label="导入校验问题">
            <ul>{visibleImportIssues.map((issue, index) => <li key={`${issue.id}:${index}`}>
              {importPreview ? <button type="button" className="unity-transfer-locate" data-tooltip="定位右侧对应条目" aria-label="定位右侧对应条目" onClick={() => locateTranslationFailure(issue.id)}>第 {issue.id} 条</button> : <strong>{issue.id}</strong>}
              <p>{issue.reason}</p>
              {(issue.source || issue.translation) && <details className="unity-import-comparison"><summary>查看原文与导入译文</summary><dl><dt>原文</dt><dd>{issue.source}</dd><dt>{fileStatus.needsValidation ? "上次校验译文" : importPreview ? "当前预览译文" : "导入译文"}</dt><dd>{issue.translation}</dd></dl></details>}
            </li>)}</ul>
            {importIssuePages > 1 && <div className="unity-import-issue-pages"><button type="button" className="unity-btn" disabled={visibleImportIssuePage === 0} onClick={() => setImportIssuePage(visibleImportIssuePage - 1)}>上一页</button><GamePageNumber page={visibleImportIssuePage} pages={importIssuePages} onPage={setImportIssuePage} /><button type="button" className="unity-btn" disabled={visibleImportIssuePage + 1 >= importIssuePages} onClick={() => setImportIssuePage(visibleImportIssuePage + 1)}>下一页</button></div>}
          </div>}
        </> : <p role="status">{fileStatus.detail}</p>}
        {fileStatus.state === "done" && fileStatus.path && <div className="unity-transfer-links">
          <a href="#" data-tooltip={fileStatus.path} aria-label={fileStatus.path} onClick={event => { event.preventDefault(); void openTranslationFile(fileStatus.path!); }}>文件：{fileStatus.path}</a>
          {fileStatus.folder && <a href="#" data-tooltip={fileStatus.folder} aria-label={fileStatus.folder} onClick={event => { event.preventDefault(); void openFolder(fileStatus.folder!); }}>文件夹：{fileStatus.folder}</a>}
        </div>}
  </details>;
  const scanResourceCounts = useMemo(() => {
    const counts = { ready: 0, empty: 0, partial: 0, failed: 0 };
    for (const resource of project?.resources ?? []) counts[resource.state]++;
    return counts;
  }, [project?.resources]);
  const scanResources = <section className="unity-scan-resources" aria-label="资源信息"><h3>资源信息</h3>
    <GameWorkDirectory path={workRoot} onOpen={path=>void openFolder(path)}/>{!preparingRescan&&<>
      {!!project?.resources?.length && <dl className="unity-scan-resource-counts">
        <div><dt>可读取</dt><dd>{scanResourceCounts.ready}</dd></div>
        <div><dt>无正文或字体</dt><dd>{scanResourceCounts.empty}</dd></div>
        <div><dt>部分解析</dt><dd>{scanResourceCounts.partial}</dd></div>
        <div className={scanResourceCounts.failed ? "has-error" : undefined}><dt>失败</dt><dd>{scanResourceCounts.failed}</dd></div>
      </dl>}
      {!!project?.diagnostics?.length && <details><summary>未提取的资源与原因 · {project.diagnostics.length} 项</summary>{project.diagnostics.map((issue, index) => <div key={index} className="unity-warning-item"><strong>{issue.file}{issue.container ? ` / ${issue.container}` : ""}{issue.objectId ? ` / 对象 ${issue.objectId}` : ""}</strong><p>{issue.reason}</p><p>{issue.action}</p></div>)}</details>}
      {!!project?.fonts.length && <details><summary>已识别字体 · {project.fonts.length} 个</summary>{project.fonts.map((f, i) => <p key={i}>{f.name} · {f.kind} · {f.file}</p>)}</details>}
      {!!streamWarnings.length && <details><summary>对象读取范围不足 · {streamWarnings.length} 项</summary><p>{streamWarnings[0].reason}</p><p className="hint">{streamWarnings[0].impact}</p>{streamWarnings.map((info, i) => <details className="unity-warning-item" key={`stream${i}`}><summary>{info.location}</summary><pre>{info.technical}</pre></details>)}</details>}
      {warningDetails.some(w => w.category !== "stream") && <details aria-label="其他输出提示"><summary>其他提示 · {warningDetails.filter(w => w.category !== "stream").length} 项</summary>{warningDetails.filter(w => w.category !== "stream").map((info, i) => <div className="unity-warning-item" key={`w${i}`}><p>{info.reason}</p>{info.technical && <details><summary>技术详情</summary><pre>{info.technical}</pre></details>}</div>)}</details>}
    </>}</section>;

  const finishColumnDrag = () => {
    if (!columnDrag.current) return;
    const ratio = columnDrag.current.latest; columnDrag.current = null;
    setOriginalRatio(ratio); localStorage.setItem("unity-offline-original-ratio", String(ratio));
  };
  const partRunning = currentParts?.[currentPart]?.state === "running";
  const partStopping = translationJobs.current?.isStopping(currentPart) || false;
  const imagePartPaused = currentParts?.images.state === "stopped" || currentParts?.images.state === "error";
  const textPartPaused = currentParts?.text.state === "stopped" || currentParts?.text.state === "error";
  const textCleanupAvailable = !!stepPerformance(promptState.scope + ":text", "translate").taskId ||
    !!project?.entries.some(entry => entry.translation || entry.layoutDraft || entry.error) || !!patch || !!fontPlan;
  const imageRecognitionCleanupAvailable = !!project?.images?.some(image => image.ocrCompleted || image.renderedFile);
  const imageRun = checkpoint?.translationRuns?.images;
  const imageRunAttempted = !!imageRun && imageRun.state !== "pending" && imageRun.state !== "skipped";
  const imageTranslationAttempted = (imageRunAttempted && checkpoint?.imageTask === "translate") || !!project?.images?.some(image => image.renderedFile || image.regions.some(region => !!region.translation || !!region.beforeReview));
  const imageRecognitionAttempted = imageRecognitionCleanupAvailable || imageRunAttempted && checkpoint?.imageTask === "recognize";
  const imageScreeningAttempted = !!project?.images?.some(image => image.screening) || imageRunAttempted && checkpoint?.imageTask === "filter";
  const imageRefineAttempted = !!project?.images?.some(image => image.screening?.refineKey) || imageRunAttempted && checkpoint?.imageTask === "refine";
  const imageReviewAttempted = !!project?.images?.some(image => image.regions.some(region => region.beforeReview));
  const imageRenderAttempted = !!project?.images?.some(image => image.renderedFile);
  const canClearImageStep = scanReady && !busy && !restoring && !saving && !imageEditorBusy && !importPreview;
  const benchmarkWorkload = useRef({ scope: promptState.scope, entries: project?.entries || [], selected });
  benchmarkWorkload.current = { scope: promptState.scope, entries: project?.entries || [], selected };
  const openBenchmark = () => {
    const initial = benchmarkWorkload.current;
    openGameTextBenchmark({
      scope: initial.scope,
      getWorkload: () => benchmarkWorkload.current.scope === initial.scope ? benchmarkWorkload.current : initial,
      models: gameModels, onMessage: logAction, screenModel: textScreenModel, mosaicRoot: root, initialPart: mosaicPage ? "mosaic" : imagePart ? "images" : "text",
      images: {
        setup: { scope: promptState.scope, source: picture.onlySourceLanguage ? picture.source : "auto", target: picture.target, skipTarget: picture.skipTargetLanguage !== false,
          prompts: promptState.selection, mode: imageOcrMode, strategy: imageScreeningOptions.strategy, concurrency: imageConcurrency,
          confidence: imageConfidenceThreshold, refineMode: imageRefine.mode, refineConcurrency: imageRefine.concurrency, refineConfidence: imageRefine.confidence, engines: picture.engines,
          steps: { filter: imageScreeningOptions.filterModel || "", refine: imageRefineModel || "", recognize: imageVisionModel || "", imageTranslate: picture.kind === "engine" ? "" : imageModel,
            review: imageReviewModel, render: imageLayoutModel || "" } },
        getWorkload: () => {
          const current = latest.current;
          const imageProject = current?.root === root ? current : null;
          return { project: imageProject, selected: imageProject?.images?.filter(image => image.selected) || [], embedded: false };
        },
        readImage: readUnitySourceImage,
      },
      current: { source: onlySourceLanguage ? scope.language : "auto", target, wrap: wrapMode, includeContext, skipTarget: skipTargetLanguage,
        prompts: promptState.selection, engines: engineChoices, modelIds: {text:translationKind === "engine" ? "" : llmModel,dialogue:dialogueModel,names:nameModel} },
    });
    return true;
  };
  useProjectBenchmarkLauncher(active && !!game, openBenchmark);
  const [flowConfig, setFlowConfig] = useState<string | null>(null);
  const imageRefine = imageScreeningOptions.refine;
  const imageRefineModel = imageRefine.method === "llm" ? imageRefine.model ?? defaultGameImageVision(gameModels) : undefined;
  const imagesNeedScreen = (project?.images || []).some(image => needsUnityImageScreening(image, picture.source, picture.target, imageScreeningOptions));
  const imagesNeedRefine = (project?.images || []).some(image => unityImageRefinementPending(image, imageRefine));
  const imagesNeedRecognition = (project?.images || []).some(image => image.selected && !image.ocrCompleted);
  const includeImageRegion = gameImageRegionLanguageFilter(picture.source, picture.target, picture.onlySourceLanguage !== false, picture.skipTargetLanguage !== false);
  const pendingImageRegions = (project?.images || []).flatMap(image => image.selected && image.ocrCompleted ?
    image.regions.filter(region => region.selected && includeImageRegion(region.text) &&
      (!region.translation || region.translationTarget && region.translationTarget !== picture.target ||
        !!region.error || !!gameImageTranslationProblem(region.text,region.translation,picture.target))) : []);
  const recognitionReady = !imagesNeedScreen && !imagesNeedRefine && !imagesNeedRecognition;
  const { textDone: imageTextDone, reviewReady: imageReviewReady } = gameImageTranslationReadiness(recognitionReady,
    pendingImageRegions.some(region => !region.error || !imageReviewModel), pendingImageRegions.length > 0, !!imageReviewModel);
  const screenComplete = textScreened || textReady;
  const partHasWork = imagePart ? imagesNeedScreen || imagesNeedRefine || imageRedrawCount > 0 || (project?.images || []).some(image => image.selected && (!image.ocrCompleted || !unityImageWorkDone(image, target))) : selected.length > 0 && !textReady;
  const partActionDisabled = restoring || saving || !scanReady || (!partRunning && !textScreening && (!!busy && !translationJobs.current || !partHasWork || (!imagePart && textScreened || imagePart && !imagesNeedRecognition && !imageRenderReady) && !connectionReady));
  const saveFeedback = saveComplete && <div className="unity-save-feedback" role="status"><strong>保存成功</strong>{savedChanges.length > 0 && <ul>{savedChanges.slice(0, 5).map((change, index) => <li key={index}>{change}</li>)}</ul>}{savedChanges.length > 5 && <small>另有 {savedChanges.length - 5} 项修改已保存</small>}</div>;
  const runningFlowStep = imagePart ? imageTask.current : textScreening || currentParts?.text.textStage === "screening" || !screenComplete ? "screen" : "translate";
  const redrawPhase = imagePart && runningFlowStep === "redraw";
  const partProgressState = currentParts?.[currentPart]?.state ??
    (generation?.step === 2 && progressIsImage === imagePart ? generation.state : "pending");
  const flowProgressState = !imagePart && textScreening || partRunning ? "running" :
    redrawPhase && partProgressState === "error" ? "error" : (imagePart ? imagesReady : textReady) ? "done" : partProgressState;
  const sharedLanguageLocked = testing || !!busy || textScreening || restoring || saving || applyingTestConfiguration || !scanReady || !!importPreview;
  const flowConfigComplete = imagePart ? flowConfig === "filter" ? !imagesNeedScreen : flowConfig === "refine" ? !imagesNeedRefine :
    flowConfig === "recognize" ? !imagesNeedRecognition : flowConfig === "translate" || flowConfig === "review" ? imageTextDone : imagesReady :
    flowConfig === "screen" ? screenComplete : textReady;
  const flowConfigLocked = testing || restoring || saving || applyingTestConfiguration || !scanReady || !!importPreview ||
    (!!busy || textScreening) && (flowConfigComplete || flowProgressState === "running" && flowConfig === runningFlowStep);

  const prompt = (scene: keyof typeof promptState.selection) => promptState.selection[scene] || "builtin:" + scene;
  const sharedConfiguration = [translationKind, target, skipTargetLanguage,
    translationKind === "engine" ? engineChoices : includeContext];
  const textModels = translationKind !== "engine" ? [llmModel, prompt("text"), dialogueModel, prompt("dialogue"), nameModel, prompt("names")] : [];
  const imageModels = picture.kind !== "engine" ? [imageModel, prompt("image"), imageReviewModel, prompt("review")] : [];
  const configuration = imagePart ? {
    filter: JSON.stringify([source, onlySourceLanguage, target, skipTargetLanguage, imageConcurrency, imageScreeningOptions.strategy, imageScreeningOptions.filterModel, prompt("screen")]),
    refine: JSON.stringify([imageRefine, imageRefineModel, prompt("refine")]),
    review: JSON.stringify([imageReviewModel, prompt("review")]),
    render: JSON.stringify([imageLayoutModel, prompt("layout")]),
    redraw: JSON.stringify(imageRedrawProfile),
    recognize: JSON.stringify(imageVisionModel === undefined
      ? [imageOcrMode, imageConcurrency, imageConfidenceThreshold] : [imageVisionModel, prompt("recognize"), imageOcrMode === "manga"]),
    translate: JSON.stringify([picture, ...imageModels, includeContext]),
  } : {
    screen: JSON.stringify([source, onlySourceLanguage, target, skipTargetLanguage, textScreenModel ?? null, textScreenModel !== undefined ? prompt("textScreen") : null]),
    translate: JSON.stringify([...sharedConfiguration, ...textModels, wrapMode,
      joinLines && wrapMode !== "natural" ? [lineMode, lineMode === "model" ? [lineModel || settings.model, prompt("line")] : null] : null]),
  };
  const restoreConfiguration = (step: string) => {
    if (imagePart && step === "redraw") { setImageRedrawProfile(imageRedrawProfile); return; }
    if (imagePart && (step === "filter" || step === "refine")) {
      setImageScreeningOptions(imageScreeningOptions);
      const scene = step === "filter" ? "screen" : "refine";
      promptState.select(scene, prompt(scene));
      return;
    }
    if (step === "screen") {
      setSource(source); setOnlySourceLanguage(onlySourceLanguage); setTarget(target); setSkipTargetLanguage(skipTargetLanguage);
      setTextScreenModel(textScreenModel); promptState.select("textScreen", prompt("textScreen"));
      return;
    }
    if (step === "recognize") {
      setImageVisionModel(imageVisionModel); setImageOcrMode(imageOcrMode);
      setImageConcurrency(imageConcurrency); setImageConfidenceThreshold(imageConfidenceThreshold);
      promptState.select("recognize", prompt("recognize"));
      return;
    }
    if (imagePart && step === "render") {
      setImageLayoutModel(imageLayoutModel); promptState.select("layout", prompt("layout"));
      return;
    }
    if (imagePart && step === "translate") {
      changePicture(picture); setImageModel(imageModel); setIncludeContext(includeContext);
      promptState.select("image", prompt("image"));
      return;
    }
    setTranslationKind(translationKind); setTarget(target); setSkipTargetLanguage(skipTargetLanguage);
    setIncludeContext(includeContext); setEngineChoices(engineChoices);
    if (imagePart) {
      setImageModel(imageModel); setImageReviewModel(imageReviewModel); setImageLayoutModel(imageLayoutModel);
      for (const scene of ["image", "review", "layout"] as const) promptState.select(scene, prompt(scene));
    } else {
      setLlmModel(llmModel); setDialogueModel(dialogueModel); setNameModel(nameModel);
      for (const scene of ["text", "dialogue", "names"] as const) promptState.select(scene, prompt(scene));
      if (step === "translate") {
        setWrapMode(wrapMode); setJoinLines(joinLines); setLineMode(lineMode); setLineModel(lineModel);
        promptState.select("line", prompt("line"));
      }
    }
  };
  const visibleGeneration = viewingProgress ? generation : null;
  const progressState = visibleGeneration && localActivity?.value === visibleGeneration && visibleGeneration.state === "running"
    ? "running" : activeStep === 2 ? flowProgressState : visibleGeneration?.state ?? (activeStep === 3 ? applied ? "done" : "pending" : activeStep <= completedThrough ? "done" : "pending");
  const redrawSummary = activeStep === 2 && redrawPhase ? gameImageRedrawSummary(visibleGeneration, progressState === "error") : undefined;
  const showProgressCount = !(activeStep === 2 && redrawPhase && progressState === "error" && !redrawSummary);
  const scanTiming = activeStep === 1 && progressState === "done" ? project?.scanMetrics : undefined;
  const scanThroughput = activeStep === 1 && progressState === "done" && project
    ? formatFlowThroughput(stepPerformance(deploymentMetricScope(root, "scan"), "scan"), "个") ??
      formatFlowThroughput(scanTiming && { itemsDone: scanTiming.parsed + scanTiming.reused, elapsedMs: scanTiming.totalMs }, "个")
    : undefined;
  const deploymentPhase = activeStep === 3 ? (visibleGeneration?.step === 4 || !visibleGeneration && applied ? "apply" : "generate") : undefined;
  const progressMetricStage = activeStep === 1 ? "scan" : deploymentPhase;
  const progressMeasurement = progressMetricStage
    ? stepPerformance(deploymentMetricScope(root, progressMetricStage), progressMetricStage) : undefined;
  const deploymentElapsed = deploymentPhase ? progressMeasurement?.elapsedMs : undefined;
  const elapsed = (activeStep === 1 ? checkpoint?.scanElapsedMs || scanTiming?.totalMs
    : activeStep === 3 ? deploymentElapsed : visibleGeneration?.elapsedMs) ?? 0;
  const elapsedOrigin = activeStep === 1 ? elapsedOrigins.current.scan :
    activeStep === 2 ? elapsedOrigins.current[currentPart] : undefined;
  const taskDetail = progressState === "running" || progressState === "stopped" ? visibleGeneration?.detail : undefined;
  const scanResource = activeStep === 1
    ? taskDetail?.match(/^读取资源对象：(.+) · 对象 (\d+) \/ (\d+) · 已提取 (\d+) 条文本$/)
    : undefined;
  const mosaicMounted = mosaicPage || !!mosaicControls;
  const mosaicDisabled = !!workflowBusy || restoring || saving || applyingTestConfiguration || !!imageEditorBusy || !!importPreview;
  const selectWorkflowStage = (tab: (typeof UNITY_STAGE_TABS)[number]) => {
    if (deploymentController.current) return;
    const change = () => {
      followProgress.current = false;
      if (tab.id === "2.3") {
        setWorkflowStep(2);
        setMosaicPage(true);
      } else {
        setActiveStep(tab.step);
      }
      setImagePart(tab.imageOnly);
    };
    if (activeStep === 2 && imagePart && tab.id !== "2.2" && imageLeaveGuard.current) imageLeaveGuard.current(change);
    else change();
  };
  const cardActions = <>
      {activeStep !== 2 && !(activeStep === 3 && busy) && taskAction}
      {activeStep === 1 && !busy && !restoring && <button className="unity-btn unity-btn-primary" disabled={testing || !root || !output} title={testTitle}
        onClick={() => void (preparingRescan ? startWorkflow(1, 1, false, false, true) : scanStarted ? restartStage(1) : startWorkflow(1, 1))}>
        {!preparingRescan && scanStarted ? "重新扫描资源" : "开始扫描"}
      </button>}
      {activeStep === 1 && project && !busy && !restoring && !saving && <button type="button" className="unity-btn unity-btn-warning" onClick={() => void clearResourceScan()}>清理扫描</button>}
      {imageEditorBusy && <button className="unity-btn" onClick={() => imageEditorAbort.current?.abort()}>停止处理</button>}
      {generation && !viewingProgress && <button className="unity-btn" onClick={() => { setActiveStep(generation.step); setImagePart(!!checkpoint?.imageOnly); }}>查看进度</button>}
  </>;
  const cardProgressDetails = <StepProgressDetails
    manualReviewCount={activeStep === 2 && imagePart && !readiness.imagesSkipped ? readiness.manualReviewImages : undefined}
    scanResource={scanResource} taskDetail={(activeStep !== 2 || imagePart) && taskDetail} scanThroughput={scanThroughput} scanTiming={scanTiming}
    translation={activeStep === 2 && !imagePart && !progressIsImage && generation?.step === 2 ? {
      progress: generation, running: progressRunning, failure: generation.state === "error" ? generation.failure || generation.detail : undefined,
      onLocate: locateTranslationFailure,
    } : undefined}
    />;
  const cardActivity: GameFlowActivity = {
    state: progressState, label: redrawSummary?.label ?? gameProgressLabels[progressState],
    elapsed: elapsed > 0 || elapsedOrigin !== undefined ? <WorkflowElapsed elapsed={elapsed} origin={elapsedOrigin} /> : undefined,
    actions: cardActions,
    progress: {
      unit: activeStep === 2 ? imagePart ? "张" : "条" : "个",
      sample: scanResource?.[1],
      current: !redrawSummary && showProgressCount && visibleGeneration?.total ? visibleGeneration.completed : undefined,
      total: !redrawSummary && showProgressCount ? visibleGeneration?.total || undefined : undefined,
      count: redrawSummary?.count,
      percent: redrawSummary?.percent ?? (visibleGeneration && showProgressCount ? progressPercent : undefined),
      details: progressState === "running" ? cardProgressDetails : undefined,
    },
    details: progressState !== "running" ? cardProgressDetails : undefined,
  };
  const deploymentPlan = useMemo(() => deploymentPlanState?.root === root ? deploymentPlanState.plan : loadDeploymentPlan(root), [deploymentPlanState, root]);
  const patchScope = checkpoint?.patch?.deploymentExcluded ?? [];
  const deploymentValidation = useMemo(() => validateDeploymentPlan(deploymentPlan), [deploymentPlan]);
  const disabledPhases = deploymentPhases.filter(id => deploymentPlan.disabled.includes(id));
  const activePatch = patch && disabledPhases.every(id => patchScope.includes(id)) ? patch : null;
  const fullPatch = !!activePatch && patchScope.length === disabledPhases.length;
  const currentStoppedStep = deploymentStop?.root === root ? deploymentStop.step : null;
  const reportMosaicCompletion = useCallback((complete: boolean) => {
    setMosaicWorkbenchState(previous => previous?.root === root && previous.complete === complete ? previous : { root, complete });
  }, [root]);
  const reportMosaicBusy = useCallback((running: boolean) => {
    setMosaicBusy(running);
    if (running) setMosaicCompleted("");
  }, []);
  const patchImages = (project?.images || []).filter(image => image.selected && unityImageReadyForTarget(image, picture.target));
  const mosaicCount = (project?.images || []).filter(image => {
    const candidate = mosaicIndex?.[image.id];
    return !!image.sourceFile && !!candidate?.included && candidate.source === image.sourceHash;
  }).length;
  const noMosaicImages = scanReady && !project?.images?.some(image => image.sourceFile && image.width > 0 && image.height > 0);
  const mosaicReady = !mosaicBusy && !!project && (noMosaicImages || mosaicCompleted === project.folder ||
    (mosaicWorkbenchState?.root === root ? mosaicWorkbenchState.complete :
      hasMosaic && !Object.values(mosaicIndex ?? {}).some(candidate => !candidate.included)));
  const deploymentCompleted: DeploymentStep[] = [
    ...(scanReady ? ["scan" as const] : []),
    ...(textReady ? ["text" as const] : []),
    ...(imagesReady ? ["image" as const] : []),
    ...(mosaicReady ? ["mosaic" as const] : []),
  ];
  const deploymentComplete = isGameDeploymentComplete(deploymentValidation.enabledSteps, deploymentCompleted, {
    applied: applied && fullPatch,
    blocked: !!busy || mosaicBusy || textScreening || !!imageEditorBusy || !!currentStoppedStep ||
      !!deploymentRun || !!deploymentValidation.issues.length || generation?.state === "error" || generation?.state === "stopped",
  });
  if (deploymentComplete) deploymentCompleted.push("apply");
  const enabledPhases = deploymentPhases.filter(id => !deploymentPlan.disabled.includes(id));
  const eligibleTextIds = unityLanguageScope(project?.entries || [], source, onlySourceLanguage).ids;
  const textCount = project?.entries.filter(entry => entry.selected && eligibleTextIds.has(entry.id) && !entry.error && entry.translation && textTranslationMatchesTarget(entry, target)).length || 0;
  const scopedPatchReady = scanReady && (enabledPhases.includes("text") && textReady && textCount > 0 ||
    enabledPhases.includes("image") && imagesReady && patchImages.length > 0 ||
    enabledPhases.includes("mosaic") && mosaicCount > 0);

  function changeDeploymentPlan(plan: DeploymentPlan) {
    if (!root || locked || deploymentController.current) return false;
    try {
      saveDeploymentPlan(root, plan);
      if (deploymentPhases.some(phase => plan.disabled.includes(phase) !== deploymentPlan.disabled.includes(phase))) {
        invalidatePatch();
        setApplied(false);
        const saved = checkpointRef.current;
        if (saved?.patch) remember({ ...saved, patch: null, patchFolder: "" });
      }
      setDeploymentPlanState({ root, plan });
      return true;
    } catch (error) {
      setActionError("保存流程配置失败：" + String(error));
      return false;
    }
  }

  function focusDeploymentStep(step: DeploymentStep) {
    const id = deploymentStageId[step];
    const stage = UNITY_STAGE_TABS.find(item => item.id === id);
    if (stage) selectWorkflowStage(stage);
  }

  function runDeploymentMosaic(current: UnityProject, signal: AbortSignal, report: (value: UnityProgress) => void) {
    return measureDeploymentStage(root, "mosaic", () => performDeploymentMosaic(current, signal, report));
  }

  async function performDeploymentMosaic(current: UnityProject, signal: AbortSignal, report: (value: UnityProgress) => void) {
    let { candidates } = await unityRun<{ candidates: MosaicCandidateIndex }>("mosaic-status", { root });
    const preferences = readMosaicSettings(root), modelFile = gameDetectorFile(root);
    const detectorKey = mosaicDetectorKey(preferences.detector, modelFile, preferences.screening);
    const rows = readMosaicRows(root);
    const savedRow = (image: UnityImage) => rows[image.id]?.source === image.sourceHash ? rows[image.id] : undefined;
    const usable = (current.images || []).filter(image => image.sourceFile && image.width > 0 && image.height > 0);
    const scenes = usable.filter(image => /(?:^|[\\/])img[\\/]pictures[\\/]/i.test(image.file));
    const eligible = (preferences.scope === "scenes" && scenes.length ? scenes : usable).filter(image => {
      const row = savedRow(image);
      return !row?.manualChecked || row.checked;
    });
    const reusable = (image: UnityImage) => {
      const candidate = candidates[image.id], row = savedRow(image);
      return candidate?.source === image.sourceHash && (candidate.included ||
        row?.discardedHash !== candidate.hash && row?.discardedHash !== candidate.source);
    };
    const reused = eligible.filter(reusable);
    const ids = new Set(reused.filter(image => !candidates[image.id].included).map(image => image.id));
    const images = eligible.filter(image => !reusable(image));
    const request = { root, path: current.folder };
    const scope = deploymentMetricScope(root, "mosaic");
    const selections = gameStepSelections(scope, "mosaic");
    for (const _image of reused) recordGameCacheHit(scope);
    let failed = 0;
    const reviewUpdates: MosaicErrorUpdate[] = [];
    const reviews = preferences.refine !== false ? await refineMosaicBatch(images.filter(image => !savedRow(image)?.manualBoxes), {
      root,settings:{...preferences,refineScope:preferences.refineIncludeMissed?"all":"suspected"},signal,modelFile,read:readMosaicSource,prepare:prepareMosaicSources,
      timingScope: scope,
      prepareRequest: (model, lanes) => prepareMosaicReviewModel(settings, model, lanes, signal, (detail, level) => logAction(detail, level, "图片去码")),
      request:(model,prompt,image,signal,lanes)=>requestGameModelJson(settings,model,prompt,signal,image,"game-images",undefined,{role:"mosaic",selection:selections(lanes)}),
      onResult: image => {
        if (savedRow(image)?.refineError || savedRow(image)?.reason)
          reviewUpdates.push({ image, change: { refineError: undefined, reason: undefined } });
      },
      onError: (image, error) => {
        failed++;
        reviewUpdates.push({ image, change: { refineError: error } });
      },
      onProgress:(completed,detail)=>report({completed,total:images.length,detail})
    }).finally(() => persistMosaicErrorUpdates(root, reviewUpdates)) : undefined;
    if (reviews?.failed) {
      reportGameStepItems(scope, "mosaic", reviews.results.size + failed, failed);
      throw new Error(reviews.failed + " 张图片复筛失败");
    }
    let detector: Awaited<ReturnType<typeof openDeploymentDetector>> | undefined;
    const savedDrafts = new Set<string>();
    const redrawStyle = automaticMosaicRedrawStyle(usable, rows, (image, signal) => readSavedMosaicImage(image, signal, current.folder), signal);
    const resolveTargets = createMosaicTargetResolver(root, mosaicRegionTargeting(preferences), rows, () => settings);
    try {
      for (const [index, image] of images.entries()) {
        signal.throwIfAborted();
        report({ completed: index, total: images.length, detail: image.name || image.id });
        reportGameStepItems(scope, "mosaic", index);
        const row = savedRow(image);
        const readSource = () => measureGameAsync(scope, "processingMs", () => readUnitySourceImage(current, image, signal));
        let source: Blob | undefined;
        const cached = savedMosaicScan(row, detectorKey);
        let detected = reviews?.results.get(image.id) ?? cached;
        if (detected && detected === cached) recordGameCacheHit(scope);
        if (!detected) {
          try {
            detector ??= await openDeploymentDetector(root, preferences, signal, scope);
            source = await readSource();
            const imageSource = source;
            detected = await measureGameAsync(scope, "processingMs", () => detector!.scan(imageSource));
          } catch (error) {
            if (!signal.aborted) persistMosaicErrorUpdates(root, [{ image, change: { scanned: false, reason: error instanceof Error ? error.message : String(error) } }]);
            throw error;
          }
          if (row?.reason || row?.refineError) persistMosaicErrorUpdates(root, [{ image, change: { reason: undefined, refineError: undefined } }]);
        }
        if (detected.review && !row?.manualChecked) throw new Error(image.name + " · " + detected.review);
        const { boxes } = detected;
        signal.throwIfAborted();
        if (!boxes.length) continue;
        const keep: MosaicBox[] = image.regions.filter(region => preferences.protect && region.selected && region.text).map(region => [region.x0, region.y0, region.x1, region.y1]);
        try {
          const style = await redrawStyle(image);
          const original = source ?? await readSource();
          if (resolveTargets) report({ completed: index, total: images.length, detail: "识别蒙版部位 · " + image.name });
          const targetParts = await resolveTargets?.(image, original, boxes, signal);
          const rendered = await redrawMosaic({ source: original, boxes, keep, model: preferences.model,
            steps: preferences.steps, ...style, signal, timingScope: scope, targetParts,
            progress: detail => report({ completed: index, total: images.length, detail }) });
          const imageData = await imageBase64(rendered);
          const saved = await measureGameAsync(scope, "saveMs", () => unityRun<{ candidates: MosaicCandidateIndex }>("mosaic-save", {
            ...request, imageId: image.id, imageSourceHash: image.sourceHash, imageData,
          }, undefined, signal));
          candidates = saved.candidates;
        } catch (error) {
          if (!signal.aborted) persistMosaicErrorUpdates(root, [{ image, change: { redrawError: error instanceof Error ? error.message : String(error) } }]);
          throw error;
        }
        if (row?.redrawError) persistMosaicErrorUpdates(root, [{ image, change: { redrawError: undefined } }]);
        savedDrafts.add(image.id);
        ids.add(image.id);
      }
      signal.throwIfAborted();
      if (ids.size) {
        const result = await measureGameAsync(scope, "saveMs", () => unityRun<{ candidates: MosaicCandidateIndex }>(
          "mosaic-select", { ...request, selectedIds: [...ids], includeMosaic: true }, undefined, signal));
        candidates = result.candidates;
      }
      reportGameStepItems(scope, "mosaic", images.length, 0);
      setMosaicCompleted(current.folder);
    } finally {
      setMosaicStatus({ root, candidates, savedDrafts });
      await detector?.release();
    }
  }

  function runDeployment(action: "automatic" | "export" | DeploymentPhase) {
    if (isBenchmarkRunning() || !root || locked || deploymentController.current || running.current || mosaicBusy ||
        action !== "automatic" && action !== "export" && deploymentPlan.disabled.includes(action)) return;
    const automatic = action === "automatic";
    if (hasMosaicDrafts(root) && (automatic || action === "mosaic" || action === "export")) {
      showAppNotice("请先点击右上角保存去码修改");
      return;
    }
    if (automatic && deploymentValidation.issues.length) {
      setActionError(deploymentValidation.issues.join("。"));
      return;
    }
    const controller = new AbortController();
    const signal = controller.signal;
    deploymentController.current = controller;
    const mode = automatic ? "automatic" : "single";
    const sequence: DeploymentStep[] = automatic ? deploymentSequence(deploymentPlan) : action === "export" ? ["apply"] : [action, "apply"];
    const total = sequence.length;
    const excluded = automatic || action === "export" ? disabledPhases : deploymentPhases.filter(phase => phase !== action);
    const completed = new Set(automatic ? deploymentCompleted.filter(phase => phase !== currentStoppedStep) : []);
    const shouldRun = (step: DeploymentStep) => !completed.has(step) || step === "apply" && !activePatch;
    const first = sequence.find(shouldRun);
    const committedBefore = checkpointRef.current;
    setDeploymentStop(undefined);
    setDeploymentRun({ mode, steps: first ? [first] : [], completed: 0, total, stopping: false });
    void operation(automatic ? "一键执行" : "生成补丁", async () => {
      await save();
      let finished = 0;
      for (const step of sequence) {
        if (!shouldRun(step)) { finished++; continue; }
        if (signal.aborted) { setDeploymentStop({ root, step }); break; }
        const label = deploymentLabel[step];
        setDeploymentRun({ mode, steps: [step], completed: finished, total, stopping: false });
        setBusy(label);
        const former = latest.current;
        const part = step === "text" ? "text" : step === "image" ? "images" : undefined;
        const parts: UnityTranslationPart[] = part ? [part] : [];
        const baseline = parts.length && former ? structuredClone(former) : former;
        const finishedParts = new Set<UnityTranslationPart>();
        const formerTask = checkpointRef.current;
        const formerPatch = formerTask?.patch ?? patch;
        let outputPath = "";
        let mosaicDone = false;
        const batch = crypto.randomUUID().replaceAll("-", "");
        const engineStep = step === "scan" ? 1 : step === "apply" ? 3 : 2;
        const report = (value: UnityProgress) => {
          if (value.folder) outputPath = value.folder;
          setGeneration({ ...value, step: engineStep, state: "running" });
        };
        try {
          report({ detail: label, completed: 0, total: null });
          if (step === "scan") {
            const previous = former && { ...projectCheckpoint(former), previousProjectFolder: former.folder };
            const scanned = await scan(report, signal, previous || undefined, batch);
            outputPath = scanned.folder;
            signal.throwIfAborted();
            if (former) {
              const reused = await unityRun<{ project: UnityProject }>("finish-rescan", { root, path: former.folder, task: projectCheckpoint(scanned) });
              publish(reused.project);
            }
            remember(projectCheckpoint(latest.current || scanned));
          } else {
            const current = latest.current;
            if (!current) throw new Error("请先扫描当前游戏资源");
            if (step === "apply") {
              const generated = await exportPatch(current, report, signal, undefined, excluded, batch);
              outputPath = generated.folder;
              if (automatic) {
                signal.throwIfAborted();
                await applyPatch(generated, report, signal, true);
              }
              const base = checkpointRef.current ?? projectCheckpoint(current);
              remember({ ...base, step: automatic ? 4 : 3, endStep: automatic ? 4 : 3, finished: true, automatic: false,
                patch: generated, patchFolder: generated.folder, progress: { step: automatic ? 4 : 3, state: "done",
                  detail: automatic ? "已应用到游戏" : "补丁已生成", completed: generated.files, total: generated.files } });
            } else {
              if (part) {
                await runWorkflow(2, 2, false, false, false, part, false, part === "images", { parts, finishedParts, controller });
                if (part === "images") {
                  const saved = latest.current || current;
                  if (!unityTranslationReadiness(saved, [], unityTranslationError, false, target, picture.target).imagesReady)
                    throw new Error("图片翻译还有待确认项，请在图片翻译页处理后继续");
                  const cache = await unityRun<{ errors: string[] }>("save-image", { project: saved, cleanImageCache: true });
                  if (cache.errors?.length) setActionError("部分译图缓存未能清理：" + cache.errors.join("；"));
                }
              } else {
                await runDeploymentMosaic(current, signal, report);
                mosaicDone = true;
              }
              invalidatePatch(); setApplied(false);
            }
          }
          if (outputPath && (step === "scan" || step === "apply")) {
            await taskWrites.current;
            await unityRun("finish-deployment-output", { root, path: outputPath, step: engineStep, deploymentBatch: batch });
          }
          if (step !== "apply") completed.delete("apply");
          completed.add(step);
          finished++;
        } catch (error) {
          const stopped = error instanceof UnityPaused || error instanceof UnityTranslationStopped ||
            signal.aborted && error instanceof DOMException && error.name === "AbortError";
          if (stopped) {
            await projectWrites.current;
            await taskWrites.current;
            const undone = parts.filter(part => !finishedParts.has(part));
            if (undone.length && baseline) {
              const current = latest.current || baseline;
              const restored = { ...current,
                entries: undone.includes("text") ? baseline.entries : current.entries,
                images: undone.includes("images") ? baseline.images : current.images };
              const result = await unityRun<{ cacheErrors?: string[] }>("save", { project: restored, cleanImageCache: parts.includes("images") });
              if (result.cacheErrors?.length) throw new Error("未完成译图清理失败：" + result.cacheErrors.join("；"));
              publish(restored);
              if (undone.includes("text")) setTextScreened(false);
            }
            const folder = outputPath || (error instanceof UnityPaused ? error.folder : "");
            if ((step === "scan" || step === "apply") && folder && folder !== formerPatch?.folder) {
              await unityRun("discard-deployment-output", { root, path: folder, step: engineStep, deploymentBatch: batch });
            }
            if (step === "scan") { latest.current = baseline; setProject(baseline); }
            if (step === "apply") { setPatch(formerPatch); setApplied(applied); }
            const retained = finishedParts.size || mosaicDone;
            if (retained) { invalidatePatch(); setApplied(false); }
            const restored = formerTask || committedBefore;
            if (restored) remember(retained ? { ...restored, patch: null, patchFolder: "" } : restored);
            else { checkpointRef.current = null; setCheckpoint(null); }
            setGeneration(null);
            setDeploymentStop({ root, step });
            setMessage("已停止，未完成阶段的产物已丢弃");
            break;
          }
          if (signal.aborted) throw new Error("停止时未能安全完成清理：" + String(error));
          if (engineStep === 2) {
            invalidatePatch(); setApplied(false);
            const failed = checkpointRef.current;
            if (parts.length && failed) remember({ ...failed, finished: true, progress: { ...failed.progress, state: "error", detail: String(error) } });
          }
          throw error;
        }
      }
    }, true, setActionError).finally(() => {
      deploymentController.current = null;
      setDeploymentRun(null);
    });
  }

  function stopDeployment() {
    const current = deploymentController.current;
    if (!current) { stop(); return; }
    setDeploymentRun(run => run && { ...run, stopping: true });
    current.abort();
  }


  const deployment: { model: DeploymentModel; actions: DeploymentActions } = {
    model: {
      root,
      busyLabel: busy,
      metrics: deploymentMetrics(root),
      cardActivity,
      plan: deploymentPlan, run: deploymentRun, stoppedStep: currentStoppedStep,
      completed: deploymentCompleted, canStop: !!deploymentController.current || !!abort.current,
      textCount,
      locked: locked || !!deploymentRun,
      patchReady: scopedPatchReady,
      patch: currentStoppedStep === "apply" ? null : activePatch,
      applied: currentStoppedStep !== "apply" && !!activePatch && applied,
      installed,
      fontPath,
      fontName: fontPath && fontPath !== ":original:" ? fontPath.split(/[\\/]/).pop() || fontPath : "",
      extraCharacters,
      fontPlan,
      entries: project?.entries || [],
      images: { total: project?.images?.length || 0, ready: patchImages.length },
      mosaic: { enabled: !!root, count: mosaicCount },
      progress: mapOfflineDeploymentProgress(generation, deploymentRun?.steps.map(step => deploymentLabel[step]).join("、")),
    },
    actions: {
      execute: () => runDeployment("automatic"),
      savePlan: changeDeploymentPlan,
      generatePhase: runDeployment,
      chooseFont: () => void chooseFont(),
      clearFont: () => { setFontPath(""); setFontPlan(null); invalidatePatch(); },
      setExtraCharacters: value => { setExtraCharacters(value); setFontPlan(null); },
      checkFontPlan: () => void checkFontPlan(),
      stop: stopDeployment,
      generate: () => runDeployment("export"),
      openPatchFolder: () => { if (patch) void openFolder(patch.folder); },
      regenerate: () => runDeployment("export"),
      apply: () => { if (activePatch) void startWorkflow(4, 4); },
      uninstall: () => void uninstallPatch(),
      removeLayer: phase => void removeLayer(phase, {
        project, patch, locked, ask: confirmation.ask, operation, uninstall: uninstallPatch,
        exportReplacement: (project, excluded) => exportPatch(project, undefined, undefined, undefined, excluded),
        rememberReplacement: (project, replacement) => remember({ ...(checkpointRef.current || projectCheckpoint(project)), step: 4, endStep: 4, finished: true,
          patch: replacement, patchFolder: replacement.folder }),
      }),
      reapply: () => { if (activePatch) void restartStage(4); },
      launch: () => void launchGame(),
      openReport: () => { if (fontPlan) void openTranslationFile(fontPlan.folder + "/字库检查.txt"); },
      openGlyphFolder: () => { if (fontPlan) void openFolder(fontPlan.folder); },
      locateText: character => { setActiveStep(2); setImagePart(false); setReviewFilter("all"); setSearch(character); setPage(0); followProgress.current = false; },
    },
  };
  const deploymentPage = activeStep === 3;
  const trackEdges = deploymentPage ? deploymentValidation.effectiveEdges.map(({ from, to }) => ({ from: deploymentStageId[from], to: deploymentStageId[to] })) : undefined;
  const trackEnabled = deploymentPage ? deploymentValidation.enabledSteps.map(id => deploymentStageId[id]) : undefined;
  const trackSkipped = deploymentPage ? deploymentPlan.disabled.map(id => deploymentStageId[id]) : undefined;
  const trackSteps: WorkflowTrack["steps"] = UNITY_STAGE_TABS.map(tab=>{
        const { step, id, label } = tab;
        const canvasRunning = deploymentRun?.steps.some(stage => deploymentStageId[stage] === id);
        if (id === "2.3") {
          const running = canvasRunning ?? mosaicBusy;
          return { id, label, state: running ? "current" : mosaicReady ? "complete" : scanReady ? "current" : "pending",
            selected: mosaicPage, running, onSelect: () => selectWorkflowStage(tab) };
        }
        if (step === 3) {
          const deployment = generation && generation.step >= 3 ? generation : undefined;
          const running = canvasRunning ?? deployment?.state === "running";
          const state = running ? "current" : deployment?.state === "error" ? "error" : deploymentComplete ? "complete" :
            patch || patchReady || deployment?.state === "stopped" ? "current" : "pending";
          return {id,label,state,selected:activeStep===3,running,paused:deployment?.state==="stopped",onSelect:()=>selectWorkflowStage(tab)};
        }
        const subReady = tab.imageOnly ? imagesReady : textReady;
        const partProgress = step === 2 && !preparingRescan ? currentParts?.[tab.imageOnly ? "images" : "text"] : undefined;
        const runningHere = canvasRunning ?? (partProgress ? partProgress.state === "running" :
          generation?.step === step && generation.state === "running" && (step !== 2 || !!checkpoint?.imageOnly === tab.imageOnly));
        const baseState = step === 2 ? (partProgress ? partProgress.state === "error" : generation?.step === 2 && generation.state === "error" && !!checkpoint?.imageOnly === tab.imageOnly) ? "error" : subReady ? "complete" : runningHere||scanReady ? "current" : "pending" : unityStageState(step, displayedCompletedThrough, executingStep, generation?.state === "error" ? generation.step : undefined, !preparingRescan && needsScan ? 1 : undefined, !preparingRescan && scanUpdate.level === "optional" ? 1 : undefined);
        const state = runningHere || id === "2.1" && textScreening || step === 1 && baseState === "pending" ? "current" : baseState;
        const selectedTab = !mosaicPage && activeStep === step && (step !== 2 || imagePart === tab.imageOnly);
        const title = state === "outdated" || state === "optional-update" ? `${label} · ${scanUpdate.label}` : undefined;
        return {id,label,title,state,selected:selectedTab,running:runningHere || id === "2.1" && textScreening,paused:step===2?!subReady&&partProgress?.state==="stopped":state!=="complete"&&generation?.step===step&&generation.state==="stopped",onSelect:()=>selectWorkflowStage(tab)};
  });
  const scanConfiguration = !mosaicPage && activeStep === 1 ? (
          <div className="unity-scan-settings-body">
          <div className="unity-offline-fields unity-scan-fields">
            <div className="unity-language-setting"><div className="unity-language-heading"><span>原文语言</span><label className="unity-inline-check" data-tooltip="仅翻译含原语言的内容；自动时使用检测到的主语言。"><input type="checkbox" checked={onlySourceLanguage} disabled={!!busy || restoring} onChange={event => { setOnlySourceLanguage(event.target.checked); setPage(0); }} />仅翻译原语言</label></div><select value={source} aria-label="原文语言" disabled={scanParametersLocked} onChange={e => { setSource(e.target.value); setPage(0); }}><option value="auto">自动（主语言）</option>{sourceLanguages.map(language => <option key={language} value={language}>{unityLanguageLabel(language)}</option>)}<option value="all">全部语言</option></select></div>
            <label>文本分段<UnityDescriptionSelect label="文本分段" value={textMode} choices={UNITY_SEGMENT_CHOICES} disabled={parametersLocked} onChange={value => setTextMode(value as "lines" | "paragraphs" | "smart")} /></label>
            <label className="unity-offline-check unity-scan-code-option" data-tooltip="扫描游戏代码中的硬编码文本，补充资源中未提取到的对白或界面文字。结果可能包含程序标识，请在扫描后取消不应翻译的条目；错误修改可能使游戏无法运行。"><input type="checkbox" disabled={parametersLocked} checked={includeCode} onChange={e => setIncludeCode(e.target.checked)} />扫描代码字面量</label>

          </div>
          <div className="unity-scan-types"><label><span>类型定义</span><input value={typeDirectory} readOnly placeholder="自动读取游戏 Managed" data-tooltip={typeDirectory || "IL2CPP 可选择匹配的 DummyDll 目录，仅用于读取字段定义"} /></label><div className="unity-type-actions"><button className="unity-btn" disabled={parametersLocked} onClick={() => void operation("选择类型定义", async () => { const path = await open({ directory: true }); if (typeof path === "string") setTypeDirectory(path); })}>选择目录</button>
            {inspection?.runtime === "IL2CPP" && <button className="unity-btn" disabled={parametersLocked} data-tooltip="使用 Il2CppDumper 读取当前游戏并生成 DummyDll" onClick={() => void operation("生成类型定义", async () => {
              const result = await unityRun<{ directory: string; count: number }>("generate-il2cpp-types", { root }, progress => setMessage(progress.detail));
              setTypeDirectory(result.directory);
              setMessage(`已生成 ${result.count} 个类型定义，可用于扫描缺少类型树的对象。`);
            })}>生成类型定义</button>}
            {typeDirectory && <button className="unity-btn" disabled={parametersLocked} onClick={() => setTypeDirectory("")}>自动</button>}</div></div>
          {includeCode && <details className="unity-assembly-options"><summary>代码范围 · {codeAssemblies?.length ?? inspection?.assemblies?.filter(assembly => assembly.writable).length ?? 0} 个程序集</summary>{(inspection?.assemblies || []).map(assembly => <label key={assembly.path}><input type="checkbox" disabled={parametersLocked || !assembly.writable} checked={assembly.writable && (codeAssemblies?.includes(assembly.path) ?? true)} onChange={event => setCodeAssemblies(current => { const selected = current ?? inspection!.assemblies.filter(item => item.writable).map(item => item.path); return event.target.checked ? [...selected, assembly.path].sort() : selected.filter(path => path !== assembly.path); })} /><span>{assembly.path}{assembly.reason ? ` · ${assembly.reason}` : ""}</span></label>)}{!inspection?.assemblies?.length && <p className="hint">未找到可选的游戏 Managed 程序集；标准 global-metadata.dat 字面量仍按代码扫描选项处理。</p>}</details>}
          {inspectionError && <p className="unity-offline-error">程序集预检失败：{inspectionError}</p>}
          {!!inspection?.catalogs?.length && <p className="hint">检测到 {inspection.catalogs.length} 个 Addressables Catalog；修改相关 Bundle 后需验证 CRC、依赖和缓存，当前不会自动改写 Catalog。</p>}


          {pausedScan && !preparingRescan && scanOptionsChanged && <p className="hint">扫描参数已变化，继续时需从头重新扫描；确认后保留可匹配复用的旧结果。</p>}
          </div>
  ) : undefined;
  const translationFlow: TranslationCardFlow | undefined = !mosaicPage && activeStep === 2 ? {
    runningParameters: [
          { scope: "config", label: "原文语言", value: source === "auto" ? "自动检测" : unityLanguageLabel(source) },
          { scope: "config", label: "目标语言", value: unityLanguageLabel(target) },
          { scope: "config", label: "跳过目标语言", value: skipTargetLanguage ? "开启" : "关闭" },
          ...(!imagePart ? [{ scope: "config" as const, label: "附带上下文", value: includeContext ? "开启" : "关闭" }] : []),
        ],
    configurationCommit: imagePart ? imageConfigurationCommit : textConfigurationCommit, configurationRevision, testConfigurations, testConfigurationDisabled,
    configurationActions: !imagePart && flowConfig === "translate" && joinLines && wrapMode !== "natural" &&
      <button className="unity-btn" disabled={!!busy || restoring || !scanReady || !selected.some(entry => !!entry.translation)} data-tooltip="保留译文，仅重新处理换行" aria-label="保留译文，仅重新处理换行" onClick={() => void reflowExisting()}>仅重新断行</button>,
    onSaveConfiguration: saveConfiguration, configurationScope: project && !restoring ? root : null, configuration, restoreConfiguration,
    activity: { ...((!generation || generation.step === 2 && progressIsImage === imagePart) ? cardActivity : {}),
      step: runningFlowStep, state: flowProgressState },
    configured: flowConfig, onConfigure: setFlowConfig,
    onRun: imagePart && !testConfigurationDisabled && !project?.imagesSkipped && !imagesReady ? () => void startWorkflow(2, 2, false, false, false, "images", true) : undefined,
    steps: imagePart ? [
            { id: "filter", title: "筛选图片", models: [{role:"screen",id:imageScreeningOptions.filterModel}],
              summary: imageScreeningOptions.filterModel !== undefined ? "大模型筛选" : imageScreeningOptions.strategy === "full" ? "完整范围筛选" : "分级快速筛选",
              state: imagesNeedScreen ? "current" : "done",
              run: imagesNeedScreen ? () => startTranslationPart("images", "filter") : undefined,
              stop: partRunning && imageTask.current === "filter" ? () => stopPart("images") : undefined,
              stopDisabled: partStopping,
              runDisabled: restoring || saving || !scanReady || !!busy,
              clear: canClearImageStep && imageScreeningAttempted ? () => void restartStage(2, true, "filter") : undefined },
            { id: "refine", title: "复筛图片", models: [{role:"refine",id:imageRefineModel}],
              summary: imageRefine.method === "local" ? LOCAL_REFINE_MODELS.find(item => item.id === imageRefine.mode)?.title
                : imageRefine.method === "off" ? "未启用" : "复读疑似文字区域",
              stateLabel: imageRefine.method === "off" ? "已关闭" : undefined,
              state: imagesNeedScreen ? "waiting" : imagesNeedRefine ? "current" : "done",
              run: !imagesNeedScreen && imagesNeedRefine ? () => startTranslationPart("images", "refine") : undefined,
              stop: partRunning && imageTask.current === "refine" ? () => stopPart("images") : undefined,
              stopDisabled: partStopping,
              runDisabled: restoring || saving || !scanReady || !!busy,
              clear: canClearImageStep && imageRefineAttempted ? () => void restartStage(2, true, "refine") : undefined },
            { id: "recognize", title: "识字与定位", models: [{role:"recognize",id:imageVisionModel}], summary: imageVisionModel!==undefined?"大模型识别":OCR_MODE_OPTIONS.find(item => item.id === imageOcrMode)?.title,
              state: imagesNeedScreen || imagesNeedRefine ? "waiting" : imagesNeedRecognition ? "current" : "done",
              run: !imagesNeedScreen && !imagesNeedRefine && imagesNeedRecognition ? () => startTranslationPart("images", "recognize") : undefined,
              stop: partRunning && imageTask.current === "recognize" ? () => stopPart("images") : undefined,
              stopDisabled: partStopping,
              runLabel: imagePartPaused ? "继续" : "开始", runDisabled: partActionDisabled, clear: canClearImageStep && imageRecognitionAttempted ? () => void restartStage(2, true) : undefined },
            { id: "translate", title: "翻译图片文字", groupedParameters: true, models: [{role:"image",id:translationKind === "engine" ? undefined : imageModel}], summary: picture.kind === "engine" ? "翻译引擎" : imageModel.split("/").pop(),
              state: !recognitionReady ? "waiting" : imageTextDone || imageReviewReady ? "done" : "current",
              run: recognitionReady && !imageTextDone && !imageReviewReady ? () => startTranslationPart("images", "translate") : undefined,
              stop: partRunning && imageTask.current === "translate" ? () => stopPart("images") : undefined,
              stopDisabled: partStopping,
              runDisabled: partActionDisabled, clear: canClearImageStep && imageTranslationAttempted ? () => void restartStage(2, true, "translate") : undefined },
            { id: "review", title: "复核与重译", models: [{role:"review",id:imageReviewModel}],
              summary: imageReviewModel.split("/").pop() || "未配置复核模型", state: imageTextDone ? "done" : imageReviewReady ? "current" : "waiting",
              run: imageReviewReady ? () => startTranslationPart("images", "review") : undefined,
              stop: partRunning && imageTask.current === "review" ? () => stopPart("images") : undefined,
              stopDisabled: partStopping,
              runDisabled: restoring || saving || !scanReady || !!busy,
              clear: canClearImageStep && imageReviewAttempted ? () => void restartStage(2, true, "review") : undefined },
            { id: "render", title: "生成译图", models: [{role:"layout",id:imageLayoutModel}],
              summary: imageLayoutModel !== undefined ? "大模型断行排版" : "保留底图排版",
              state: !imageTextDone ? "waiting" : imageRenderReady ? "done" : "current",
              run: imageTextDone && !imageRenderReady ? () => startTranslationPart("images", "render") : undefined,
              stop: partRunning && imageTask.current === "render" ? () => stopPart("images") : undefined,
              stopDisabled: partStopping,
              runDisabled: restoring || saving || !scanReady || !!busy,
              clear: canClearImageStep && imageRenderAttempted ? () => void restartStage(2, true, "render") : undefined },
            { id: "redraw", title: "AI 风格重绘", summary: styleRedrawLabels[imageRedrawProfile],
              state: !imageRenderReady ? "waiting" : imageRedrawCount && !project?.imagesSkipped ? "current" : "done",
              stateLabel: project?.imagesSkipped ? "已跳过" : imageRenderReady && !imageRedrawCount && !stepPerformance(promptState.scope + ":images", "redraw")?.elapsedMs ? "未勾选图片" : undefined,
              run: imageRenderReady && imageRedrawCount && !project?.imagesSkipped ? () => startTranslationPart("images", "redraw") : undefined,
              stop: partRunning && imageTask.current === "redraw" ? () => stopPart("images") : undefined,
              stopDisabled: partStopping, runDisabled: restoring || saving || !scanReady || !!busy },
          ] : [
            { id: "screen", title: "筛选文本", groupedParameters: true, models: [{role:"textScreen",id:textScreenModel}], summary: textScreenModel !== undefined ? "大模型判断是否需要翻译" : "按语言规则筛选", state: screenComplete ? "done" : "current", run: !screenComplete && selected.length ? () => void screenCurrentText() : undefined,
              stop: textScreening ? () => abort.current?.abort() : undefined, runLabel: textScreenPaused ? "继续" : "开始",
              stopDisabled: !!abort.current?.signal.aborted,
              runDisabled: restoring || saving || !scanReady || !!busy && !textScreening, clear: !busy && (textScreenStarted || screenComplete) ? () => void clearTextScreening() : undefined },
            { id: "translate", title: "翻译正文", groupedParameters: true, hideConfigurationShortcut: true,
              models: translationKind === "engine" ? [] : [{role:"names",id:nameModel || llmModel},{role:"text",id:llmModel},{role:"dialogue",id:dialogueModel || llmModel},{role:"line",id:lineMode === "model" ? lineModel : undefined}], summary: translationKind === "engine" ? "翻译引擎" : llmModel.split("/").pop(), state: textReady ? "done" : screenComplete ? "current" : "waiting", run: screenComplete && !textReady ? () => startTranslationPart("text") : undefined,
              stop: partRunning ? () => stopPart("text") : undefined,
              stopDisabled: partStopping,
              runLabel: textPartPaused ? "继续" : "开始", runDisabled: partActionDisabled, clear: !busy && textCleanupAvailable ? () => void restartStage(2, true) : undefined },
          ],
  } : undefined;
  const imageRecognitionMethod = {
    label: "识别方式", localLabel: "本地 OCR", disabled: flowConfigLocked,
    value: imageVisionModel !== undefined ? "llm" as const : "local" as const,
    onChange: (value: "local" | "llm") => setImageVisionModel(value === "llm" ? "" : undefined),
  };
  const imageRecognitionModel = imageVisionModel !== undefined && <GameModelSelect label="视觉模型（需支持图片输入）" promptKey="recognize"
    models={gameModels} value={imageVisionModel} disabled={flowConfigLocked} onChange={setImageVisionModel} />;
  const imageOcrModeField = <label>{flowConfig === "translate" ? "识别模式" : "图片识别"}<select value={imageOcrMode} disabled={flowConfigLocked} onChange={event => setImageOcrMode(event.target.value as OcrMode)}>
      {OCR_MODE_OPTIONS.map(mode => <option key={mode.id} value={mode.id}>{mode.title}</option>)}
    </select></label>;
  const imageRecognitionRuntime = imageVisionModel === undefined && <>
    {imageOcrModeField}
    <label>识别并发<select aria-label="Unity 图片识别并发" value={imageConcurrency} disabled={flowConfigLocked}
      onChange={event => setImageConcurrency(Number(event.currentTarget.value))}>
      {[1, 2, 3, 4, 6, 8].map(value => <option key={value}>{value}</option>)}
    </select></label>
    <label data-tooltip="低于阈值的区域默认不自动翻译，可在图片结果中手动勾选后处理。">翻译置信度阈值（%）
      <input aria-label="图片翻译置信度阈值" type="number" min={0} max={100} step={1}
        value={imageConfidenceThreshold} disabled={flowConfigLocked}
        onBlur={event => { event.currentTarget.value = String(imageConfidenceThreshold); }}
        onChange={event => {
          const value = Number(event.currentTarget.value);
          const next = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
          event.currentTarget.value = String(next);
          if (next !== imageConfidenceThreshold) setImageConfidenceThreshold(next);
        }} />
    </label>
  </>;
  const imageRecognitionBehavior = imageVisionModel !== undefined && <label className="unity-inline-check">
    <input type="checkbox" role={flowConfig === "translate" ? "switch" : undefined} checked={imageOcrMode === "manga"} disabled={flowConfigLocked}
      onChange={event => setImageOcrMode(event.target.checked ? "manga" : "precise")} />用 Manga OCR 复读日文竖排
  </label>;
  const imageRecognitionHelp = imageVisionModel === undefined && <p className="hint">可用底图优先按原像素恢复</p>;
  const imageLayoutMethod = {
    label: "译图排版", localLabel: "保留底图排版", disabled: flowConfigLocked,
    value: imageLayoutModel !== undefined ? "llm" as const : "local" as const,
    onChange: (value: "local" | "llm") => setImageLayoutModel(value === "llm" ? "" : undefined),
  };
  const imageLayoutModelField = imageLayoutModel !== undefined && <GameModelSelect label="断行排版模型" promptKey="layout"
    models={gameModels} value={imageLayoutModel} disabled={flowConfigLocked} onChange={setImageLayoutModel} />;
  const flowTranslationKind = imagePart ? picture.kind : translationKind;
  const targetLanguageField = <label>目标语言<select aria-label="目标语言" value={imagePart ? picture.target : target} disabled={flowConfigLocked}
    onChange={event => {
      if (imagePart) changePicture({ target: event.currentTarget.value });
      else setTarget(event.currentTarget.value);
      invalidatePatch();
    }}>
    {UNITY_LANGUAGES.map(language => <option key={language.value} value={language.value}>{language.label}</option>)}
  </select></label>;
  const skipTargetSwitch = <label data-tooltip="仅跳过能明确判断已符合目标语言的条目，原样保留；共用汉字短词仍翻译。关闭后重做可强制翻译。">
    <input type="checkbox" role="switch" checked={imagePart ? picture.skipTargetLanguage : skipTargetLanguage} disabled={sharedLanguageLocked}
      onChange={event => imagePart ? changePicture({ skipTargetLanguage: event.currentTarget.checked }) : setSkipTargetLanguage(event.currentTarget.checked)} />跳过目标语言
  </label>;
  const textSourceLanguageField = <label>原文语言<select aria-label="原文语言" value={source} disabled={sharedLanguageLocked}
                onChange={event => { setSource(event.target.value); setPage(0); }}>
                <option value="auto">自动（主语言）</option>
                {sourceLanguages.map(language => <option key={language} value={language}>{unityLanguageLabel(language)}</option>)}
                <option value="all">全部语言</option>
              </select></label>;
  const textTranslationMethod = <GameTranslationMethod segmented={!imagePart} kind={flowTranslationKind} disabled={flowConfigLocked} onChange={kind => {
                if (imagePart) { changePicture({ kind }); return; }
                setTranslationKind(kind);
                if (kind === "engine" && wrapMode === "natural") { setWrapMode("join"); setJoinLines(true); }
              }} />;
  const translationEngineList = <UnityEngineList choices={imagePart ? picture.engines : engineChoices} keys={parseEngineKeys(settings.translateEngineKeys)}
                  disabled={flowConfigLocked} expanded={engineListExpanded} onExpandedChange={setEngineListExpanded}
                  onChange={imagePart ? engines => changePicture({ engines }) : updateEngineChoices} />;
  const translationContextSwitch = <label data-tooltip={GAME_CONTEXT_HINT}>
                  <input type="checkbox" role="switch" checked={includeContext} disabled={flowConfigLocked}
                    onChange={event => setIncludeContext(event.currentTarget.checked)} />附带上下文
                </label>;
  const translationConfigurationHelp = <>{!connectionReady && <p className="unity-offline-error unity-group-note">{translationKind === "local" ? "请在通用设置添加本地模型，再选择翻译模型。" : translationKind === "llm" ? "所选模型尚未配置 API 地址，请前往通用设置配置。" : "请在列表中启用至少一个免 Key 或已配置凭证的引擎。"}</p>}</>;
  const translationConfiguration = !mosaicPage && activeStep === 2 ? (
    <div className="unity-translation-settings game-flow-parameter-layout">
          {!imagePart && flowConfig === "screen" && <GameTextParameters step="screen"
            method={<GameProcessingMethod segmented label="筛选方式" localLabel="本地筛选" value={textScreenModel === undefined ? "local" : "llm"}
                disabled={flowConfigLocked} onChange={method => setTextScreenModel(method === "llm" ? "" : undefined)} />}
            languages={<>{textSourceLanguageField}{targetLanguageField}</>}
            models={textScreenModel !== undefined && <GameModelSelect label="文本筛选模型" promptKey="textScreen" models={gameModels} value={textScreenModel}
                disabled={flowConfigLocked} onChange={setTextScreenModel} />}
            switches={<><label data-tooltip="仅翻译含原语言的内容；自动时使用检测到的主语言。">
                  <input type="checkbox" role="switch" checked={onlySourceLanguage} disabled={sharedLanguageLocked}
                    onChange={event => { setOnlySourceLanguage(event.target.checked); setPage(0); }} />仅翻译原语言
                </label>{skipTargetSwitch}</>} />}
          {!imagePart && flowConfig === "translate" && <GameTextParameters step="translate"
            method={textTranslationMethod}
            languages={<>{textSourceLanguageField}{targetLanguageField}</>}
            modelTitle={flowTranslationKind === "engine" ? "翻译引擎" : "每类模型"}
            models={<>
              {flowTranslationKind === "engine" ? translationEngineList : <>
                <GameModelSelect compactLabel="常规文本" label="常规文本模型" promptKey="text" models={gameModels} value={llmModel} disabled={flowConfigLocked} onChange={setLlmModel} />
                <GameModelSelect optional compactLabel="对白" label="对白模型（可选）" promptKey="dialogue" models={gameModels} value={dialogueModel} disabled={flowConfigLocked} onChange={setDialogueModel} />
                <GameModelSelect optional compactLabel="术语" label="术语模型（可选）" promptKey="names" models={gameModels} value={nameModel} disabled={flowConfigLocked} onChange={setNameModel} />
              </>}
              {joinLines && wrapMode !== "natural" && lineMode === "model" && <GameModelSelect label="断行辅助模型" promptKey="line" value={lineModel || settings.model}
                  models={gameModels} disabled={flowConfigLocked} onChange={value => updateLineOptions(lineMode, value === settings.model ? "" : value)} />}
            </>}
            wrapping={<>
              <label>换行处理<UnityDescriptionSelect label="换行处理" value={wrapMode} choices={translationKind==="engine"?UNITY_WRAP_CHOICES.filter(choice=>choice.value!=="natural"):UNITY_WRAP_CHOICES} disabled={flowConfigLocked} onChange={value => { const enabled = value !== "keep"; setJoinLines(enabled);setWrapMode(value as GameWrapMode); const saved = checkpointRef.current; if (saved && !saved.finished && saved.step === 2 && !saved.layoutOnly) remember({ ...saved, joinLines: enabled,wrapMode:value as GameWrapMode }); }} /></label>
              {joinLines && wrapMode !== "natural" && <label>断行方式<UnityDescriptionSelect label="断行方式" value={lineMode} choices={UNITY_LINE_CHOICES} disabled={flowConfigLocked} onChange={value => updateLineOptions(value as UnityLineMode, lineModel)} /></label>}
            </>}
            switches={<><label data-tooltip="仅翻译含原语言的内容；自动时使用检测到的主语言。">
                  <input type="checkbox" role="switch" checked={onlySourceLanguage} disabled={sharedLanguageLocked}
                    onChange={event => { setOnlySourceLanguage(event.target.checked); setPage(0); }} />仅翻译原语言
                </label>{skipTargetSwitch}{flowTranslationKind !== "engine" && translationContextSwitch}</>}
            help={translationConfigurationHelp} />}
          {imagePart && flowConfig === "translate" && <>
            <GameFlowParameterGroup kind="scope" title="范围与方式">
              {textTranslationMethod}
              <label>原文语言<select aria-label="原文语言" value={picture.source} disabled={flowConfigLocked}
                onChange={event => changePicture({ source: event.currentTarget.value })}>
                <option value="auto">自动检测</option>
                {UNITY_LANGUAGES.map(language => <option key={language.value} value={language.value}>{language.label}</option>)}
                <option value="all">全部语言</option>
              </select></label>
              {targetLanguageField}
              <GameProcessingMethod {...imageRecognitionMethod} />
              {imageVisionModel === undefined && imageOcrModeField}
              <GameProcessingMethod {...imageLayoutMethod} />
            </GameFlowParameterGroup>
            <GameFlowParameterGroup kind="models" title="模型">
              {flowTranslationKind === "engine" ? translationEngineList : <GameModelSelect label="图片文字翻译模型" promptKey="image" models={gameModels} value={imageModel}
                  disabled={flowConfigLocked} onChange={setImageModel} />}
              {imageRecognitionModel}{imageLayoutModelField}
            </GameFlowParameterGroup>
            <GameFlowParameterGroup kind="runtime" title="运行">
              {imagePart && imageVisionModel === undefined && <div className="game-flow-chip-row">
                <GameFlowNumberChip label="识别并发" ariaLabel="Unity 图片识别并发" choices={[1, 2, 3, 4, 6, 8]}
                  value={imageConcurrency} disabled={flowConfigLocked} onChange={setImageConcurrency} />
                <GameFlowNumberChip label="翻译置信度阈值（%）" ariaLabel="图片翻译置信度阈值"
                  hint="低于阈值的区域默认不自动翻译，可在图片结果中手动勾选后处理。"
                  min={0} max={100} value={imageConfidenceThreshold} disabled={flowConfigLocked} onChange={setImageConfidenceThreshold} />
              </div>}
              <div className="game-flow-chip-row">
                <label><input type="checkbox" role="switch" checked={picture.onlySourceLanguage} disabled={sharedLanguageLocked}
                  onChange={event => changePicture({ onlySourceLanguage: event.currentTarget.checked })} />仅翻原语言</label>
                {skipTargetSwitch}
                {flowTranslationKind !== "engine" && translationContextSwitch}
                {imageRecognitionBehavior}
              </div>
              {imageRecognitionHelp}
            </GameFlowParameterGroup>
            <GameFlowParameterGroup kind="help">{translationConfigurationHelp}</GameFlowParameterGroup>
          </>}
          {imagePart && flowConfig === "review" && <div className="unity-offline-fields">
            <GameModelSelect optional label="校验失败重译模型" promptKey="review" models={gameModels} value={imageReviewModel}
              disabled={flowConfigLocked} onChange={setImageReviewModel} />
          </div>}
          {imagePart && flowConfig === "filter" && <GameProcessingTabs label="筛选方式" localLabel="本地筛选"
            disabled={flowConfigLocked} value={imageScreeningOptions.filterModel === undefined ? "local" : "llm"}
            onChange={mode => setImageScreeningOptions(previous => ({ ...previous, filterModel: mode === "llm" ? "" : undefined }))}>
            <div className="unity-offline-fields">
              {imageScreeningOptions.filterModel !== undefined
                ? <GameModelSelect label="筛选视觉模型" promptKey="screen" value={imageScreeningOptions.filterModel} models={gameModels}
                  disabled={flowConfigLocked} onChange={model => setImageScreeningOptions(previous => ({ ...previous, filterModel: model }))} />
                : <><label>筛选策略<select value={imageScreeningOptions.strategy} disabled={flowConfigLocked}
                    onChange={event => setImageScreeningOptions({ ...imageScreeningOptions, strategy: event.currentTarget.value as UnityImageScreeningOptions["strategy"] })}>
                    <option value="staged">分级快速筛选</option><option value="full">完整范围筛选</option></select></label>
                  <label>本地并发<select value={localGameImageScreeningLanes(imageConcurrency)} disabled={flowConfigLocked}
                    onChange={event => setImageConcurrency(Number(event.currentTarget.value))}>{[1,2,3,4].map(value => <option key={value}>{value}</option>)}</select></label></>}
            </div>
          </GameProcessingTabs>}
          {imagePart && flowConfig === "refine" && <div className="unity-offline-fields">
            <label>复筛方式<select value={imageRefine.method} disabled={flowConfigLocked}
              onChange={event => setImageScreeningOptions({ ...imageScreeningOptions, refine: { ...imageRefine, method: event.currentTarget.value as typeof imageRefine.method } })}>
              <option value="off">关闭</option><option value="local">本地筛选</option><option value="llm">大模型</option></select></label>
            {imageRefine.method === "local" && <>
              <label>本地模型<UnityDescriptionSelect label="复筛本地模型" value={imageRefine.mode} disabled={flowConfigLocked}
                choices={LOCAL_REFINE_MODELS.map(({id,title,description}) => ({value:id,label:title,description}))}
                onChange={value => setImageScreeningOptions({ ...imageScreeningOptions, refine: { ...imageRefine, mode: value as typeof imageRefine.mode } })} /></label>
              <label>本地并发<select value={imageRefine.concurrency} disabled={flowConfigLocked}
                onChange={event => setImageScreeningOptions({ ...imageScreeningOptions, refine: { ...imageRefine, concurrency: Number(event.currentTarget.value) } })}>
                {[1,2,3,4].map(value => <option key={value}>{value}</option>)}</select></label>
            </>}
            {imageRefine.method === "llm" && <GameModelSelect label="复筛视觉模型" promptKey="refine" value={imageRefineModel || ""}
              models={gameModels} disabled={flowConfigLocked} onChange={model => setImageScreeningOptions({ ...imageScreeningOptions, refine: { ...imageRefine, model } })} />}
            {imageRefine.method !== "off" && <label>复筛置信度（%）<input type="number" min={0} max={100} value={imageRefine.confidence} disabled={flowConfigLocked}
              onChange={event => setImageScreeningOptions({ ...imageScreeningOptions, refine: { ...imageRefine, confidence: Math.max(0,Math.min(100,Number(event.currentTarget.value))) } })} /></label>}
          </div>}
          {imagePart && flowConfig === "recognize" && <>
            <GameFlowParameterGroup kind="models"><GameProcessingTabs {...imageRecognitionMethod}>{imageRecognitionModel}</GameProcessingTabs></GameFlowParameterGroup>
            <GameFlowParameterGroup kind="runtime">{imageRecognitionRuntime}</GameFlowParameterGroup>
            <GameFlowParameterGroup kind="behavior">{imageRecognitionBehavior}</GameFlowParameterGroup>
            <GameFlowParameterGroup kind="help">{imageRecognitionHelp}</GameFlowParameterGroup>
          </>}
          {imagePart && flowConfig === "render" && <GameFlowParameterGroup kind="models"><GameProcessingTabs {...imageLayoutMethod}>{imageLayoutModelField}</GameProcessingTabs></GameFlowParameterGroup>}
          {imagePart && flowConfig === "redraw" && <div className="unity-offline-fields">
            <label>模型工作流<select value={imageRedrawProfile} disabled={flowConfigLocked} onChange={event => setImageRedrawProfile(event.target.value as StyleRedrawProfileId)}>
              {Object.entries(styleRedrawLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select></label><span>勾选「识别到文字」中的图片即可批量重绘。</span>
          </div>}
        </div>
  ) : undefined;
  return <div ref={workspaceRef} className={`unity-offline${deploymentPage ? " is-deployment" : mosaicPage ? " is-mosaic" : ""}`}
    style={workspaceStyle} onClickCapture={event => logGameButton(event, logAction)}>{confirmation.dialog}{textDrop.overlay}
    {active && saveFeedback && createPortal(saveFeedback, document.body)}
    {closingPhase && <ClosingProgress phase={closingPhase} />}
    {exitPrompt && <UnityExitDialog {...exitPrompt} onChoice={resolveExitChoice} />}
    {active && root && restoring && <UnityProjectLoading project={root.split(/[\\/]/).filter(Boolean).at(-1) || "Unity 项目"} path={root} detail={loadingDetail} />}
    <StepCards panelRef={panelRef} workflowRef={workflowRef} panelStyle={deploymentPage ? undefined : panelStyle} generationState={generation?.state}
      activeStep={activeStep} imagePart={imagePart} mosaicPage={mosaicPage}
      track={{ steps: trackSteps, edges: trackEdges, enabled: trackEnabled, skipped: trackSkipped,
        disconnected: deploymentPage ? deploymentValidation.disconnected.map(id => deploymentStageId[id]) : undefined }}
      toolbar={toolbarTarget ? { target: toolbarTarget,
        saveTitle: importPreview ? "请先应用或取消导入预览"
          : saving ? "正在保存工程修改" : dirty || mosaicDirty ? "保存工程修改" : "没有未保存的修改",
        saveDisabled: !project || (!dirty && !mosaicDirty) || saving || !!busy || restoring || !!importPreview,
        save: () => void (async () => {
          if (dirty && !await saveUserChanges()) return;
          await saveMosaicUserChanges();
        })(),
      } : undefined}
      mosaic={mosaicMounted ? { controlsRef: setMosaicControls, scanReady,
        hasImages: !!project?.images?.some(image => image.sourceFile && image.width > 0 && image.height > 0),
        error: mosaicStatus?.root === root ? mosaicStatus.error : undefined, hasMosaic } : undefined}
      scan={activeStep === 1 ? { ...cardActivity, measurement: progressMeasurement,
        configuration: scanConfiguration, resources: scanResources } : undefined}
      translation={translationFlow ? { prompts: promptState, flow: translationFlow, configuration: translationConfiguration,
        skipDisabled: !!busy || restoring || saving || !scanReady, skipRemaining: () => void skipTranslationPart(imagePart) } : undefined}
      batch={activeStep === 2 && !imagePart && (textBatch || textTransfer) ? <>{textBatch}{textTransfer}</> : undefined}
      deployment={deploymentPage && <DeploySlot model={deployment.model} actions={deployment.actions} onFocusStep={focusDeploymentStep}
        mosaicDisabled={!root || !!busy || mosaicBusy || restoring || saving} />}
      errorPanel={errorPanel && (generation?.state !== "error" || Math.min(generation.step, 3) === activeStep) && errorPanel} />
    <WorkspaceSlots divider={!deploymentPage ? dividerProps : undefined}
      mosaic={mosaicMounted ? { visible: mosaicPage, onCompletion: reportMosaicCompletion,
        workbench: active && scanReady && mosaicControls && mosaicStorage && project?.images?.some(image => image.sourceFile && image.width > 0 && image.height > 0)
          ? { settings, gamePath: root, images: project.images, read: readMosaicSource, prepareSources: prepareMosaicSources,
            controls: mosaicControls, storage: mosaicStorage, visible: mosaicPage, disabled: mosaicDisabled, onBusy: reportMosaicBusy }
          : undefined,
      } : undefined}
      image={{ visible: activeStep === 2 && imagePart && !mosaicPage, revision: imageResetRevision, workbench: {
        redrawingId, initialScreeningComplete: !imagesNeedScreen,
        onRedrawFailure: async (image, reason) => {
      const current = latest.current;
      const row = current?.images?.find(item => item.id === image.id);
      if (current?.images && row) {
        if (!imageDraftOriginals.current.has(row.id)) imageDraftOriginals.current.set(row.id, row);
        publish({ ...current, images: current.images.map(item => item.id === row.id ? { ...item, error: reason } : item) });
        pendingEdits.current.add("图片重绘：" + row.name);
        setDirty(true);
      }
      logAction(reason, "error");},
        onImportArchive: importImageArchive, onArchiveMessage: (text,error)=>{if(error)setActionError(text);else setMessage(text);logAction(text,error?"error":"info");},
        leaveGuard: imageLeaveGuard, project, active: active && activeStep === 2 && imagePart && !mosaicPage,
        dirty: imageDraftOriginals.current.size > 0, saving, saveNotice, ocrMode: imageOcrMode,
        onTranslate: image => void translateCurrentImage(image), onRecognize: (image, mode) => void recognizeImage(image, mode),
        confidenceThreshold: imageConfidenceThreshold, disabled: !!imageEditorBusy || restoring || saving || !!importPreview || (!!busy && (!translationJobs.current || translationJobs.current.state("images")==="running")),
        onChange: editImage, onChangeMany: editImages, onRender: image => void updateImagePreview(image),
        onImport: (image,source,modelCandidate) => updateImagePreview(image,true,source,modelCandidate), onDiscard: discardImageChanges, onSave: () => saveUserChanges("images"),
      } }}
      text={!deploymentPage && !mosaicPage && !(activeStep === 2 && imagePart) ? {
        textDropRoot, dropHandlers: textDrop.handlers, active, busy, restoring, saving, testTitle, scanReady, project, importPreview, importMode,
        textFilters, matchedCount: matched.length, filteredCount: filtered.length, errorsOnly, search,
        retryUnfinishedDisabled: testing || !!busy || restoring || !scanReady || !connectionReady || applied || !selected.some(entry => entry.error || unityTranslationError(entry.source, entry.translation)),
        discardDisabled: !project||saving||!!busy||restoring||!importPreview&&(!dirty||![...pendingEdits.current].some(key=>key.startsWith("文本与译文：")||key.startsWith("文本勾选："))),
        saveDisabled: !project || !hasTextDraft&&!importPreview || saving || !!busy || restoring,
        tableRef, sourceWidth: sourceWidth.width, originalRatio,
        sourceDivider: { onMouseDown: e => sourceWidth.beginResize(e, "grow-right"), onKeyDown: e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); sourceWidth.setWidth(sourceWidth.width + (e.key === "ArrowRight" ? 8 : -8)); } } },
        originalDivider: {
          onPointerDown: e => { e.preventDefault(); columnDrag.current = { x: e.clientX, ratio: originalRatio, latest: originalRatio, width: tableRef.current!.getBoundingClientRect().width }; e.currentTarget.setPointerCapture(e.pointerId); },
          onPointerMove: e => { const drag = columnDrag.current; if (!drag) return; drag.latest = Math.max(20, Math.min(70, drag.ratio + (e.clientX - drag.x) / drag.width * 100)); tableRef.current?.style.setProperty("--unity-original-width", String(drag.latest) + "%"); },
          onPointerUp: finishColumnDrag, onPointerCancel: finishColumnDrag,
          onKeyDown: e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const ratio = Math.max(20, Math.min(70, originalRatio + (e.key === "ArrowRight" ? 2 : -2))); setOriginalRatio(ratio); localStorage.setItem("unity-offline-original-ratio", String(ratio)); } },
        },
        entriesLocked, checkedCount, hasMixedSelection, rows, rowJump, target, source, skipTargetLanguage, textScreened, qualityIssues,
        locateAcrossLanguages, scope, selectedCount: selected.length, done, visiblePage, pageCount, rowIssue, rowFailure, rowRetryQueued, qualityIssue, qualityIssueId,
        retryIssueTitle: applied || patch ? "请先清理现有补丁再重试" : rowRetryQueued ? "该条目已在翻译队列中" : busy && rowQueueStatus !== "failed" ? "请在当前任务结束后单独重试此条目" : "重新加入翻译队列，保留已有译文和草稿",
        retryIssueDisabled: testing || rowRetryQueued || restoring || !scanReady || !connectionReady || applied || !!patch || !!busy && rowQueueStatus !== "failed",
        onDownload: range => void downloadTranslations(range), onImport: mode => { setImportMode(mode); void uploadTranslations(undefined,mode); },
        onLimitChange: limit => { setTextFilters(previous => ({ ...previous, limit })); setPage(0); },
        onFilterChange: value => { setTextFilters(value); setLocateAcrossLanguages(false); setReviewFilter("all"); setPage(0); },
        onRetryUnfinished: () => void startWorkflow(2, 2, !!checkpoint?.layoutOnly, false, false, "text"),
        onSearch: value => { setSearch(value); setPage(0); },
        onDiscard: () => importPreview ? cancelImportPreview() : void discardTextChanges(),
        onSave: () => void (importPreview ? applyImportPreview(importMode) : saveUserChanges("text")),
        onCheckFiltered: checked => { textSearchSnapshot.current = null; editTextEntries(new Set(filtered.map(row => row.id)), { selected: checked }); },
        entryProblem, onUpdateEntry: update,
        onOpenRowIssue: entry => { setQualityIssueId(null); setRowIssue({ ...entry, error: entryProblem(entry) }); },
        onOpenQualityIssue: id => { setRowIssue(null); setQualityIssueId(id); }, onPage: setPage,
        onCheckImport: () => checkImportPreview(), onRetryIssue: id => void retryTranslationEntry(id), onCloseRowIssue: () => setRowIssue(null),
        onLocateQualityIssue: () => locateTranslationFailure(qualityIssueId!), onCloseQualityIssue: () => setQualityIssueId(null),
      } : undefined} />
  </div>;
});
