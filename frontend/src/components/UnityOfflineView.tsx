import { benchmarkBlockingReason, isBenchmarkRunning, useBenchmarkRunning, useFormalWorkflowActivity } from "../benchmark/benchmarkRunner";
import { refineMosaicBatch } from "../gameMosaicRefine";
import { requestGameModelJson } from "../gameModelRequest";
import { useOutputMessage, writeOutput, type OutputLevel } from "../appOutput";
import { writeDownloadedFile } from "../outputFiles";
import { rememberRecentGameFailures } from "../unityLastGame";
import { clearImageGroupHistory, resetImageGroupHistory } from "../gameImageGroupChanges";
import { useGameTestConfigurationSource } from "../gameAuxWindows";
import { GameBatchResults, type BatchRow } from "./GameBatchResults";
import { GameMosaicWorkbench, type MosaicCandidateIndex } from "./GameMosaicWorkbench";
import { GameMosaicPatchButton } from "./GameMosaicPatchButton";
import { canDisableOllamaNameThinking, prepareGameOllamaModels, translateGameWithOllama } from "../gameOllama";
import { screenGameText } from "../gameTextScreening";
import { createGameTranslationContext, GAME_CONTEXT_HINT, gameTranslationRetry, isGameDialogue } from "../gameTranslationContext";
import { openGameTextBenchmark } from "./GameTextBenchmarkDialog";
import { sameTextEdit } from "../gameTextProject";
import { beginGameStep, finishGameStep, gameModelExecution, modelConcurrency, clearGamePerformance, completeGameStep, stepPerformance, measureGameAsync, measureGameWork, reportGameStepItems, gameStepSelections } from "../gameModelPerformance";
import { wrapGameTextToSource, validateGameNaturalLines, type GameWrapMode } from "../gameTextLayout";
import { GamePromptContext, useGamePromptSelection, gameTaskPrompt } from "../gamePrompts";
import { GamePageNumber } from "./GamePageNumber";
import { gameImageTranslationProblem, recognizeGameImage, renderGameImage } from "../gameImageModel";
import { createGameImageOcrReuse, savedGameImageRedraw, defaultGameImageReview, defaultGameImageTranslation, defaultGameImageVision, gameImageCleanBase, gameImageRedrawSelected, gameImageRedrawSummary, gameImageVisionForAsset, redrawGameImages, styleRedrawLabels, type StyleRedrawProfileId } from "../gameImagePlacement";
import { collectGameImageNames, translateNamedImageText } from "../gameImageNames";
import { applyGameTestRoles, captureGameTestRoles, recommendedGameModels, type GameTestConfigurationAccess } from "../gameModelPreset";
import { GameFlowSequence, type GameStepConfigurationCommit } from "./GameFlowSequence";
import { formatFlowThroughput } from "../gameFlowMetrics";
import { GameProgressBar, GameStepProgress } from "./GameStepProgress";
import { gameAvailableModels, GameModelSelect, GameProcessingTabs, GameTranslationTabs } from "./GameTranslationTabs";
import { GameTextScreenedEditor, GameTextScreenedSource } from "./GameTextScreening";
import { prepareUnityImageSources, readUnitySourceImage } from "../unityImagePreview";
import { registerAppCloseGuard } from "../appClose";
import { useGameActionConfirm, logGameButton } from "./GameActionConfirm";
import { GameTextFilterMenu, defaultGameTextFilters, matchesGameTextFilters, limitGameText } from "./GameTextFilterMenu";
import { GameWorkDirectory } from "./GameWorkDirectory";
import { SearchHighlight } from "./SearchHighlight";
import { useGameFileDrop } from "../hooks/useGameFileDrop";
import { imageImportPng,type GameImportSource } from "../gameImageImport";
import type { ImageArchiveReplacement } from "../gameImageArchive";
import { GameWorkflowSteps } from "./GameWorkflowSteps";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { prepareGameTerms, gameTermProblem } from "../gameTermMemory";
import { GAME_IMAGE_SCREENING_LANES, LOCAL_REFINE_MODELS, gameImageRegionLanguageFilter, gameImageTranslationReadiness, localGameImageScreeningLanes } from "../gameImageScreening";
import { defaultUnityImageScreening, needsUnityImageScreening, recognizeUnityReviewCrops, refineUnityImages, refineUnityImagesLocally, screenUnityImages, unityImageRefinementPending, type UnityImageScreeningOptions } from "../unityImageFiltering";
import { gameTextHasSpeaker, gameDisplayTextProblem, gameImageJapaneseTextIssue, gameTextNeedsNoTranslation, preserveTargetGameText, translateGameDisplayText } from "../gameDisplayText";
import { isTauri } from "@tauri-apps/api/core";
import { dirname, join, resourceDir } from "@tauri-apps/api/path";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readFileBytes } from "../localDocFile";
import { exportUnityTranslations, readUnityTranslationRows, applyUnityTranslationRows, unityTranslationFileName, UnityTranslationImportError, type UnityTranslationImportMode, type UnityTranslationImportIssue } from "../unityTranslationFiles";
import { UnityActionIcon } from "./UnityActionIcon";
import { UnityIconButton } from "./UnityIconButton";
import { ClosingProgress, useClosingProgress } from "./ClosingProgress";
import { unityTranslationQuality } from "../unityTranslationQuality";
import { unityTranslationReadiness, unityCurrentPartProgress } from "../unityTranslationReadiness";
import { UnityExitDialog, type UnityExitChoice } from "./UnityExitDialog";
import { GameTextFileMenu, GAME_TEXT_IMPORT_CHOICES } from "./GameTextFileMenu";
import { api, type Settings, type TranslateProvider, type UnityGameInfo, type OcrMode } from "../api";
import { loadLocalModelProfiles, resolveFeatureLlm } from "../modelPresets";
import { engineReady, parseEngineKeys } from "../translateEngines";
import { gameLocalModelConnection, type GameTranslationKind, buildUnityTranslateOptions, localTextRequestGroup, prepareUnityTranslationRequest, prepareUnityTranslationText, restoreUnityTranslationLines, sameUnityGamePath, UNITY_LANGUAGES } from "../unityTranslation";
import { formatUnityStructure, planUnityStructuredLines, canReuseUnityStructuredDraft } from "../unityTextStructure";
import { legacyUnityOutputDirectory, mergeUnityProject, UnityPaused, unityRun, unityTranslationError, type UnityEntry, type UnityPatch, type UnityProgress, type UnityProject, type UnityWorkspace, type UnityInspection, type UnityFontPlan, type UnityImage } from "../unityOffline";
import { explainUnityFailure, explainUnityWarning } from "../unityOfflineFeedback";
import { UNITY_STAGE_TABS, unityImageWorkDone, unityImageReadyForTarget, tagLegacyImageTargets, tagEditedImageTranslations, rememberLegacyGameTarget, UNITY_STEPS, unityLanguageScope, unityStageState, unityEntryLanguage, unityLanguageLabel, unityScanUpdate, unityScanOptionChanges, deploymentMetrics, deploymentMetricScope, measureDeploymentStage } from "../unityWorkflow";
import { translateUnitySession, unityTranslationStats, unityTranslationCharacters, unityTranslationContextKey, textTranslationMatchesTarget, tagLegacyTextTargets, yieldUnityPreparation, type UnityTranslationQueue } from "../unityTranslationSession";
import { smartUnityLines, planUnityLines, flattenUnityLines, applyUnityLineBreaks, parseUnityLineModel, unityLineModelInput, UNITY_LINE_MODEL_PROMPT, type UnityLineMode } from "../unityLineLayout";
import { UnitySegmentation } from "../unitySegmentation";
import { UnityDeploymentPanel, deploymentSequence, deploymentPhases, loadDeploymentPlan, saveDeploymentPlan, validateDeploymentPlan, type DeploymentActions, type DeploymentModel, type DeploymentPhase, type DeploymentPlan, type DeploymentRun, type DeploymentStep } from "./UnityDeploymentPanel";
import { redrawMosaic, gameDetectorFile, openDeploymentDetector, readMosaicSettings, saveMosaicSettings, type MosaicBox } from "../gameMosaic";
import { UnityProjectLoading } from "./UnityProjectLoading";
import { UnityImageWorkbench } from "./UnityImageWorkbench";
import { reconcileImageEdit } from "../unityImageEdits";
import { createUnityTranslationJobs, mergeUnityTranslationProject, UnityTranslationStopped, type UnityTranslationPart } from "../unityTranslationJobs";
import { normalizeUnityImageSelection, createUnityImageOcr, translateCurrentUnityImage, processUnityImages, maskUnityImageRegions, unityImageUsesRegionMask, unityImageTranslationRegions } from "../unityImages";
import { OCR_MODE_OPTIONS } from "../ocr/modes";
import { UnityEngineList } from "./UnityEngineList";
import { gameTextStageLabels, UnityTranslationProgress } from "./UnityTranslationProgress";
import { createUnityEnginePool, loadUnityEngines, normalizeUnityEngines, defaultUnityEngines, UNITY_ENGINE_CHOICES_KEY, type UnityEngineChoice } from "../unityEnginePool";
import { UnityDescriptionSelect, UNITY_WRAP_CHOICES, UNITY_LINE_CHOICES, UNITY_SEGMENT_CHOICES } from "./UnityDescriptionSelect";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import { useGameWorkspaceSplit } from "../hooks/useGameWorkspaceSplit";
import "../unityOffline.css";

export type UnityOfflineHandle = { prepareToLeave: () => Promise<boolean | "discard"> };
const GENERATION_STEPS = UNITY_STEPS;
type UnityTranslationOptions = ReturnType<typeof buildUnityTranslateOptions> & { wrapMode?: GameWrapMode; dialogueOptions?: ReturnType<typeof buildUnityTranslateOptions>; nameOptions?: ReturnType<typeof buildUnityTranslateOptions>; imageReviewOptions?: ReturnType<typeof buildUnityTranslateOptions>; engineIds?: TranslateProvider[]; includeContext?: boolean; skipTargetLanguage?: boolean; onlySourceLanguage?: boolean };
type GenerationProgress = UnityProgress & { step: number; elapsedMs?: number; state: "pending" | "running" | "done" | "stopped" | "error" | "skipped"; failure?: string };
type TranslationFileStatus = { action: "download" | "import"; state: "working" | "preview" | "done" | "cancelled" | "error"; detail: string; path?: string; folder?: string; issues?: UnityTranslationImportIssue[]; needsValidation?: boolean };
type ImportPreview = { path: string; entries: UnityEntry[]; issues?: UnityTranslationImportIssue[]; remapped?: number; view: { search: string; reviewFilter: "all" | "unfinished" | "quality" | "target"; page: number; imagePart: boolean; activeStep: number } };
const EMPTY_ENTRIES: UnityEntry[] = [];
const unityImagePhaseNames = { filter: "筛选图片", refine: "复筛图片", recognize: "识字与定位", translate: "翻译图片文字",
  review: "复核与重译", render: "生成译图", redraw: "AI 风格重绘" } as const;
type UnityImagePhase = keyof typeof unityImagePhaseNames;
type UnityImageResetPhase = Exclude<UnityImagePhase, "redraw">;
const unityImagePhases = Object.keys(unityImagePhaseNames) as UnityImagePhase[];
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

type DeploymentPatch = UnityPatch & { deploymentExcluded?: DeploymentPhase[] };

type RunCheckpoint = {
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
type Props = {
  active: boolean; game: UnityGameInfo | null; settings: Settings;
  onOpenGeneralSettings?: () => void;
  onBusyChange?: (busy: boolean) => void;
  onInstallationChange?: (root: string, installed: boolean) => void;
  toolbarTarget: HTMLElement | null;
};
export const UnityOfflineView = forwardRef<UnityOfflineHandle, Props>(function UnityOfflineView({ active, game, settings, onBusyChange, onInstallationChange, toolbarTarget }, ref) {
  const { phase: closingPhase, show: showClosing, clear: clearClosing } = useClosingProgress();
  const root = game?.gameDir || "";
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
  const [redrawingId, setRedrawingId] = useState<string>();
  const [imageRedrawProfile, setImageRedrawProfile] = useState<StyleRedrawProfileId>("turbo");
  const [imageOcrMode, setImageOcrMode] = useState<OcrMode>("fast");
  const [imageConcurrency,setImageConcurrency]=useState(() => navigator.hardwareConcurrency >= 4 ? GAME_IMAGE_SCREENING_LANES : 1);
  const [imageConfidenceThreshold, setImageConfidenceThreshold] = useState(50);
  const [imageScreeningOptions, setImageScreeningOptions] = useState(defaultUnityImageScreening);
  const [textScreenModel, setTextScreenModel] = useState<string | undefined>();
  const [textScreened, setTextScreened] = useState(false);
  const [textScreening, setTextScreening] = useState(false);
  const [textScreenStarted, setTextScreenStarted] = useState(false), [textScreenPaused, setTextScreenPaused] = useState(false);
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
  const [mosaicControls, setMosaicControls] = useState<HTMLDivElement | null>(null);
  const [mosaicStatus, setMosaicStatus] = useState<{ root: string; candidates: MosaicCandidateIndex; error?: string }>();
  const setActiveStep = useCallback((step: number) => { setMosaicPage(false); setWorkflowStep(Math.min(step, 3)); }, []);
  const followProgress = useRef(true);
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
  const imageTask = useRef<UnityImagePhase>("filter");
  const [generationState, setGeneration] = useState<GenerationProgress | null>(null);
  const [applied, setApplied] = useState(false);
  const [installed, setInstalled] = useState(false);

  const [checkpoint, setCheckpoint] = useState<RunCheckpoint | null>(null);
  const checkpointRef = useRef<RunCheckpoint | null>(null);
  const translationJobs = useRef<ReturnType<typeof createUnityTranslationJobs> | null>(null);
  const projectWrites = useRef<Promise<unknown>>(Promise.resolve());
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
  const taskWrites = useRef<Promise<unknown>>(Promise.resolve());
  const queuedSignature = useRef("");
  const checkpointKey = "llmchat-unity-run:" + root.toLowerCase();
  const textConfigurationCommit = useRef<GameStepConfigurationCommit | null>(null);
  const imageConfigurationCommit = useRef<GameStepConfigurationCommit | null>(null);
  const remember = (value: RunCheckpoint) => {
    const checkpoint = abort.current && value.step >= 2 ? { ...value, ...execution.current.parameters } : value;
    checkpointRef.current = checkpoint; setCheckpoint(checkpoint); setGeneration(checkpoint.progress);
    const { progress, translationRuns, ...fields } = checkpoint;
    const parts = translationRuns && Object.fromEntries(Object.entries(translationRuns).map(([part, value]) => [part, { state: value.state, total: value.total, failure: value.failure,
      completed: value.redrawFailed === undefined ? undefined : value.completed, redrawFailed: value.redrawFailed,
      engineStats: value.engineStats?.map(({ id, characters }) => ({ id, characters })) }]));
    const signature = JSON.stringify({ root, ...fields, translationRuns: parts, progress: { step: progress.step, state: progress.state, folder: progress.folder, total: progress.total, failure: progress.failure } });
    if (signature !== queuedSignature.current) {
      queuedSignature.current = signature;
      const job = structuredClone(checkpoint);
      taskWrites.current = taskWrites.current.catch(() => {}).then(() => unityRun("save-task", { root, task: job }));
      void taskWrites.current.catch(e => { queuedSignature.current = ""; setError(`任务检查点保存失败：${String(e)}`); });
    }
  };
  const abort = useRef<AbortController | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const translationQueue = useRef<UnityTranslationQueue | null>(null);
  const retryFailureIds = useRef<Set<string> | undefined>(undefined);
  const closing = useRef(false);
  const [exitPrompt, setExitPrompt] = useState<{ running: boolean; projectOnly: boolean; changes: string[] } | null>(null);
  const exitDecision = useRef<((choice: UnityExitChoice) => void) | null>(null);
  const requestExitChoice = (projectOnly: boolean): Promise<UnityExitChoice> => new Promise(resolve => {
    if (exitDecision.current) { resolve("cancel"); return; }
    exitDecision.current = resolve;
    const changes = [...pendingEdits.current];
    if (importPreviewRef.current) changes.unshift(`待应用的导入预览：${importPreviewRef.current.entries.length} 条译文，含右侧编辑`);
    if (status.current.dirty && !changes.length) changes.push("工程参数或文本、图片编辑");
    if (status.current.busy) changes.push(`正在处理：${status.current.busy}`);
    setExitPrompt({ running: !!status.current.busy, projectOnly, changes });
  });
  const resolveExitChoice = (choice: UnityExitChoice) => {
    const resolve = exitDecision.current; exitDecision.current = null;
    setExitPrompt(null); resolve?.(choice);
  };
  const status = useRef({ busy, dirty }); status.current = { busy:busy||imageEditorBusy, dirty: dirty || !!importPreview };
  const latest = useRef(project); latest.current = project;
  const publish = (value: UnityProject) => { latest.current = value; setProject(value); };
  const scanUpdate = unityScanUpdate(project, checkpoint, { includeCode, textMode, typeDirectory, codeAssemblies });
  const needsScan = scanUpdate.level === "required";
  useEffect(() => { workflowRef.current?.scrollTo({ top: 0 }); }, [activeStep, imagePart, mosaicPage]);
  useEffect(() => {
    let cancelled = false; setInspection(null); setInspectionError("");
    if (root) void unityRun<UnityInspection>("inspect", { root }).then(result => { if (!cancelled) setInspection(result); }).catch(error => { if (!cancelled) setInspectionError(String(error)); });
    return () => { cancelled = true; };
  }, [root]);

  useEffect(() => {
    setProject(null); setPatch(null); setDirty(false); textDraftOriginals.current.clear(); imageDraftOriginals.current.clear();pendingImageMasks.current.clear(); pendingEdits.current.clear(); setImportPreview(null); setSaveComplete(false); setPage(0); setSearch(""); setFileStatus(null); setRowJump(null);
    setReviewFilter("all"); setQualityIssueId(null); setImportMode("fill");
    setError(""); setActionError(""); setMessage(""); setFontPath(""); setLlmModel(recommendedGameModels().text || ""); setDialogueModel(""); setNameModel(""); setImageModel(""); setImageReviewModel(""); setJoinLines(true); setIncludeContext(false); setOnlySourceLanguage(true);
    setLineMode("local"); setLineModel("");
    setImageConfidenceThreshold(50);
    setGeneration(null); setApplied(false); setInstalled(false);
    setTextMode("smart"); setCodeAssemblies(null); setTypeDirectory(""); setExtraCharacters(""); setFontPlan(null);
    setPreparingRescan(false);
    setActiveStep(1); setImagePart(false); followProgress.current = true;

    setWorkRoot(""); setOutput(""); setRowIssue(null); queuedSignature.current = "";
    setCheckpoint(null); checkpointRef.current = null;
    let cancelled = false;
    const saved = localStorage.getItem(checkpointKey);
    if (!root) { setRestoring(false); return; }
    setLoadingDetail("正在读取工作目录与任务检查点…");
    setImageScreeningOptions(defaultUnityImageScreening);
    setRestoring(true);
    void (async () => {
      try {
        const workspace = await unityRun<UnityWorkspace<RunCheckpoint>>("workspace", { root, outputRoot: await legacyUnityOutputDirectory(), task: saved ? JSON.parse(saved) : null }, progress => { if (!cancelled) setLoadingDetail(progress.detail); });
        if (cancelled) return;
        setWorkRoot(workspace.workRoot); setOutput(workspace.projectsRoot); reportRestore(workspace.saved.notices);
        let value = workspace.task;
        const folder = value?.projectFolder || value?.scanFolder;
        let p: UnityProject | null;
        if (folder) p = await loadProject(folder, value?.previousProjectFolder, detail => { if (!cancelled) setLoadingDetail(detail); });
        else {
          const found = workspace.saved;
          if (cancelled) return;
          reportRestore(found.notices); p = found.project;
          if (p) {
            const incomplete = found.scanTotal !== null;
            if (!value) value = projectCheckpoint(p, incomplete, found.scanCompleted, found.scanTotal);
            else { value.projectFolder = p.folder; if (incomplete) value.scanFolder = p.folder; }
            if (found.includeCode !== null) value.includeCode = found.includeCode;
          }
        }
        if (cancelled) return;
        setLoadingDetail(p ? `正在恢复 ${p.entries.length.toLocaleString("zh-CN")} 条原文、译文及处理进度…` : "正在准备项目操作界面…");
        if (p && !sameUnityGamePath(p.root, root)) throw new Error("检查点不属于当前游戏");
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
        await taskWrites.current;
        if (!cancelled) localStorage.removeItem(checkpointKey);
      } catch (e) { if (!cancelled) setError(`恢复检查点失败：${e instanceof Error ? e.message : String(e)}`); }
      finally { if (!cancelled) setRestoring(false); }
    })();
    return () => { cancelled = true; };
  }, [root]);
  const formalProgress = mosaicBusy ? undefined : localActivity?.value.state === "running" ? localActivity.value :
    generationState?.state === "running" ? generationState : undefined;
  const formalUnfinished = !preparingRescan && !!checkpoint && !checkpoint.finished &&
    ["stopped", "error"].includes(checkpoint.progress.state);
  useFormalWorkflowActivity(!!busy || restoring || textScreening || !!imageEditorBusy, game?.gameDir || root,
    typeof busy === "string" && busy ? busy : formalUnfinished ? checkpoint.progress.detail || "工程流程" : "工程处理",
    formalProgress?.completed ?? undefined, formalProgress?.total ?? undefined, formalUnfinished);
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
  const previousParameters = useRef(parameterSignature);
  const parameterWrite = useRef<(() => void) | null>(null);
  useEffect(() => {
    const changed = previousParameters.current !== parameterSignature;
    previousParameters.current = parameterSignature;
    if (!changed || restoring || !project) return;
    let timer: number;
    const commit = () => {
      window.clearTimeout(timer); parameterWrite.current = null;
      const current = latest.current; if (!current) return;
      remember({ ...(checkpointRef.current || projectCheckpoint(current)), translationKind, llmModel, dialogueModel, nameModel, imageModel, imageReviewModel, engine, engines: engineChoices, source, target, joinLines, wrapMode, textScreenModel, includeContext, skipTargetLanguage, onlySourceLanguage, lineMode, lineModel, imageOcrMode, imageVisionModel, imageLayoutModel, imageRedrawProfile, imageConcurrency, imageConfidenceThreshold, imageScreeningOptions, includeCode, fontPath, textMode, codeAssemblies, typeDirectory, extraCharacters });
    };
    parameterWrite.current = commit; timer = window.setTimeout(commit, 350);
    return () => { window.clearTimeout(timer); if (parameterWrite.current === commit) parameterWrite.current = null; };
  }, [parameterSignature, restoring, project?.folder]);

  useImperativeHandle(ref, () => ({ prepareToLeave: async () => {
    if (busy || imageEditorWork.current || running.current || restoring) { setError("请先中止任务或等待当前工作目录处理完成后切换"); return false; }
    try {
      parameterWrite.current?.();
      if (dirty || importPreviewRef.current) {
        const choice = await requestExitChoice(true);
        if (choice === "cancel") return false;
        if (choice === "discard") { await Promise.allSettled([projectWrites.current, taskWrites.current]); return "discard"; }
        if (importPreviewRef.current && !await applyImportRef.current()) return false;
        await save();
      }
      await taskWrites.current; return true;
    } catch (e) { setError(String(e)); return false; }
  } }));
  useEffect(() => () => { deploymentController.current?.abort(); abort.current?.abort();imageEditorAbort.current?.abort(); exitDecision.current?.("cancel"); exitDecision.current = null; }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (!closing.current && (dirty || busy || imageEditorBusy || importPreview)) event.preventDefault(); };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy, imageEditorBusy, importPreview]);
  const needsCloseHandler = project !== null || !!busy || !!imageEditorBusy;
  const closeRelevant = active || dirty || !!busy || !!imageEditorBusy;
  useEffect(() => {
    if (!closeRelevant || !needsCloseHandler || !isTauri()) return;
    let dispose: (() => void) | undefined; let cancelled = false;
    void registerAppCloseGuard(async () => {
      if (closing.current) return false;
      closing.current = true;
      try {
        parameterWrite.current?.();
        const choice = status.current.busy || status.current.dirty ? await requestExitChoice(false) : "save";
        if (choice === "cancel") return false;
        if (status.current.busy) {
          await showClosing("正在中止 Unity 任务，等待当前资源处理结束…");
          deploymentController.current?.abort(); abort.current?.abort();imageEditorAbort.current?.abort();
          await running.current?.catch(() => {});await imageEditorWork.current?.catch(()=>{}); // The task's operation handler reports its outcome.
        }
        if (choice === "save") {
          if (importPreviewRef.current) {
            await showClosing("正在校验并保存待应用的导入预览…");
            if (!await applyImportRef.current()) return false;
          }
          if (latest.current) { await showClosing("正在保存 Unity 工程和编辑内容…"); await save(); }
          await showClosing("正在等待工程文件写入完成…"); await projectWrites.current;
          await showClosing("正在保存任务进度与恢复信息…"); await taskWrites.current;
        } else {
          await showClosing("正在等待已开始的文件写入完成…");
          await Promise.allSettled([projectWrites.current, taskWrites.current]);
        }
        await showClosing("正在关闭窗口和后台服务…");
        return true;
      } catch (e) { setError(`退出失败，窗口已保留：${String(e)}`); return false; }
      finally { clearClosing(); closing.current = false; }
    }).then(fn => { if (cancelled) fn(); else dispose = fn; }).catch(e => setError(String(e)));
    return () => { cancelled = true; dispose?.(); };
  }, [closeRelevant, needsCloseHandler]);

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
        checkpointRef.current = workspace.task; setCheckpoint(workspace.task); queuedSignature.current = "";
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
      try { localStorage.removeItem("llmchat-game-mosaic:" + root); } catch { /* Storage can be unavailable. */ }
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
  function queueProjectWrite<T>(job: () => Promise<T>): Promise<T> {
    const next = projectWrites.current.catch(() => {}).then(job); projectWrites.current = next; return next;
  }
  async function save(p = latest.current, area: "all" | "text" | "images" = "all") {
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
      publish(current);
      const saved = { ...current,
        entries: area === "images" ? current.entries.map(entry => textDraftOriginals.current.get(entry.id) || entry) : current.entries,
        images: area === "text" ? current.images?.map(image => imageDraftOriginals.current.get(image.id) || image) : current.images };
      const cache=await unityRun<{cacheErrors?:string[]}>("save", { project:saved,cleanImageCache:area !== "text" && !deploymentController.current });
      if(cache.cacheErrors?.length)setActionError("工程已保存，部分译图缓存未能清理："+cache.cacheErrors.join("；"));
      for (const key of pendingEdits.current) {
        const image = key.startsWith("图片与译文：") || key.startsWith("译图");
        if (area === "all" || (area === "images") === image) pendingEdits.current.delete(key);
      }
      if (area !== "text") imageDraftOriginals.current.clear();
      if (area !== "images") textDraftOriginals.current.clear();
    });
    setDirty(pendingEdits.current.size > 0);
  }
  async function saveUserChanges(area: "all" | "text" | "images" = "all") {
    if (saving || importPreviewRef.current) return false;
    const changes = [...pendingEdits.current].filter(key => area === "all" || (area === "images") === (key.startsWith("图片与译文：") || key.startsWith("译图")));
    if (!changes.length) { logAction("当前没有需要保存的修改"); return true; }
    setSavedChanges(changes.map(change => {
      const id = change.match(/^文本与译文：第 (.+) 条$/)?.[1]; const entry = id && latest.current?.entries.find(row => row.id === id);
      return entry ? `${change} · ${entry.translation.slice(0, 80) || "空译文"}` : change;
    })); setSaving(true); setSaveNotice(""); setSaveComplete(false); logAction(`正在保存${area === "images" ? "图片" : area === "text" ? "文本" : "工程"}修改`);
    try { await save(undefined, area); setSaveNotice("已保存"); setSaveComplete(true); logAction("修改已保存", "success"); return true; }
    catch (error) { setDirty(true); setActionError(`保存失败：${String(error)}`); setSaveNotice("保存失败"); logAction(`保存失败：${String(error)}`, "error"); return false; }
    finally { setSaving(false); }
  }

  async function discardImageChanges(){
    const current=latest.current; if(!current)return false;
    if (!imageDraftOriginals.current.size) { logAction("当前没有未保存的图片修改"); return true; }
    const next={...current,images:current.images?.map(image=>imageDraftOriginals.current.get(image.id)||image)};
    const count = imageDraftOriginals.current.size;
    publish(next); imageDraftOriginals.current.clear(); pendingImageMasks.current.clear();
    for(const key of pendingEdits.current)if(key.startsWith("图片与译文：")||key.startsWith("译图"))pendingEdits.current.delete(key);
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
  async function translateProject(p: UnityProject, controller: AbortController, options: Awaited<ReturnType<typeof translationOptions>>, onProgress?: (value: UnityProgress) => void, languageSource = source, mergeLines = joinLines, breakMode: UnityLineMode = "local", helperModel = "", layoutOnly = false, onlyIds?: Set<string>) {
    await yieldUnityPreparation(controller.signal);
    const next = structuredClone(p);
    const cache = new Map<string, string>();
    const contextForEntry = createGameTranslationContext(next.entries, options.provider === "llm" && !!options.includeContext);
    const glossary: { src: string; dst: string; info?: string }[] = typeof options.glossary === "string" ? JSON.parse(options.glossary || "[]") : options.glossary || [];
    const ids = unityLanguageScope(next.entries, languageSource, options.onlySourceLanguage !== false).ids;
    const selectedEntries = next.entries.filter(e => (onlyIds ? onlyIds.has(e.id) : e.selected && ids.has(e.id)) && (!layoutOnly || !!e.layoutDraft));
    if (!layoutOnly) {
      onProgress?.({ completed: 0, total: selectedEntries.length, detail: "正在筛查目标语言", textStage: "screening" });
      await yieldUnityPreparation(controller.signal);
      const preserved = options.skipTargetLanguage ? measureGameWork(promptState.scope + ":text", "processingMs", () => preserveTargetGameText(selectedEntries, options.target || "zh-CN")) : 0;
      for (const entry of selectedEntries)
        if (entry.translation === entry.source) entry.translationTarget = options.target;
      if (preserved) await saveTranslation(next, "text");
    }
    const localProfilesForRetry = loadLocalModelProfiles();
    const helperCache = new Map<string, string>();
    const segmenter = new UnitySegmentation();
    const sentenceCache = new Map<string, number[]>();
    const helperOptions = options.wrapMode!=="natural" && mergeLines && breakMode === "model" && selectedEntries.some(e => /[\r\n]/.test(e.source) && (layoutOnly || e.error || !e.translation || unityTranslationError(e.source, e.translation)))
      ? { ...(options.localModel
          ? options
          : buildUnityTranslateOptions(await api.getSettings(), "llm", "auto", options.target || "zh-CN", helperModel)),
          ...gameModelExecution(promptState.selection, "line", helperModel),
          prompt: gameTaskPrompt("line",promptState.selection)+"\n"+UNITY_LINE_MODEL_PROMPT, autoChunk: false } : null;
    setDirty(true);
    const formatUnbounded = async (original: string, translated: string) => {
      if(gameTextHasSpeaker(original))return translated;
      if (!/[\r\n]/.test(original)) return translated;
      if (breakMode === "ratio") return formatUnityStructure(original, translated, restoreUnityTranslationLines);
      if (breakMode === "wtp") {
        const texts = new Set<string>();
        planUnityStructuredLines(original, translated, (s, t) => { const plan = planUnityLines(s, t); if (plan.slots.length > 1) texts.add(flattenUnityLines(t)); return plan; });
        for (const text of texts) if (!sentenceCache.has(text)) sentenceCache.set(text, await segmenter.sentenceEnds(text, controller.signal));
        return applyUnityLineBreaks(planUnityStructuredLines(original, translated, (s, t) => planUnityLines(s, t, undefined, sentenceCache.get(flattenUnityLines(t)))));
      }
      if (breakMode !== "model") return formatUnityStructure(original, translated, smartUnityLines);
      const plan = planUnityStructuredLines(original, translated, planUnityLines);
      if (!plan.breaks.length) return smartUnityLines(original, translated);
      const key = JSON.stringify([original.replace(/\r\n?/g, "\n"), plan.units]);
      let response = helperCache.get(key);
      if (!response) {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
        try {
          const result = await translateGameWithOllama(unityLineModelInput(original, plan), { signal }, {...helperOptions!,llmBatch:false}, textLog);
          if (!result.ok) throw new Error(result.code || "断行辅助请求失败");
          response = result.translation;
        } catch (error) {
          if (!controller.signal.aborted && signal.reason?.name === "TimeoutError") throw new Error("断行辅助模型超过 120 秒未响应，译文草稿已保存");
          throw error;
        }
      }
      const formatted = parseUnityLineModel(plan, response); helperCache.set(key, response); return formatted;
    };
    const format=async(original:string,translated:string)=>options.wrapMode==="natural"?validateGameNaturalLines(original,translated):wrapGameTextToSource(original,await formatUnbounded(original,translated));
    let formatQueue = Promise.resolve();
    const queuedFormat = (original: string, translated: string) => {
      const work = formatQueue.then(() => { controller.signal.throwIfAborted(); return format(original, translated); });
      formatQueue = work.then(() => {}, () => {});
      return work;
    };
    let terminology: ReadonlyMap<string, string> = new Map();
    let termIssues: ReadonlyMap<string, string> = new Map();
    const requestTranslation = async (text: string, provider = options.provider, entry?: UnityEntry, nameContext?: string) => {
      const { engineIds: _engines, includeContext: withContext, skipTargetLanguage: _skipTargetLanguage, dialogueOptions, nameOptions, ...mainOptions } = options;
      const preserveDialogue = provider === "llm" && isGameDialogue(text, entry);
      const primaryOptions = provider === "llm" ? (nameContext ? nameOptions : preserveDialogue ? dialogueOptions : undefined) || mainOptions : mainOptions;
      const context = provider === "llm" ? contextForEntry(entry, nameContext) : undefined;
      const relevantText = text + (context || []).map(item => item.source).join("\n");
      const terms = glossary.filter(term => term.src?.trim() && term.dst?.trim() && relevantText.includes(term.src));
      const request = async (block: string, originalContext?: string, retryReason?: string) => {
        const reviewer = retryReason && provider === "llm" && primaryOptions.localModel
          ? Object.keys(localProfilesForRetry).find(id => /^qwen3\.5(?::|$)/i.test(id)) : undefined;
        const requestOptions = reviewer && reviewer !== primaryOptions.model
          ? { ...primaryOptions, ...buildUnityTranslateOptions(settings, "llm", options.source || "auto", options.target || "zh-CN", reviewer, mergeLines, true) }
          : primaryOptions;
        const seconds = provider === "llm" ? 120 : 30;
        const signal = provider === "llm" ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(seconds * 1000)]);
        const background = provider === "llm" ? gameTranslationRetry(contextForEntry(entry, nameContext, originalContext), retryReason) : {};
        try { const response = await translateGameWithOllama(prepareUnityTranslationRequest(block, mergeLines), { signal }, { ...requestOptions, glossary: terms, provider, ...background, autoFallback: provider === "llm" ? undefined : false, ...((nameContext || retryReason) && canDisableOllamaNameThinking(requestOptions) ? { ollamaReasoningOff: true } : {}) }, textLog); if (!response.ok) throw Object.assign(new Error(response.error || response.code || "翻译请求失败"), { code: response.code });
          return preserveDialogue && !/[\r\n]/.test(block) && /[\r\n]/.test(response.translation)
            ? prepareUnityTranslationText(response.translation) : response.translation; }
        catch (error) { if (!controller.signal.aborted && signal.reason?.name === "TimeoutError") throw new Error(`${requestOptions.model || provider} 请求超过 ${seconds} 秒未响应`); if (provider === "llm" && !controller.signal.aborted) throw new Error(`${requestOptions.model || "大模型"}：${error instanceof Error ? error.message : String(error)}`); throw error; }
      };
      return translateGameDisplayText(text, request, options.skipTargetLanguage ? options.target : "", "auto", terminology,
        !!options.skipTargetLanguage, preserveDialogue);
    };
    const measure = (text: string) => [...prepareUnityTranslationRequest(text, mergeLines)].length;
    const engineTargetCharacters = !layoutOnly && options.provider !== "llm" ? unityTranslationCharacters(selectedEntries, next.entries, unityTranslationError, text => prepareUnityTranslationRequest(text, mergeLines), mergeLines ? canReuseUnityStructuredDraft : undefined, unityTranslationContextKey).pendingCharacters : 0;
    let engineStats: NonNullable<UnityProgress["engineStats"]> = checkpointRef.current?.translationRuns?.text.engineStats || (!checkpointRef.current?.imageOnly && checkpointRef.current?.progress.step === 2 ? checkpointRef.current.progress.engineStats : undefined) || [];
    const initialStats = engineStats;
    let translationProgress: UnityProgress | undefined;
    const reportTranslation = (progress: UnityProgress) => {
      translationProgress = progress;
      onProgress?.(engineStats.length ? { ...progress, engineStats, engineTargetCharacters } : progress);
    };
    const persistTextChanges = async (entries: UnityEntry[]) => {
      if (!entries.length) return;
      publishTranslation({ ...next, entries: [...next.entries] }, "text");
      const rows = entries.map(entry => ({ ...entry }));
      await queueProjectWrite(() => measureGameAsync(promptState.scope + ":text", "saveMs", () =>
        unityRun("save-text-states", { project: { root: next.root, folder: next.folder, entries: rows } })));
    };
    const pool = !layoutOnly && options.provider !== "llm" ? createUnityEnginePool((options.engineIds || [options.provider as TranslateProvider]).map(id => ({ id, enabled: true })), controller.signal, async (id, text) => {
      const translated = await requestTranslation(text, id);
      const problem = unityTranslationError(text, translated); if (problem) throw new Error(problem);
      return translated;
    }, { timingScope: promptState.scope + ":text", initialStats, measure, onStats: value => { engineStats = value; if (translationProgress) onProgress?.({ ...translationProgress, engineStats, engineTargetCharacters }); } }) : null;
    try {
      if (!layoutOnly) {
        if (options.provider === "llm") {
          const connections = [options, options.dialogueOptions, options.nameOptions];
          await prepareGameOllamaModels(connections.flatMap(connection => connection?.llmConcurrency && connection.llmConcurrency > 1
            ? [{ connection, lanes: connection.llmConcurrency }] : []), controller.signal, textLog);
        }
        const prepared = await prepareGameTerms(selectedEntries.filter(entry => !entry.translation || !textTranslationMatchesTarget(entry, options.target) || entry.error || unityTranslationError(entry.source, entry.translation)), next.entries, options.target || "zh-CN", glossary,
        (name, context) => pool ? pool.translate(name) : requestTranslation(name, options.provider, undefined, context), controller.signal,
        (detail, completed, total) => onProgress?.({ detail, completed, total, textStage: "names", model: options.nameOptions?.model || options.model }));
        terminology = prepared.terms;
        termIssues = prepared.issues;
      }
      if (layoutOnly) {
        const total = next.entries.filter(e => e.selected && ids.has(e.id) && /[\r\n]/.test(e.source) && (e.layoutDraft || e.translation && !unityTranslationError(e.source, e.translation))).length;
        let completed = total - selectedEntries.length, failures = 0;
        onProgress?.({ detail: "仅重新断行，未请求重新翻译", textStage: "layout", completed, total });
        for (const entry of selectedEntries) {
          if (controller.signal.aborted) break;
          try {
            const body = await format(entry.source.trim(), entry.layoutDraft!.trim());
            if (controller.signal.aborted) break;
            const value = (entry.source.match(/^[\t \u3000]*/)?.[0] || "") + body;
            const problem = unityTranslationError(entry.source, value); if (problem) throw new Error(problem);
            entry.translation = value; entry.error = ""; delete entry.layoutDraft; completed++;
          } catch (error) {
            if (controller.signal.aborted) throw error;
            entry.error = `译文排版失败：${error instanceof Error ? error.message : String(error)}`;
            failures++;
          }
          await persistTextChanges([entry]);
          onProgress?.({ textStage: "layout", detail: `仅重新断行，未请求重新翻译${failures ? ` · ${failures} 条失败已记录，继续处理` : ""}`, completed: completed + failures, total });
        }
        return next;
      }
      await translateUnitySession(selectedEntries, cache, {
        references: next.entries,
        key: unityTranslationContextKey, targetLanguage: options.target, entryProblem: entry => gameTermProblem(entry.source, termIssues),
        requestGroup: localTextRequestGroup(options, options.dialogueOptions),
        signal: controller.signal, validate: (s, t) => unityTranslationError(s, t) || gameDisplayTextProblem(s, t), progress: reportTranslation,
        onQueue: queue => { translationQueue.current = queue; },
        // Prepare enough rows for batching; the scheduler serializes requests to each local service.
        concurrency: (options.localModel || options.dialogueOptions?.localModel || options.nameOptions?.localModel) ? 8 : options.provider==="llm"?16:pool?.concurrency||1,
        timingScope: promptState.scope + ":text", modelFormats: breakMode === "model" && options.wrapMode !== "natural",
        canReuseDraft: mergeLines ? canReuseUnityStructuredDraft : undefined,
        preserveLayout: options.provider === "llm" || !mergeLines ? gameTextHasSpeaker : undefined, format: mergeLines ? queuedFormat : undefined, retainDraft: mergeLines, persistDraftBeforeFormat: breakMode === "model" || breakMode === "wtp",
        translate: pool ? (text, entry) => pool.translate(text, entry?.id) : (text, entry) => requestTranslation(text, options.provider, entry),
        persist: persistTextChanges,
      });
    } finally {
      pool?.dispose();
      segmenter.dispose();
      const final = { ...next, entries: [...next.entries] };
      await saveTranslation(final, "text");
      setMessage(controller.signal.aborted ? "已停止，已保存译文和排版草稿" : layoutOnly ? "断行处理已保存，未重新翻译；检查排版后可生成补丁" : "本轮翻译已结束，可检查译文后生成补丁");
    }
    return next;
  }
  const imageBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("图片读取失败")); reader.readAsDataURL(blob);
  });
  const imageRequest = (p: UnityProject, image: UnityImage) => ({ root: p.root, folder: p.folder, images: [image] });
  async function writeImage(p: UnityProject, image: UnityImage, blob: Blob) {
    const result=await unityRun<{ path: string; hash: string;cacheErrors?:string[] }>("save-image", { project: imageRequest(p, image), imageId: image.id, imageData: await imageBase64(blob),savedRenderedFile:deploymentController.current?undefined:imageDraftOriginals.current.get(image.id)?.renderedFile??image.renderedFile });if(result.cacheErrors?.length)setActionError("译图已写入，部分旧缓存未能清理："+result.cacheErrors.join("；"));return result;
  }
  async function requestImageTranslation(options: UnityTranslationOptions, provider: string, text: string, parentSignal: AbortSignal, phase?: "translate" | "review") {
    const { imageReviewOptions, ...primary } = options;
    const translate = async (config: ReturnType<typeof buildUnityTranslateOptions>) => {
      const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(provider === "llm" ? 120000 : 30000)]);
      const response = await translateGameWithOllama(text, { signal }, { ...config, provider }, imageLog);
      if (!response.ok) throw Object.assign(new Error(response.error || response.code || "图片文字翻译失败"), { code: response.code });
      return response.translation;
    };
    if (phase === "translate") return translate(primary);
    if (phase === "review") {
      if (!imageReviewOptions) throw new Error("请选择图片译文复核模型");
      return translate(imageReviewOptions);
    }
    let primaryError: unknown;
    try {
      const translated = await translate(primary);
      const issue = gameImageTranslationProblem(text, translated, options.target);
      if (!issue) return translated;
      primaryError = new Error(issue);
    } catch (error) {
      primaryError = error;
    }
    parentSignal.throwIfAborted();
    if (provider !== "llm" || !imageReviewOptions) throw primaryError;
    try {
      const reviewed = await translate(imageReviewOptions);
      const issue = gameImageTranslationProblem(text, reviewed, options.target);
      if (issue) throw new Error(issue);
      return reviewed;
    }
    catch (reviewError) {
      parentSignal.throwIfAborted();
      const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
      throw new Error(`图片初译失败（${describe(primaryError)}），复核重译失败（${describe(reviewError)}）`);
    }
  }

  async function translateImages(p: UnityProject, controller: AbortController, run: RunCheckpoint, onProgress: (value: UnityProgress) => void) {
    if ((p.scanRevision || 0) < 5) throw new Error("当前工程尚未扫描图片，请更新扫描，或跳过步骤 2.2");
    run = { ...run, source: picture.source, target: picture.target, onlySourceLanguage: picture.onlySourceLanguage,
      skipTargetLanguage: picture.skipTargetLanguage, translationKind: picture.kind, engines: picture.engines };
    const phase = run.imageTask || imageTask.current;
    if (phase === "redraw") {
      const images = p.images || [];
      if (!images.some(gameImageRedrawSelected)) return p;
      const scope = promptState.scope + ":images";
      const include = gameImageRegionLanguageFilter(run.source, run.target, run.onlySourceLanguage !== false, run.skipTargetLanguage !== false);
      let next = p;
      try {
        const result = await redrawGameImages(images, run.imageRedrawProfile ?? "turbo", run.target, controller.signal, {
          onStart: setRedrawingId,
          timingScope: scope,
          regions: image => unityImageTranslationRegions(image.regions, run.imageConfidenceThreshold ?? imageConfidenceThreshold, image)
            .filter(region => include(region.text)),
          read: image => readUnitySourceImage(p, image, controller.signal),
          write: (image, blob) => measureGameAsync(scope, "saveMs", () => writeImage(p, image, blob)),
          persist: async image => {
            await queueProjectWrite(() => measureGameAsync(scope, "saveMs", () =>
              unityRun("save-image-states", { project: { root: p.root, folder: p.folder, images: [image] } })));
            next = { ...next, images: (next.images || []).map(previous => previous.id === image.id ? image : previous) };
            publishTranslation(next, "images");
            invalidatePatch();
          },
        }, onProgress, imageLog).finally(() => setRedrawingId(undefined));
        if (result.failed) throw new Error(`${result.failed} / ${result.total} 张重绘失败，失败项仍可重试`);
        imageLog(`AI 风格重绘完成 · ${result.total} 张`, "success");
      } finally {
        if (next !== p) await saveTranslation(next, "images");
      }
      return next;
    }
    if (phase === "filter" || phase === "refine") {
      const signal = controller.signal;
      const scope = promptState.scope + ":images";
      const working = [...(p.images || [])];
      const indexes = new Map(working.map((image, index) => [image.id, index]));
      let current = p, lastPublish = 0;
      const io = {
        read: (image: UnityImage) => measureGameAsync(scope, "processingMs", () => readUnitySourceImage(p, image, signal)),
        persist: async (rows: UnityImage[]) => {
          await queueProjectWrite(() => measureGameAsync(scope, "saveMs", () =>
            unityRun("save-image-states", { project: { root: p.root, folder: p.folder, images: rows } })));
          for (const row of rows) working[indexes.get(row.id)!] = row;
          current = { ...p, images: working };
          if (performance.now() - lastPublish >= 350) {
            lastPublish = performance.now();
            publishTranslation({ ...current, images: working.slice() }, "images");
          }
        },
      };
      try {
        const screening = run.imageScreeningOptions ?? defaultUnityImageScreening;
        if (phase === "filter") {
          const model = screening.filterModel;
          if (model === "") throw new Error("请选择筛选视觉模型");
          const lanes = model ? modelConcurrency(promptState.scope,"screen",model) : localGameImageScreeningLanes(run.imageConcurrency || imageConcurrency);
          if (model) await prepareGameOllamaModels([{ connection: { ...resolveFeatureLlm(settings, model), localModel: !!loadLocalModelProfiles()[model] }, lanes }], signal, imageLog);
          const result = await screenUnityImages(p, signal, { source: run.source, target: run.target,
            concurrency: lanes, timingScope: scope, model, strategy: model ? "full" : screening.strategy },
          { ...io, recognize: model ? blob => recognizeGameImage(settings, model, blob, signal, "screen", promptState.selection, { source: run.source, target: run.target }, imageLog) : undefined }, onProgress,
          (message, fallback) => imageLog(message, fallback ? "warning" : "info"));
          imageLog("筛选完成 · 检测到字 " + result.candidate + " · 待复核 " + result.review + " · 未检测到字 " + result.noText + " · 失败 " + result.failed, result.failed ? "warning" : "success");
          if (result.failed) throw new Error("部分图片筛选失败，已保存结果，可继续");
        } else {
          const refine = screening.refine;
          if (refine.method === "off") return p;
          const selected = working.filter(image => unityImageRefinementPending(image, refine));
          if (!selected.length) { onProgress({ completed: 0, total: 0, detail: "没有待复筛图片" }); return p; }
          let result;
          if (refine.method === "local") result = await refineUnityImagesLocally(p, signal, scope, refine, io, onProgress,
            (message, fallback) => imageLog(message, fallback ? "warning" : "info"));
          else {
            const model = refine.model ?? defaultGameImageVision(gameModels);
            if (!model) throw new Error("请选择复筛视觉模型");
            const lanes = modelConcurrency(promptState.scope, "refine", model);
            await prepareGameOllamaModels([{ connection: { ...resolveFeatureLlm(settings, model), localModel: !!loadLocalModelProfiles()[model] }, lanes }], signal, imageLog);
            result = await refineUnityImages(p, signal, lanes, { ...io,
              recognize: (blob, regions) => recognizeUnityReviewCrops(settings, model, blob, regions, signal, promptState.selection, imageLog, refine.confidence) }, onProgress);
          }
          imageLog("自动复筛完成 · 确认有字 " + result.candidate + " · 未检测到字 " + result.noText + " · 仍有疑问 " + result.review +
            " · 视觉请求 " + result.modelRequests + " · 失败 " + result.failed, result.failed ? "warning" : "success");
          if (result.failed) throw new Error("部分图片复筛失败，已保存结果，可继续");
        }
        return current;
      } finally {
        if (current !== p) await saveTranslation({ ...current, images: working.slice() }, "images");
      }
    }
    if(phase==="recognize"&&run.imageVisionModel!==undefined&&!run.imageVisionModel)throw new Error("请选择识字视觉模型");
    if(phase==="render"&&run.imageLayoutModel!==undefined&&!run.imageLayoutModel)throw new Error("请选择断行排版模型");
    if (!(p.images || []).some(image => image.selected && (phase === "recognize" ? !image.ocrCompleted : image.ocrCompleted && !unityImageWorkDone(image, run.target)))) { onProgress({ completed: 0, total: 0, detail: "图片已完成或没有选中的图片" }); return p; }
    const visionModel = phase === "recognize" ? run.imageVisionModel : undefined;
    const recognitionGroup = visionModel ? (image: UnityImage) => gameImageVisionForAsset(visionModel, image.name, gameModels) : undefined;
    const localMode = run.imageOcrMode || "fast";
    const fastLocalOcr = !visionModel && localMode === "fast";
    const configuredOcrLanes = Math.max(1, Math.min(8, run.imageConcurrency || imageConcurrency));
    const ocrCount = visionModel ? modelConcurrency(promptState.scope, "recognize", visionModel)
      : fastLocalOcr ? localGameImageScreeningLanes(configuredOcrLanes) : configuredOcrLanes;
    const options: UnityTranslationOptions = phase === "translate" || phase === "review" ? await translationOptions(run, true) :
      { provider: "llm", source: run.source, target: run.target, onlySourceLanguage: run.onlySourceLanguage, skipTargetLanguage: run.skipTargetLanguage }, deviceMessages=new Set<string>(),
      ocr=Array.from({length:ocrCount},()=>createUnityImageOcr(localMode,"auto",(message)=>{if(!deviceMessages.has(message)){deviceMessages.add(message);setMessage(message);}}));
    const activeLocalOcr = () => ocr[0].isGpu && !fastLocalOcr ? Math.min(2, ocrCount) : ocrCount;
    const primaryProvider = options.provider; if (!primaryProvider) throw new Error("未选择图片翻译引擎");
    const imageNames = collectGameImageNames(p.entries, root, options.target || run.target, settings.textGlossary);
    const ocrReuse = createGameImageOcrReuse(promptState.scope + ":images");
    const request = (provider: string, text: string) => translateNamedImageText(text,
      input => requestImageTranslation(options, provider, input, controller.signal, phase === "review" ? "review" : "translate"), options.target || "", imageNames);
    const translationLanes = Math.max(options.llmConcurrency || 1, options.imageReviewOptions?.llmConcurrency || 1);
    const layoutLanes = run.imageLayoutModel ? modelConcurrency(promptState.scope, "layout", run.imageLayoutModel) : 1;
    const pool = options.provider !== "llm" && options.engineIds?.length ? createUnityEnginePool(options.engineIds.map(id => ({ id, enabled: true })), controller.signal, request, { timingScope: promptState.scope + ":images" }) : null;
    let current = p;
    const cancelOcr = () => { void Promise.all(ocr.map(engine=>engine.dispose())); }; controller.signal.addEventListener("abort", cancelOcr, { once: true });
    let lastPublish=0;
    try {
      if (visionModel && ocrCount > 1) {
        await prepareGameOllamaModels([{
          connection: { ...resolveFeatureLlm(settings, visionModel), localModel: !!loadLocalModelProfiles()[visionModel] },
          lanes: ocrCount,
        }], controller.signal, imageLog);
      } else if ((phase === "translate" || phase === "review") && primaryProvider === "llm") {
        const connections = [phase === "review" ? options.imageReviewOptions : options].flatMap(connection =>
          connection?.llmConcurrency && connection.llmConcurrency > 1 ? [{ connection, lanes: connection.llmConcurrency }] : []);
        await prepareGameOllamaModels(connections, controller.signal, imageLog);
      }
      if(phase==="recognize"&&run.imageVisionModel===undefined){await ocr[0].prepare();await Promise.all(ocr.slice(1,activeLocalOcr()).map(engine=>engine.prepare()));}
      current = await processUnityImages(p, controller.signal, {
        trackReview: phase === "review",
        timingScope: promptState.scope + ":images",
        concurrency: ocrCount,
        recognitionGroup,
        translationConcurrency: Math.max(translationLanes, layoutLanes), regionConcurrency: translationLanes,
        targetLanguage: options.target,
        includeRegion: phase !== "recognize" ? gameImageRegionLanguageFilter(options.source || "auto", options.target || "zh-CN",
          !!options.onlySourceLanguage, !!options.skipTargetLanguage) : undefined,
        cachedRecognition: phase === "recognize" && !visionModel && localMode === "fast" ?
          image => image.screening?.recognition?.profile === "fast:1280:0.3:false" ? image.screening.recognition.lines : undefined : undefined,
        onTranslationFailures: phase === "translate" && options.imageReviewOptions ?
          count => imageLog(count + " 张图片有待复核的区域，已保存成功译文", "warning") : undefined,
        read: image => measureGameAsync(promptState.scope + ":images", "processingMs", () => readUnitySourceImage(p, image, controller.signal)),
        recognize: (blob, stage, worker = 0, image) => {
          if (!visionModel) return measureGameAsync(promptState.scope + ":images", "ocrMs",
            () => ocr[worker % activeLocalOcr()].recognize(blob, stage));
          const model = gameImageVisionForAsset(visionModel, image?.name || "", gameModels);
          const placement = { assetName: image?.name, cleanBase: image && gameImageCleanBase(image, p.images || [],
            candidate => readUnitySourceImage(p, candidate, controller.signal)) };
          return ocrReuse.read(blob, model, placement, controller.signal, () => ocr[worker % ocr.length].recognizeVision(blob, stage, controller.signal,
            fallback => recognizeGameImage(settings, model, blob, controller.signal, "recognize", promptState.selection,
              { source: run.source, target: run.target, ...placement, names: imageNames }, imageLog, fallback),
            message => imageLog(message, "warning")));
        },
        translate: text => pool ? pool.translate(text) : request(primaryProvider, text), render: (blob,regions,image)=>renderGameImage(settings,run.imageLayoutModel||"",blob,regions,controller.signal,promptState.selection,{source:run.source,target:run.target},(text,level)=>imageLog(`${image.name} · ${text}`,level),{assetName:image.name,cleanBase:gameImageCleanBase(image,p.images||[],candidate=>readUnitySourceImage(p,candidate,controller.signal))}),
        write: (project, image, blob) => measureGameAsync(promptState.scope + ":images", "saveMs", () => writeImage(project, image, blob)),
        persist: async (next, image) => { current = next;if(performance.now()-lastPublish>=100){lastPublish=performance.now();publishTranslation({ ...next, images: [...(next.images || [])] }, "images");} const snapshot = structuredClone(image); await queueProjectWrite(() => measureGameAsync(promptState.scope + ":images", "saveMs", () => unityRun("save-image", { project: imageRequest(next, snapshot), imageId: snapshot.id }))); },
        validate: (source, translated) => gameImageTranslationProblem(source, translated, options.target),
      }, onProgress, run.imageConfidenceThreshold ?? 50, phase === "translate" || phase === "review" ? "translate-only" : phase);
      if (ocrReuse.hits) imageLog(`已复用 ${ocrReuse.hits} 张相同图片的正式识别结果`, "info");
      return current;
    } finally { pool?.dispose(); controller.signal.removeEventListener("abort", cancelOcr); await Promise.all(ocr.map(engine=>engine.dispose())); await saveTranslation(current, "images"); }
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
    const ids = unityLanguageScope(p.entries, run?.source || source, run?.onlySourceLanguage ?? onlySourceLanguage).ids;
    const patchTarget = run?.target ?? target;
    const partial = run?.partial || p.textSkipped;
    const selectedIds = p.entries.filter(entry => entry.selected && ids.has(entry.id) && textTranslationMatchesTarget(entry, patchTarget) &&
      (!partial || !entry.error && entry.translation && !unityTranslationError(entry.source, entry.translation))).map(entry => entry.id);
    const patchImageIds = (p.images || []).filter(image => image.selected && unityImageReadyForTarget(image, picture.target)).map(image => image.id);
    const textEnabled = !excluded.includes("text");
    const fontRequest = { project: p, selectedIds: textEnabled ? selectedIds : [], patchImageIds: excluded.includes("image") ? [] : patchImageIds,
      excludeMosaic: excluded.includes("mosaic"), fontPath: textEnabled ? run?.fontPath ?? fontPath : "", extraCharacters: textEnabled ? run?.extraCharacters ?? extraCharacters : "" };
    let result: UnityPatch & { mosaicImages?: number };
    try {
      result = await measureDeploymentStage(root, "generate",
        () => unityRun<UnityPatch & { mosaicImages?: number }>("export", { ...fontRequest, path: run?.patchFolder || "", deploymentBatch }, onProgress, signal),
        written => written.files);
    }
    catch (error) {
      if (/所选字体缺少/.test(String(error))) {
        const report = JSON.parse(new TextDecoder().decode(await readFileBytes(p.folder + "/font-plan/font-plan.json"))) as UnityFontPlan;
        setFontPlan(report);
      }
      throw error;
    }
    const generated: DeploymentPatch = { ...result, deploymentExcluded: excluded };
    setPatch(generated); setApplied(false); setDirty(false);
    setMessage(`已生成 ${result.files} 个补丁文件 · ${result.entries} 条译文 · ${result.images || 0} 张译图 · ${result.mosaicImages || 0} 张去码图 · ${result.fontReplacements} 个替换字体`);
    return generated;
  }
  async function applyPatch(result: UnityPatch, onProgress?: (value: UnityProgress) => void, signal?: AbortSignal, discardOnStop = false) {
    setBusy("应用到游戏");
    const response = await measureDeploymentStage(root, "apply",
      () => unityRun<{ files?: number; restoredPatches: number }>("apply", { root, path: result.folder, discardOnStop }, progress => {
        if (progress.detail.includes("旧补丁")) logAction(progress.detail, "info", "补丁恢复");
        onProgress?.(progress);
      }, signal),
      applied => applied.files ?? result.files,
    ).catch(async cause => {
      try {
        const [status] = await unityRun<Array<{ installed: boolean }>>("installation-status", { roots: [root] });
        setInstalled(status.installed);
        setApplied(false);
        onInstallationChange?.(root, status.installed);
      } catch (statusError) {
        logAction(`读取补丁恢复状态失败：${String(statusError)}`, "error");
      }
      throw cause;
    });
    setApplied(true); setInstalled(true); onInstallationChange?.(root, true);
    setMessage(`${response.restoredPatches > 0 ? `已卸载 ${response.restoredPatches} 个旧补丁并完成替换。` : ""}已将 ${result.files} 个补丁文件应用到游戏。原件保存在补丁目录的 original 文件夹，实际显示请启动游戏检查。`);
  }
  async function startWorkflow(startStep: number, endStep: number, resume = false, automatic = startStep < endStep, updateScan = false, part?: UnityTranslationPart, imageChain = false) {
    if (importPreviewRef.current) { setActionError("请先应用或取消右侧的导入预览"); return; }
    if (isBenchmarkRunning() || busy || applyingTestConfiguration || imageEditorWork.current || restoring || running.current) return;
    const changedScanOptions = resume && checkpointRef.current?.step === 1
      ? unityScanOptionChanges(checkpointRef.current, { includeCode, textMode, typeDirectory, codeAssemblies }) : [];
    const rescan = (needsScan || updateScan || preparingRescan || changedScanOptions.length > 0) && (resume ? checkpointRef.current?.step ?? startStep : startStep) <= 2;
    if (rescan && !preparingRescan && !await confirm(`重新扫描将保留旧工程，复用原文、原图及定位匹配的译文、图片识别结果和译图；未安装补丁与字库检查会失效，已安装补丁及原件备份保留至再次应用。新工程及复用结果保存完成后清理可移除的旧工程。${scanUpdate.reasons.length ? "\n" + scanUpdate.reasons.join("\n") : ""}${endStep >= 2 ? "扫描完成后再继续翻译。" : ""}`, { title: needsScan ? "需要重新扫描" : "可选更新扫描", kind: "warning", okLabel: "重新扫描并继续", cancelLabel: "取消" })) return;
    setPreparingRescan(false);
    await operation("准备任务", () => runWorkflow(startStep, endStep, resume, automatic, rescan, part, preparingRescan, imageChain), true);
  }
  async function runWorkflow(startStep: number, endStep: number, resume = false, automatic = startStep < endStep, rescan = false, part?: UnityTranslationPart, preparedRescan = false, imageChain = false, deployment?: { parts: UnityTranslationPart[]; finishedParts: Set<UnityTranslationPart>; controller: AbortController }) {
    const controller = deployment?.controller ?? new AbortController(); abort.current = controller;
    let run: RunCheckpoint = resume && checkpointRef.current ? { ...checkpointRef.current, endStep } : {
      step: startStep, endStep, automatic, finished: false, imageOnly: startStep === 2 && (part ? part === "images" : automatic ? textReady : imagePart), imageChain, imageScreeningOptions, imageOcrMode, imageVisionModel, imageLayoutModel, imageRedrawProfile, imageConcurrency, imageConfidenceThreshold,
      projectFolder: startStep === 1 && endStep === 1 ? "" : project?.folder || "", scanFolder: "", patchFolder: "", patch: startStep === 4 ? patch : null,
      previousProjectFolder: startStep === 1 && endStep === 1 ? checkpointRef.current?.previousProjectFolder || project?.folder : undefined,
      translationKind, llmModel, dialogueModel, nameModel, imageModel, imageReviewModel, engine, engines: engineChoices, source, target, joinLines, wrapMode, textScreenModel, includeContext, skipTargetLanguage, onlySourceLanguage, lineMode, lineModel, includeCode, fontPath, textMode, codeAssemblies, typeDirectory, extraCharacters, scopeVersion: 1,
      partial: !!project?.textSkipped || startStep >= 3 && !!checkpointRef.current?.partial,
      translationRuns: checkpointRef.current?.translationRuns,
      scanElapsedMs: startStep === 1 ? 0 : checkpointRef.current?.scanElapsedMs || 0,
      progress: { step: startStep, state: "running", detail: "准备处理", completed: 0, total: null },
    };
    if (automatic) run.automatic = true;
    if (resume && run.step === 1) run.source = source;
    if (part) run.imageOnly = part === "images";
    if (rescan) {
      run = { ...run, step: 1, imageOnly: !!run.imageChain || part === "images", projectFolder: "", scanFolder: "", previousProjectFolder: checkpointRef.current?.previousProjectFolder || project?.folder || checkpointRef.current?.projectFolder || checkpointRef.current?.scanFolder, source, includeCode, textMode, codeAssemblies, typeDirectory,
        translationFailure: run.progress.step === 2 && run.progress.state === "error" ? run.progress.failure : run.translationFailure,
        progress: { step: 1, state: "running", detail: "重新提取游戏组件文本，已有工程和译文保留", completed: 0, total: null } };
      run.scanElapsedMs = 0;
    }
    let lastReported = 0;
    const report = (progress: UnityProgress) => {
      const urgent = run.progress.step !== run.step || !!progress.folder && progress.folder !== (run.step === 1 ? run.scanFolder : run.patchFolder) || progress.total !== null && progress.completed === progress.total;
      if (progress.total === null && run.progress.step === run.step && run.progress.total !== null)
        progress = { ...progress, completed: run.progress.completed, total: run.progress.total };
      if (progress.folder) {
        if (run.step === 1) run.scanFolder = progress.folder;
        if (run.step === 3) run.patchFolder = progress.folder;
      }
      run = { ...run, progress: { ...progress, step: run.step, state: "running" } };
      checkpointRef.current = run;
      if (urgent || performance.now() - lastReported >= 100) { remember(run); lastReported = performance.now(); }
    };
    try {
      followProgress.current = !deployment;
      if (rescan && project && !preparedRescan) {
        if (dirty) await save();
        await taskWrites.current;
        await unityRun("reset-step", { root, step: 3, path: project.folder, task: { ...(checkpointRef.current || projectCheckpoint(project)), previousProjectFolder: undefined } });
        setPatch(null); setFontPlan(null);
        run.patch = null; run.patchFolder = "";
      }
      remember(run);
      let p = latest.current || project;
      for (let index = run.step; index <= endStep; index++) {
        if (followProgress.current) { setActiveStep(index); if (index === 2) setImagePart(!!run.imageOnly); }
        run.step = index; if (!deployment) setBusy(GENERATION_STEPS[index - 1]);
        if (index === 2) delete run.translationFailure;
        const onProgress = (progress: UnityProgress) => { if (run.step === index && !run.finished) report(progress); };
        report({ detail: `准备${GENERATION_STEPS[index - 1]}`, completed: 0, total: null });
        await taskWrites.current;
        if (controller.signal.aborted) throw new UnityPaused("");
        if (index === 1) {
          const reuse = run.projectFolder && !run.scanFolder && p;
          if (reuse) p = reuse;
          else {
            const started = performance.now(), elapsed = run.scanElapsedMs || 0;
            const tick = () => { run = { ...run, scanElapsedMs: elapsed + performance.now() - started }; remember(run); };
            const timer = setInterval(tick, 1000);
            try { p = await scan(onProgress, controller.signal, run); }
            finally { clearInterval(timer); tick(); }
          }
          const previousFolder = run.previousProjectFolder;
          run.projectFolder = p.folder; run.scanFolder = "";
          if (previousFolder && !sameUnityGamePath(previousFolder, p.folder)) {
            remember(run); await taskWrites.current;
            const reused = await unityRun<{ project: UnityProject; reusedText: number; reusedImages: number }>("finish-rescan", { root, path: previousFolder, task: { ...run, previousProjectFolder: undefined } }, onProgress);
            p = reused.project; publish(p); setMessage(`扫描完成：复用 ${reused.reusedText} 条译文和 ${reused.reusedImages} 张图片的处理结果`);
          }
          run.previousProjectFolder = undefined;
          if (reuse) report({ detail: `复用当前工程：${p.entries.length} 条文本，保留选取和已有译文`, completed: 1, total: 1 });
        } else if (index === 2) {
          if (!p) throw new Error("请先扫描当前游戏资源");
          await yieldUnityPreparation(controller.signal);
          const preparationScope = unityLanguageScope(p.entries, run.source, run.onlySourceLanguage !== false);
          const rows = p.entries.filter(entry => entry.selected && preparationScope.ids.has(entry.id));
          const live = unityTranslationReadiness(p, rows, unityTranslationError, false, run.target, picture.target);
          const textComplete = !run.layoutOnly && live.textReady;
          const screening = run.imageScreeningOptions ?? defaultUnityImageScreening;
          const imageComplete = live.imagesReady && !(p.images || []).some(image =>
            needsUnityImageScreening(image, picture.source, picture.target, screening) || unityImageRefinementPending(image, screening.refine) ||
            gameImageRedrawSelected(image));
          const initial = { text: p.textSkipped && !run.layoutOnly ? "skipped" : textComplete ? "done" : "pending", images: p.imagesSkipped ? "skipped" : imageComplete ? "done" : "pending" } as const;
          const oldParts = run.translationRuns;
          const requestedParts: UnityTranslationPart[] = deployment?.parts ??
            (automatic && !run.layoutOnly ? ["text", "images"] : [part || (run.imageOnly ? "images" : "text")]);
          run = { ...run, translationRuns: {
            text: !automatic && !requestedParts.includes("text") && oldParts?.text ? oldParts.text : { ...(oldParts?.text || run.progress), step: 2, state: initial.text, detail: textComplete ? "文本结果已保留" : "等待开始翻译文本" },
            images: !automatic && !requestedParts.includes("images") && oldParts?.images ? oldParts.images : { ...(oldParts?.images || { completed: 0, total: null }), step: 2, state: initial.images, detail: imageComplete ? "图片结果已保留" : "等待开始图片翻译" },
          }, progress: { step: 2, state: "running", completed: 0, total: null, detail: "文本和图片任务分别处理并保存" } };
          const partReported = { text: 0, images: 0 };
          const reportPart = (part: UnityTranslationPart, value: UnityProgress) => {
            const scope = promptState.scope + ":" + part;
            const phase = part === "text" ? value.textStage === "screening" ? "screen" : "translate" : run.imageTask || imageTask.current;
            const alreadyComplete = value.total === 0 && !!stepPerformance(scope,phase).endedAt;
            if (!alreadyComplete) beginGameStep(scope, phase);
            if (!alreadyComplete && value.translation)
              reportGameStepItems(scope, phase, value.translation.processed, value.translation.failed);
            else if (!alreadyComplete && value.total !== null && (part === "images" || phase === "screen"))
              reportGameStepItems(scope, phase, value.completed, value.redrawFailed);
            run = { ...run, translationRuns: { ...run.translationRuns!, [part]: { ...run.translationRuns![part], ...value,
              elapsedMs: run.translationRuns![part].elapsedMs, textStage: value.textStage, model: value.model,
              redrawFailed: value.redrawFailed, step: 2, state: "running" } } };
            checkpointRef.current = run;
            if (value.total !== null && value.completed === value.total || performance.now() - partReported[part] >= 100) { remember(run); partReported[part] = performance.now(); }
          };
          const jobs = createUnityTranslationJobs({
            signal: controller.signal, initial,
            changed: (part, state, failure) => {
              if (state === "done" || state === "skipped") completeGameStep(promptState.scope + ":" + part, part === "text" ? "translate" : run.imageTask || imageTask.current);
              const previous = run.translationRuns![part];
              run = { ...run, translationRuns: { ...run.translationRuns!, [part]: { ...previous, state, failure, detail: state === "stopped" ? "已中止，进度已保存" : state === "skipped" ? "已跳过剩余内容，已完成结果保留" : previous.detail } } }; remember(run);
            },
            run: async (part, job) => {
              const started = performance.now(), previousElapsed = run.translationRuns![part].elapsedMs || 0;
              const tick = () => { run = { ...run, translationRuns: { ...run.translationRuns!, [part]: { ...run.translationRuns![part], elapsedMs: previousElapsed + performance.now() - started } } }; remember(run); };
              const timer = setInterval(tick, 1000);
              try {
              const current = latest.current || p!;
              if (part === "images") {
                run.imageTask = resume && run.imageTask ? run.imageTask : imageTask.current;
                if (run.automatic || run.imageChain) {
                  const firstPhase = resume ? Math.max(0,unityImagePhases.indexOf(run.imageTask)) : 0;
                  for (const phase of unityImagePhases.slice(firstPhase)) {
                    job.signal.throwIfAborted();
                    if (phase === "redraw" && !(latest.current || current).images?.some(gameImageRedrawSelected)) continue;
                    run.imageTask = phase; imageTask.current = phase;
                    if (await imageConfigurationCommit.current?.(phase) === false) throw new Error(unityImagePhaseNames[phase] + "配置保存失败");
                    job.signal.throwIfAborted();
                    const latestConfig = execution.current;
                    await latestConfig.translateImages(latest.current || current, job, { ...run, ...latestConfig.parameters }, value => reportPart(part, value));
                    completeGameStep(promptState.scope + ":images", phase);
                  }
                } else await execution.current.translateImages(current, job, { ...run, ...execution.current.parameters, imageConfidenceThreshold: imageThreshold.current, imageOcrMode: imageMode.current }, value => reportPart(part, value));
                return;
              }
              const selectedIds = unityLanguageScope(current.entries, run.source, run.onlySourceLanguage !== false).ids;
              if (current.entries.length && !current.entries.some(entry => entry.selected && selectedIds.has(entry.id))) throw new Error("当前原文语言范围内没有所选文本，请调整语言或选取文本");
              let textProject = current;
              if ((run.automatic || deployment) && !run.layoutOnly && !textScreened) {
                if (await textConfigurationCommit.current?.("screen") === false) throw new Error("文本筛选配置保存失败");
                const latestConfig = execution.current;
                textProject = { ...current, entries: current.entries.map(entry => ({ ...entry })) };
                const rows = textProject.entries.filter(entry => entry.selected && selectedIds.has(entry.id));
                await screenGameText(rows, {
                  settings, model: latestConfig.parameters.textScreenModel, prompts: latestConfig.prompts, source: run.onlySourceLanguage === false ? "auto" : run.source,
                  target: run.target, skipTarget: run.skipTargetLanguage !== false, signal: job.signal, onOllamaStatus: logAction,
                  onProgress: (completed, total) => reportPart(part, { completed, total, detail: run.textScreenModel === undefined ? "正在按语言规则筛选文本" : "正在用大模型筛选文本", textStage: "screening", model: run.textScreenModel }),
                });
                job.signal.throwIfAborted();
                await saveTranslation(textProject, "text");
                setTextScreened(true);
              }
              const retryIds = retryFailureIds.current; retryFailureIds.current = undefined;
              if (textProject.entries.length) {
                if (run.automatic && await textConfigurationCommit.current?.("translate") === false) throw new Error("正文翻译配置保存失败");
                const latestConfig = execution.current;
                const options = run.automatic || deployment ? { ...run, ...latestConfig.parameters } : run;
                await latestConfig.translateProject(textProject, job, options.layoutOnly && options.translationKind !== "local"
                  ? { provider: "llm", source: options.source, target: options.target } : await latestConfig.translationOptions(options),
                  value => reportPart(part, value), options.source, options.joinLines ?? true, options.lineMode || "local", options.lineModel || "", !!options.layoutOnly, retryIds);
              }
              const final = latest.current || current;
              const failed = final.entries.filter(entry => (retryIds ? retryIds.has(entry.id) : entry.selected && selectedIds.has(entry.id)) && (!run.layoutOnly || !!entry.layoutDraft) && (entry.error || unityTranslationError(entry.source, entry.translation)));
              if (failed.length) throw new Error(`${failed.length} 条文本翻译或排版未完成，已有译文和草稿已保存`);
              } finally { finishGameStep(promptState.scope + ":" + part); clearInterval(timer); tick(); }
            },
          });
          translationJobs.current = jobs; remember(run);
          try { await jobs.wait(requestedParts); }
          finally {
            if (deployment) {
              for (const part of requestedParts) {
                const state = jobs.state(part);
                if (state === "done" || state === "skipped") deployment.finishedParts.add(part);
              }
            }
            translationJobs.current = null; await projectWrites.current;
          }
          p = latest.current || p;
          if (automatic && !unityTranslationReadiness(p, [], unityTranslationError, false, run.target, picture.target).imagesReady) {
            run.endStep = 2; run.automatic = false; run.progress = { ...run.progress, step: 2, state: "done", detail: "图片识别结果已保存" };
            if (followProgress.current) { setActiveStep(2); setImagePart(true); }
            break;
          }
        } else if (index === 3) {
          if (!p) throw new Error("请先扫描当前游戏资源");
          const result = await exportPatch(p, onProgress, controller.signal, run);
          run.patch = result; run.patchFolder = result.folder;
        } else {
          if (!run.patch) throw new Error("请先生成补丁");
          await applyPatch(run.patch, onProgress, controller.signal);
        }
        if (controller.signal.aborted) throw new UnityPaused("");
        if (followProgress.current) {
          if (index === 2 && (run.imageOnly || (!run.layoutOnly && !automatic && !unityTranslationReadiness(p, [], unityTranslationError, false, run.target, picture.target).imagesReady))) {
            setActiveStep(2);
            setImagePart(true);
          } else setActiveStep(run.layoutOnly ? 2 : Math.min(index + 1, GENERATION_STEPS.length));
        }
        if (index < endStep) { run.step = index + 1; run.progress = { step: index + 1, state: "running", detail: "等待开始下一步", completed: 0, total: null }; remember(run); }
      }
      run.finished = true; run.progress = { ...run.progress, state: "done" }; remember(run);
    } catch (e) {
      if (deployment) throw e;
      const paused = e instanceof UnityPaused ? e : e instanceof UnityTranslationStopped ? new UnityPaused("") : null;
      if (paused || controller.signal.aborted) {
        if (paused?.folder) {
          if (run.step === 1) { run.scanFolder = paused.folder; run.projectFolder = paused.folder; }
          if (run.step === 3) run.patchFolder = paused.folder;
        }
        run.progress = { ...run.progress, state: "stopped", detail: "处理已中止，检查点已保存" }; remember(run);
        if (run.step === 1 && run.scanFolder) publish(await loadProject(run.scanFolder, run.previousProjectFolder));
        setMessage(run.step === 4 ? "应用已中止，部分文件可能已写入。请勿启动游戏，恢复后继续应用。原件备份已保留。" : "任务已中止，检查点已保存，点击恢复继续未完成部分。");
      } else { run.progress = { ...run.progress, state: "error", failure: e instanceof Error ? e.message : String(e) }; remember(run); throw e; }
    } finally { abort.current = null; await taskWrites.current; }
  }
  const startTranslationPart = (part: UnityTranslationPart, phase?: UnityImagePhase) => {
    if (mosaicBusy) return;
    setLocalActivity(null); logAction(part === "text" ? "开始翻译文本" : "开始" + unityImagePhaseNames[phase || imageTask.current]);
    if(part==="images"&&imageEditorWork.current)return;
    if (phase) imageTask.current = phase;
    const jobs = translationJobs.current;
    if (jobs) { jobs.start(part, part === "images" && !!phase); return; }
    void startWorkflow(2, checkpoint?.automatic && !checkpoint.finished ? checkpoint.endStep : 2, !!checkpoint && !checkpoint.finished, !!checkpoint?.automatic && !checkpoint.finished, false, part);
  };
  const stop = () => {
    logAction("请求中止当前任务", "warning");
    abort.current?.abort();imageEditorAbort.current?.abort();
    setMessage("正在中止，完成当前文件的安全写入并保存检查点后停止，请勿退出或启动游戏。");
  };
  const progressPercent = generation?.total ? Math.floor(generation.completed / generation.total * 100) : generation?.state === "done" && generation.total === 0 ? 100 : null;
  const progressIsImage = generation?.step === 2 && (localActivity && generation === localActivity.value ? localActivity.images : activeStep === 2 && checkpoint?.translationRuns ? imagePart : !!checkpoint?.imageOnly);
  const progressUnit = generation?.step === 2 ? progressIsImage ? "张图片" : checkpoint?.layoutOnly ? "处文本" : generation.translation ? "种原文（已检查）" : "种原文（已有译文）" : "个文件";
  const resumable = !preparingRescan && !!checkpoint && !checkpoint.finished;
  const pausedScan = checkpoint?.step === 1 && !checkpoint.finished && (checkpoint.progress.state === "stopped" || checkpoint.progress.state === "error");
  const scanOptionsChanged = !!pausedScan && unityScanOptionChanges(checkpoint!, { includeCode, textMode, typeDirectory, codeAssemblies }).length > 0;
  const locked = !!busy || restoring || resumable || saving || applyingTestConfiguration || !!importPreview;
  const entriesLocked = !!busy || restoring || saving || resumable && (checkpoint.step !== 2 || !!checkpoint.imageOnly);
  const resumeTask = () => checkpoint && void startWorkflow(checkpoint.step, checkpoint.endStep, true, checkpoint.automatic);
  async function skipRemaining() { await skipTranslationPart(!!checkpoint?.imageOnly); }

  const currentPart: UnityTranslationPart = imagePart ? "images" : "text";
  const selectedJob = currentParts?.[currentPart];
  const stopPart = (part: UnityTranslationPart) => {
    translationJobs.current?.stop(part);
    setMessage(part === "images" ? "正在中止图片处理，已保存的结果会保留。" : "正在中止文本处理，已保存的结果会保留。");
  };
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
  const screenCurrentText = () => operation("筛选文本", async () => {
    if (!latest.current) return;
    const controller = new AbortController(); abort.current = controller; setTextScreening(true); setTextScreenStarted(true); setTextScreenPaused(false);
    beginGameStep(promptState.scope + ":text", "screen");
    try {
      await yieldUnityPreparation(controller.signal);
      const next = { ...latest.current, entries: latest.current.entries.map(entry => ({ ...entry })) };
      const ids = unityLanguageScope(next.entries, source, onlySourceLanguage).ids;
      const rows = next.entries.filter(entry => entry.selected && ids.has(entry.id));
      const kept = await screenGameText(rows, {
        settings, model: textScreenModel, prompts: promptState.selection, source: onlySourceLanguage ? source : "auto",
        target, skipTarget: skipTargetLanguage, signal: controller.signal, onOllamaStatus: logAction,
        onProgress: (completed, total) => {
          reportGameStepItems(promptState.scope + ":text", "screen", completed);
          showLocalActivity("正在用大模型筛选文本", "running", false, completed, total);
        },
      });
      controller.signal.throwIfAborted(); await saveTranslation(next, "text"); controller.signal.throwIfAborted(); setTextScreened(true);
      finishGameStep(promptState.scope + ":text", true);
      setMessage(`筛选完成，${kept} 条目标语言文本原样保留，可开始翻译`);
    } catch (error) { if (!controller.signal.aborted) throw error; setTextScreenPaused(true); setMessage("文本筛选已中止"); }
    finally { finishGameStep(promptState.scope + ":text"); abort.current = null; setTextScreening(false); }
  });
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
      const controller = new AbortController(); abort.current = controller;
      const previous = checkpointRef.current;
      const task = { ...(previous || projectCheckpoint(p)), step: 2, endStep: 2, automatic: false, finished: false, layoutOnly: false, imageOnly: false, patch: null, patchFolder: "" };
      const rememberTextRetry = (value: RunCheckpoint) => remember({ ...value, translationRuns: value.translationRuns ? { ...value.translationRuns, text: value.progress } : undefined });
      let lastProgress: UnityProgress = { detail: `正在重试条目 #${id}`, completed: 0, total: null };
      const report = (progress: UnityProgress) => {
        const current = latest.current || p;
        const stats = unityTranslationStats(current.entries.filter(entry => entry.selected && scope.ids.has(entry.id)), unityTranslationError, unityTranslationContextKey);
        lastProgress = { ...progress, ...stats, completed: Math.min(stats.total, Math.max(stats.completed, previous?.step === 2 ? previous.progress.completed : 0)), translation: progress.translation && { ...progress.translation, successful: stats.completed } };
        rememberTextRetry({ ...task, progress: { ...lastProgress, step: 2, state: "running" } });
      };
      try {
        const next = await translateProject(p, controller, await translationOptions(), report, source, joinLines, lineMode, lineModel, false, new Set([id]));
          controller.signal.throwIfAborted();
        const retried = next.entries.find(entry => entry.id === id)!;
        const problem = retried.error || unityTranslationError(retried.source, retried.translation);
        const remaining = next.entries.filter(entry => entry.selected && scope.ids.has(entry.id) && (entry.error || unityTranslationError(entry.source, entry.translation))).length;
        const detail = problem ? `条目 #${id} 重试失败：${problem}` : `条目 #${id} 重试成功${remaining ? `，另有 ${remaining} 条未完成` : ""}`;
        rememberTextRetry({ ...task, finished: !problem && !remaining, progress: { ...lastProgress, step: 2, state: problem ? "error" : remaining ? "stopped" : "done", failure: problem || undefined, detail } });
        if (problem) setError(detail); else { setRowIssue(null); setMessage(detail); }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        const detail = `已中止条目 #${id} 的重试，已有译文和草稿保留`;
        rememberTextRetry({ ...task, progress: { ...lastProgress, step: 2, state: "stopped", detail } }); setMessage(detail);
      } finally { abort.current = null; }
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
  const mosaicStorage = mosaicIndex && {
    index: mosaicIndex,
    read: async (image: UnityImage, signal: AbortSignal) => {
      const result = await unityRun<{ data: string }>("mosaic-preview", { ...mosaicRequest, imageId: image.id }, undefined, signal);
      return new Blob([Uint8Array.from(atob(result.data), c => c.charCodeAt(0))], { type: "image/png" });
    },
    save: async (image: UnityImage, blob: Blob, signal: AbortSignal) => {
      const result = await unityRun<{ candidates: MosaicCandidateIndex }>("mosaic-save",
        { ...mosaicRequest, imageId: image.id, imageSourceHash: image.sourceHash, imageData: await imageBase64(blob) }, undefined, signal);
      setMosaicStatus({ root, candidates: result.candidates });
      if (result.candidates[image.id]?.included) invalidatePatch();
    },
    select: async (images: UnityImage[], include: boolean, signal: AbortSignal) => {
      const result = await unityRun<{ candidates: MosaicCandidateIndex }>("mosaic-select",
        { ...mosaicRequest, selectedIds: images.map(image => image.id), includeMosaic: include }, undefined, signal);
      setMosaicStatus({ root, candidates: result.candidates });
      invalidatePatch();
    },
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
  const uninstallPatch = async () => {
    if (!installed || locked || !await confirm("卸载嵌字翻译补丁并恢复游戏原件？工程、译文、补丁及原件备份会保留。请先关闭游戏。", { title: "卸载补丁", kind: "warning", okLabel: "卸载补丁", cancelLabel: "取消" })) return;
    await operation("卸载补丁", async () => {
      await taskWrites.current;
      const workspace = await unityRun<UnityWorkspace<RunCheckpoint>>("uninstall", { root }, progress => { setMessage(progress.detail); showLocalActivity(progress.detail, "running", imagePart, progress.completed, progress.total); });
      const p = workspace.saved.project;
      if (p?.images) p.images = p.images.map(normalizeUnityImageSelection);
      latest.current = p; setProject(p);
      checkpointRef.current = workspace.task; setCheckpoint(workspace.task); queuedSignature.current = "";
      setPatch(null); setInstalled(workspace.installed); setApplied(false); onInstallationChange?.(root, workspace.installed);
      setGeneration(null); setDirty(false); setActiveStep(3);
      setMessage("补丁已卸载，游戏原件已恢复；工程、译文和备份已保留。");
    });
  };
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
  };
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
  const sharedLanguageLocked = !!busy || textScreening || restoring || saving || applyingTestConfiguration || !scanReady || !!importPreview;
  const flowConfigComplete = imagePart ? flowConfig === "filter" ? !imagesNeedScreen : flowConfig === "refine" ? !imagesNeedRefine :
    flowConfig === "recognize" ? !imagesNeedRecognition : flowConfig === "translate" || flowConfig === "review" ? imageTextDone : imagesReady :
    flowConfig === "screen" ? screenComplete : textReady;
  const flowConfigLocked = restoring || saving || applyingTestConfiguration || !scanReady || !!importPreview ||
    (!!busy || textScreening) && (flowConfigComplete || flowProgressState === "running" && flowConfig === runningFlowStep);

  const prompt = (scene: keyof typeof promptState.selection) => promptState.selection[scene] || "builtin:" + scene;
  const sharedConfiguration = [translationKind, target, skipTargetLanguage,
    translationKind === "engine" ? engineChoices : includeContext];
  const textModels = translationKind !== "engine" ? [llmModel, prompt("text"), dialogueModel, prompt("dialogue"), nameModel, prompt("names")] : [];
  const imageModels = translationKind !== "engine" ? [imageModel, prompt("image"), imageReviewModel, prompt("review")] : [];
  const configuration = imagePart ? {
    filter: JSON.stringify([source, onlySourceLanguage, target, skipTargetLanguage, imageConcurrency, imageScreeningOptions.strategy, imageScreeningOptions.filterModel, prompt("screen")]),
    refine: JSON.stringify([imageRefine, imageRefineModel, prompt("refine")]),
    review: JSON.stringify([imageReviewModel, prompt("review")]),
    render: JSON.stringify([imageLayoutModel, prompt("layout")]),
    redraw: JSON.stringify(imageRedrawProfile),
    recognize: JSON.stringify(imageVisionModel === undefined
      ? [imageOcrMode, imageConcurrency, imageConfidenceThreshold] : [imageVisionModel, prompt("recognize"), imageOcrMode === "manga"]),
    translate: JSON.stringify([...sharedConfiguration, ...imageModels, imageLayoutModel,
      imageLayoutModel !== undefined ? prompt("layout") : null]),
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
  const progressTitle = activeStep === 2
    ? imagePart ? unityImagePhaseNames[imageTask.current]
      : visibleGeneration?.textStage ? gameTextStageLabels[visibleGeneration.textStage]
      : textScreening || !screenComplete ? "筛选文本" : "翻译正文"
    : GENERATION_STEPS[(activeStep === 3 ? visibleGeneration?.step ?? (patch ? 4 : 3) : activeStep) - 1];
  const scanTiming = activeStep === 1 && progressState === "done" ? project?.scanMetrics : undefined;
  const scanThroughput = activeStep === 1 && progressState === "done" && project
    ? formatFlowThroughput(stepPerformance(deploymentMetricScope(root, "scan"), "scan"), "个") ??
      formatFlowThroughput(scanTiming && { itemsDone: scanTiming.parsed + scanTiming.reused, elapsedMs: scanTiming.totalMs }, "个")
    : undefined;
  const deploymentPhase = activeStep === 3 ? (visibleGeneration?.step === 4 || !visibleGeneration && applied ? "apply" : "generate") : undefined;
  const deploymentElapsed = deploymentPhase
    ? stepPerformance(deploymentMetricScope(root,deploymentPhase),deploymentPhase).elapsedMs : undefined;
  const elapsed = (activeStep === 1 ? checkpoint?.scanElapsedMs || scanTiming?.totalMs
    : activeStep === 3 ? deploymentElapsed : visibleGeneration?.elapsedMs) ?? 0;
  const elapsedLabel = [3600000, 60000, 1000].map((unit, index) => {
    const count = Math.floor(elapsed / unit);
    return String(index ? count % 60 : count).padStart(2, "0");
  }).join(":");
  const taskDetail = progressState === "running" || progressState === "stopped" ? visibleGeneration?.detail : undefined;
  const scanResource = activeStep === 1
    ? taskDetail?.match(/^读取资源对象：(.+) · 对象 (\d+) \/ (\d+) · 已提取 (\d+) 条文本$/)
    : undefined;
  const scanBusy = activeStep === 1 && progressState === "running";
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
  const progressContent = <GameStepProgress title={progressTitle} state={progressState} elapsed={elapsedLabel}
    label={redrawSummary?.label}
    percent={redrawSummary?.percent ?? (visibleGeneration && showProgressCount ? progressPercent : undefined)}
    count={redrawSummary?.count ?? (showProgressCount && visibleGeneration?.total ? `${visibleGeneration.completed} / ${visibleGeneration.total} ${progressUnit}` : undefined)}
    actions={<>
      {activeStep !== 2 && !(activeStep === 3 && busy) && taskAction}
      {activeStep === 1 && !busy && !restoring && <button className="unity-btn unity-btn-primary" disabled={testing || !root || !output} title={testTitle}
        onClick={() => void (preparingRescan ? startWorkflow(1, 1, false, false, true) : scanStarted ? restartStage(1) : startWorkflow(1, 1))}>
        {!preparingRescan && scanStarted ? "重新扫描资源" : "开始扫描"}
      </button>}
      {activeStep === 1 && project && !busy && !restoring && !saving && <button type="button" className="unity-btn unity-btn-warning" onClick={() => void clearResourceScan()}>清理扫描</button>}
      {imageEditorBusy && <button className="unity-btn" onClick={() => imageEditorAbort.current?.abort()}>停止处理</button>}
      {generation && !viewingProgress && <button className="unity-btn" onClick={() => { setActiveStep(generation.step); setImagePart(!!checkpoint?.imageOnly); }}>查看进度</button>}
    </>}>
    {activeStep === 2 && imagePart && readiness.manualReviewImages > 0 && !readiness.imagesSkipped &&
      <p className="unity-task-detail">待人工确认 {readiness.manualReviewImages} 张。请在右侧分组处理，或跳过剩余内容。</p>}
    {scanResource ? <div className="unity-scan-current-resource">
      <span className="unity-scan-resource-path" data-tooltip={scanResource[1]}>{scanResource[1]}</span>
      <div className="unity-scan-resource-metrics"><span>对象 <b>{scanResource[2]}</b> / {scanResource[3]}</span><span>已提取 <b>{scanResource[4]}</b> 条文本</span></div>
      <GameProgressBar label="当前文件的对象进度" value={Math.min(100, Math.floor(Number(scanResource[2]) / Math.max(1, Number(scanResource[3])) * 100))} />
    </div> : taskDetail && (activeStep !== 2 || imagePart) && <p className="unity-task-detail">{taskDetail}</p>}
    {scanThroughput && <p className="game-flow-stage-throughput">扫描吞吐 <b>{scanThroughput}</b></p>}
    {scanTiming && <details className="unity-task-detail">
      <summary>扫描计时 · 重新解析 {scanTiming.parsed} 个 · 复用 {scanTiming.reused} 个</summary>
      <p>{([
        ["准备与列目录", scanTiming.prepareMs], ["校验文件与依赖", scanTiming.checkMs], ["打开资源与读取索引", scanTiming.openMs],
        ["解析字段和文本", scanTiming.parseMs], ["图片解码与编码", scanTiming.decodeMs], ["复用索引和原图", scanTiming.reuseMs],
        ["恢复译文和图片结果", scanTiming.restoreMs], ["保存工程", scanTiming.saveMs], ["其他扫描操作", scanTiming.otherMs],
      ] as const).map(([label, ms]) => `${label} ${(ms / 1000).toFixed(2)} 秒`).join(" · ")}</p>
    </details>}
    {activeStep === 2 && !imagePart && !progressIsImage && generation?.step === 2 &&
      <UnityTranslationProgress progress={generation} running={progressRunning} failure={generation.state === "error" ? generation.failure || generation.detail : undefined}
        onLocate={locateTranslationFailure} />}
  </GameStepProgress>;
  const deploymentPlan = useMemo(() => deploymentPlanState?.root === root ? deploymentPlanState.plan : loadDeploymentPlan(root), [deploymentPlanState, root]);
  const patchScope = checkpoint?.patch?.deploymentExcluded ?? [];
  const deploymentValidation = useMemo(() => validateDeploymentPlan(deploymentPlan), [deploymentPlan]);
  const disabledPhases = deploymentPhases.filter(id => deploymentPlan.disabled.includes(id));
  const activePatch = patch && disabledPhases.every(id => patchScope.includes(id)) ? patch : null;
  const fullPatch = !!activePatch && patchScope.length === disabledPhases.length;
  const currentStoppedStep = deploymentStop?.root === root ? deploymentStop.step : null;
  const patchImages = (project?.images || []).filter(image => image.selected && unityImageReadyForTarget(image, picture.target));
  const mosaicCount = (project?.images || []).filter(image => {
    const candidate = mosaicIndex?.[image.id];
    return !!image.sourceFile && !!candidate?.included && candidate.source === image.sourceHash;
  }).length;
  const deploymentCompleted: DeploymentStep[] = [
    ...(scanReady ? ["scan" as const] : []),
    ...(textReady ? ["text" as const] : []),
    ...(imagesReady ? ["image" as const] : []),
    ...(project && mosaicCompleted === project.folder ? ["mosaic" as const] : []),
    ...(applied && fullPatch ? ["apply" as const] : []),
  ];
  const enabledPhases = deploymentPhases.filter(id => !deploymentPlan.disabled.includes(id));
  const eligibleTextIds = unityLanguageScope(project?.entries || [], source, onlySourceLanguage).ids;
  const textCount = project?.entries.filter(entry => entry.selected && eligibleTextIds.has(entry.id) && !entry.error && entry.translation && textTranslationMatchesTarget(entry, target)).length || 0;
  const scopedPatchReady = scanReady && (enabledPhases.includes("text") && textReady && textCount > 0 ||
    enabledPhases.includes("image") && imagesReady && patchImages.length > 0 ||
    enabledPhases.includes("mosaic") && mosaicCount > 0);
  const deploymentPercent = generation && generation.total ? Math.min(100, Math.round((generation.completed / generation.total) * 100)) : null;

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
    const { candidates } = await unityRun<{ candidates: MosaicCandidateIndex }>("mosaic-status", { root });
    const preferences = readMosaicSettings(root);
    const usable = (current.images || []).filter(image => image.sourceFile && image.width > 0 && image.height > 0 &&
      candidates[image.id]?.source !== image.sourceHash);
    const batch = crypto.randomUUID().replaceAll("-", "");
    const request = { root, path: current.folder, deploymentBatch: batch };
    const scenes = usable.filter(image => /(?:^|[\\/])img[\\/]pictures[\\/]/i.test(image.file));
    const images = preferences.scope === "scenes" && scenes.length ? scenes : usable;
    const scope = deploymentMetricScope(root, "mosaic");
    const selections = gameStepSelections(scope, "mosaic");
    let failed = 0;
    const reviews=preferences.refine!==false ? await refineMosaicBatch(images,{
      root,settings:{...preferences,refineScope:preferences.refineIncludeMissed?"all":"suspected"},signal,modelFile:gameDetectorFile(root),read:readMosaicSource,prepare:prepareMosaicSources,
      timingScope: scope,
      request:(model,prompt,image,signal,lanes)=>requestGameModelJson(settings,model,prompt,signal,image,"game-images",undefined,{role:"mosaic",selection:selections(lanes)}),
      onError: () => { failed++; },
      onProgress:(completed,detail)=>report({completed,total:images.length,detail})
    }) : undefined;
    if (reviews?.failed) {
      reportGameStepItems(scope, "mosaic", reviews.results.size + failed, failed);
      throw new Error(reviews.failed + " 张图片复筛失败");
    }
    const detector = reviews ? undefined : await openDeploymentDetector(root, preferences, signal, scope);
    let committed = false;
    try {
      for (const [index, image] of images.entries()) {
        signal.throwIfAborted();
        report({ completed: index, total: images.length, detail: image.name || image.id });
        reportGameStepItems(scope, "mosaic", index);
        const sourceImage = await measureGameAsync(scope, "processingMs", () => readUnitySourceImage(current, image, signal));
        const detected = reviews?.results.get(image.id) || await measureGameAsync(scope, "processingMs", () => detector!.scan(sourceImage));
        if (detected.review) throw new Error(image.name + " · " + detected.review);
        const { boxes } = detected;
        signal.throwIfAborted();
        if (!boxes.length) continue;
        const keep: MosaicBox[] = image.regions.filter(region => preferences.protect && region.selected && region.text).map(region => [region.x0, region.y0, region.x1, region.y1]);
        const rendered = await redrawMosaic({ source: sourceImage, boxes, keep, model: preferences.model, steps: preferences.steps, seed: 1, signal, timingScope: scope,
          progress: detail => report({ completed: index, total: images.length, detail }) });
        const imageData = await imageBase64(rendered);
        await measureGameAsync(scope, "saveMs", () => unityRun("mosaic-save", {
          ...request, imageId: image.id, imageSourceHash: image.sourceHash, imageData,
        }, undefined, signal));
      }
      signal.throwIfAborted();
      const result = await measureGameAsync(scope, "saveMs", () => unityRun<{ candidates: MosaicCandidateIndex }>(
        "mosaic-finish-deployment", { ...request, includeMosaic: true }, undefined, signal));
      reportGameStepItems(scope, "mosaic", images.length, 0);
      committed = true;
      setMosaicStatus({ root, candidates: result.candidates });
      setMosaicCompleted(current.folder);
    } finally {
      await detector?.release();
      if (!committed) await unityRun("mosaic-finish-deployment", request);
    }
  }

  function runDeployment(action: "automatic" | "export" | DeploymentPhase) {
    if (isBenchmarkRunning() || !root || locked || deploymentController.current || running.current || mosaicBusy ||
        action !== "automatic" && action !== "export" && deploymentPlan.disabled.includes(action)) return;
    const automatic = action === "automatic";
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
      progress: generation && generation.state !== "done" && generation.state !== "skipped"
        ? { percent: deploymentPercent, state: generation.state === "error" ? "error" : generation.state === "running" ? "active" : "todo", detail: generation.detail, label: deploymentRun ? deploymentRun.steps.map(step => deploymentLabel[step]).join("、") : generation.step === 4 ? "应用到游戏" : "生成补丁" }
        : null,
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
      removeLayer: phase => void (async () => {
        if (!project || !applied || !installed || !patch || locked) return;
        const layers = patch as DeploymentPatch & { mosaicImages?: number };
        const present = deploymentPhases.filter(id => id === "text" ? layers.entries || layers.fontReplacements
          : id === "image" ? layers.images : layers.mosaicImages);
        if (!present.includes(phase)) return;
        if (present.length === 1) { await uninstallPatch(); return; }
        const label = phase === "text" ? "文本" : phase === "image" ? "译图" : "去码图";
        if (!await confirmation.ask("卸载" + label, "将根据当前工程重新生成其余已安装的部分并替换游戏补丁。请先关闭游戏。")) return;
        await operation("卸载" + label, async () => {
          const excluded = deploymentPhases.filter(id => id === phase || !present.includes(id));
          const replacement = await exportPatch(project, undefined, undefined, undefined, excluded);
          await applyPatch(replacement);
          remember({ ...(checkpointRef.current || projectCheckpoint(project)), step: 4, endStep: 4, finished: true,
            patch: replacement, patchFolder: replacement.folder });
        });
      })(),
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
  return <div ref={workspaceRef} className={`unity-offline${deploymentPage ? " is-deployment" : mosaicPage ? " is-mosaic" : ""}`}
    style={workspaceStyle} onClickCapture={event => logGameButton(event, logAction)}>{confirmation.dialog}{textDrop.overlay}
    {active && saveFeedback && createPortal(saveFeedback, document.body)}
    {closingPhase && <ClosingProgress phase={closingPhase} />}
    {exitPrompt && <UnityExitDialog {...exitPrompt} onChoice={resolveExitChoice} />}
    {active && root && restoring && <UnityProjectLoading project={root.split(/[\\/]/).filter(Boolean).at(-1) || "Unity 项目"} path={root} detail={loadingDetail} />}
    {toolbarTarget && createPortal(<>
      <UnityIconButton aria-label="测试队列" title="测试队列" disabled={!game} onClick={openBenchmark}><UnityActionIcon kind="benchmark" /></UnityIconButton>
      <UnityIconButton aria-label="保存工程" title={importPreview ? "请先应用或取消导入预览" : "保存当前工程的参数、文本和图片修改"} disabled={!project || !dirty || saving || !!busy || restoring || !!importPreview} onClick={() => void saveUserChanges()}><UnityActionIcon kind="save" /></UnityIconButton>
    </>, toolbarTarget)}
    <aside ref={panelRef} className="unity-offline-config" style={deploymentPage ? undefined : panelStyle}>
    <div className="unity-offline-upper unity-workflow-layout">
      <GameWorkflowSteps idPrefix="unity-step" panelId="unity-step-panel" edges={trackEdges} enabled={trackEnabled} skipped={trackSkipped}
        disconnected={deploymentPage ? deploymentValidation.disconnected.map(id => deploymentStageId[id]) : undefined} steps={UNITY_STAGE_TABS.map(tab=>{
        const { step, id, label } = tab;
        const canvasRunning = deploymentRun?.steps.some(stage => deploymentStageId[stage] === id);
        if (id === "2.3") {
          const running = canvasRunning ?? mosaicBusy;
          return { id, label, state: running ? "current" : hasMosaic ? "complete" : scanReady ? "current" : "pending",
            selected: mosaicPage, running, onSelect: () => selectWorkflowStage(tab) };
        }
        if (step === 3) {
          const deployment = generation && generation.step >= 3 ? generation : undefined;
          const running = canvasRunning ?? deployment?.state === "running";
          const state = deployment?.state === "error" ? "error" : running ? "current" : applied ? "complete" :
            patch || patchReady || deployment?.state === "stopped" ? "current" : "pending";
          return {id,label,state,selected:activeStep===3,running,paused:deployment?.state==="stopped",onSelect:()=>selectWorkflowStage(tab)};
        }
        const subReady = tab.imageOnly ? imagesReady : textReady;
        const partProgress = step === 2 && !preparingRescan ? currentParts?.[tab.imageOnly ? "images" : "text"] : undefined;
        const runningHere = canvasRunning ?? (partProgress ? partProgress.state === "running" :
          generation?.step === step && generation.state === "running" && (step !== 2 || !!checkpoint?.imageOnly === tab.imageOnly));
        const baseState = step === 2 ? (partProgress ? partProgress.state === "error" : generation?.step === 2 && generation.state === "error" && !!checkpoint?.imageOnly === tab.imageOnly) ? "error" : subReady ? "complete" : runningHere||scanReady ? "current" : "pending" : unityStageState(step, displayedCompletedThrough, executingStep, generation?.state === "error" ? generation.step : undefined, !preparingRescan && needsScan ? 1 : undefined, !preparingRescan && scanUpdate.level === "optional" ? 1 : undefined);
        const state = canvasRunning || step === 1 && baseState === "pending" ? "current" : baseState;
        const selectedTab = !mosaicPage && activeStep === step && (step !== 2 || imagePart === tab.imageOnly);
        const title = state === "outdated" || state === "optional-update" ? `${label} · ${scanUpdate.label}` : undefined;
        return {id,label,title,state,selected:selectedTab,running:runningHere,paused:step===2?!subReady&&partProgress?.state==="stopped":state!=="complete"&&generation?.step===step&&generation.state==="stopped",onSelect:()=>selectWorkflowStage(tab)};
      })}/>
    <section ref={workflowRef} className={`unity-generation unity-workflow ${generation?.state || "idle"}`} aria-label="分步设置与当前任务">
      <div id="unity-step-panel" role="tabpanel" aria-labelledby={`unity-step-${mosaicPage ? "2.3" : activeStep === 2 ? imagePart ? "2.2" : "2.1" : activeStep}`} className="unity-step-panel" >
        {mosaicMounted && <div hidden={!mosaicPage}>
          <div ref={setMosaicControls} />
          {!scanReady && <p className="hint">扫描资源后即可筛选、框选并重绘打码区域。</p>}
          {scanReady && !project?.images?.some(image => image.sourceFile && image.width > 0 && image.height > 0) && <p className="hint">当前工程没有可处理的图片。</p>}
          {scanReady && mosaicStatus?.root === root && mosaicStatus.error && <p className="unity-offline-error">{mosaicStatus.error}</p>}
          {hasMosaic && <p className="hint">选中的去码图将在步骤 3 写入补丁。与译图同源时会合成。</p>}
        </div>}
        {!mosaicPage && <>
        {activeStep === 1 && <div className="unity-scan-layout">
          <div className="unity-scan-progress-card">{progressContent}</div>
          <details className="unity-scan-configuration" open={!scanBusy}>
          <summary>扫描设置</summary>
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
          </details>
          {scanResources}
        </div>}
        {activeStep === 2 && <GamePromptContext.Provider value={promptState}><GameFlowSequence configurationCommit={imagePart ? imageConfigurationCommit : textConfigurationCommit} configurationRevision={configurationRevision} testConfigurations={testConfigurations} testConfigurationDisabled={testConfigurationDisabled} onSaveConfiguration={saveConfiguration} configurationScope={project && !restoring ? root : null} configuration={configuration} restoreConfiguration={restoreConfiguration} actions={<button className="unity-btn unity-btn-warning unity-skip-remaining" disabled={!!busy || restoring || saving || !scanReady} onClick={() => void skipTranslationPart(imagePart)}>跳过剩余内容</button>} activity={{step: runningFlowStep, state: flowProgressState, label: redrawSummary?.label, progress: (!generation || generation.step === 2 && progressIsImage === imagePart) ? progressContent : undefined}} key={imagePart ? "images" : "text"} configured={flowConfig} onConfigure={setFlowConfig} onRun={imagePart && !testConfigurationDisabled && !project?.imagesSkipped && !imagesReady ? () => void startWorkflow(2, 2, false, false, false, "images", true) : undefined}
          steps={imagePart ? [
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
            { id: "translate", title: "翻译图片文字", models: [{role:"image",id:translationKind === "engine" ? undefined : imageModel}], summary: imageModel.split("/").pop(),
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
            { id: "screen", title: "筛选文本", models: [{role:"textScreen",id:textScreenModel}], summary: textScreenModel !== undefined ? "大模型判断是否需要翻译" : "按语言规则筛选", state: screenComplete ? "done" : "current", run: !screenComplete && selected.length ? () => void screenCurrentText() : undefined,
              stop: textScreening ? () => abort.current?.abort() : undefined, runLabel: textScreenPaused ? "继续" : "开始",
              stopDisabled: !!abort.current?.signal.aborted,
              runDisabled: restoring || saving || !scanReady || !!busy && !textScreening, clear: !busy && (textScreenStarted || screenComplete) ? () => void clearTextScreening() : undefined },
            { id: "translate", title: "翻译正文",
              models: translationKind === "engine" ? [] : [{role:"names",id:nameModel || llmModel},{role:"text",id:llmModel},{role:"dialogue",id:dialogueModel || llmModel},{role:"line",id:lineMode === "model" ? lineModel : undefined}], summary: llmModel.split("/").pop(), state: textReady ? "done" : screenComplete ? "current" : "waiting", run: screenComplete && !textReady ? () => startTranslationPart("text") : undefined,
              stop: partRunning ? () => stopPart("text") : undefined,
              stopDisabled: partStopping,
              runLabel: textPartPaused ? "继续" : "开始", runDisabled: partActionDisabled, clear: !busy && textCleanupAvailable ? () => void restartStage(2, true) : undefined },
          ]}><div className="unity-translation-settings">
          {!imagePart && flowConfig === "screen" && <GameProcessingTabs label="筛选方式" localLabel="本地筛选" value={textScreenModel === undefined ? "local" : "llm"}
            disabled={flowConfigLocked} onChange={method => setTextScreenModel(method === "llm" ? "" : undefined)}>
            <div className="unity-control-group"><div className="unity-group-fields unity-translation-fields">
              {textScreenModel !== undefined && <GameModelSelect label="文本筛选模型" promptKey="textScreen" models={gameModels} value={textScreenModel}
                disabled={flowConfigLocked} onChange={setTextScreenModel} />}
            <div className="unity-language-setting"><div className="unity-language-heading"><span>原文语言</span><label className="unity-inline-check" data-tooltip="仅翻译含原语言的内容；自动时使用检测到的主语言。"><input type="checkbox" checked={imagePart ? picture.onlySourceLanguage : onlySourceLanguage} disabled={sharedLanguageLocked} onChange={event => { imagePart ? changePicture({onlySourceLanguage:event.target.checked}) : setOnlySourceLanguage(event.target.checked); setPage(0); }} />仅翻译原语言</label></div><select value={imagePart ? picture.source : source} aria-label="原文语言" disabled={sharedLanguageLocked} onChange={e => { imagePart ? changePicture({source:e.target.value}) : setSource(e.target.value); setPage(0); }}><option value="auto">自动（主语言）</option>{sourceLanguages.map(language => <option key={language} value={language}>{unityLanguageLabel(language)}</option>)}<option value="all">全部语言</option></select></div>
    <div className="unity-language-setting"><div className="unity-language-heading"><span>目标语言</span><label className="unity-inline-check" data-tooltip="仅跳过能明确判断已符合目标语言的条目，原样保留；共用汉字短词仍翻译。关闭后重做可强制翻译。"><input type="checkbox" checked={imagePart ? picture.skipTargetLanguage : skipTargetLanguage} disabled={sharedLanguageLocked} onChange={event => imagePart ? changePicture({skipTargetLanguage:event.target.checked}) : setSkipTargetLanguage(event.target.checked)} />跳过目标语言</label></div><select aria-label="目标语言" value={imagePart ? picture.target : target} disabled={flowConfigLocked} onChange={e => { imagePart ? changePicture({target:e.target.value}) : setTarget(e.target.value); invalidatePatch(); }}>{UNITY_LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}</select></div>
            </div></div>
          </GameProcessingTabs>}
          {flowConfig === "translate" && <GameTranslationTabs kind={imagePart ? picture.kind : translationKind} disabled={flowConfigLocked} onChange={kind=>{if(imagePart){changePicture({kind});return;}setTranslationKind(kind);if(kind==="engine"&&wrapMode==="natural"){setWrapMode("join");setJoinLines(true);}}}>
          <div className="unity-control-group unity-translation-group" role="group" aria-label="翻译参数">
          <div className="unity-group-fields unity-translation-fields">
            {(imagePart ? picture.kind : translationKind) !== "engine" && (imagePart
              ? <>
                  <GameModelSelect label="图片文字翻译模型" promptKey="image" models={gameModels} value={imageModel} disabled={flowConfigLocked} onChange={setImageModel} />
                </>
              : <>
                <GameModelSelect label="常规文本模型" promptKey="text" models={gameModels} value={llmModel} disabled={flowConfigLocked} onChange={setLlmModel} />
                <GameModelSelect optional label="对白模型（可选）" promptKey="dialogue" models={gameModels} value={dialogueModel} disabled={flowConfigLocked} onChange={setDialogueModel} />
                <GameModelSelect optional label="术语模型（可选）" promptKey="names" models={gameModels} value={nameModel} disabled={flowConfigLocked} onChange={setNameModel} />
              </>)}
    <div className="unity-language-setting"><div className="unity-language-heading"><span>目标语言</span><label className="unity-inline-check" data-tooltip="仅跳过能明确判断已符合目标语言的条目，原样保留；共用汉字短词仍翻译。关闭后重做可强制翻译。"><input type="checkbox" checked={imagePart ? picture.skipTargetLanguage : skipTargetLanguage} disabled={sharedLanguageLocked} onChange={event => imagePart ? changePicture({skipTargetLanguage:event.target.checked}) : setSkipTargetLanguage(event.target.checked)} />跳过目标语言</label></div><select aria-label="目标语言" value={imagePart ? picture.target : target} disabled={flowConfigLocked} onChange={e => { if(imagePart) changePicture({target:e.target.value});else setTarget(e.target.value); invalidatePatch(); }}>{UNITY_LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}</select></div>
          </div><div className="unity-run-options">
            {(imagePart ? picture.kind : translationKind) !== "engine" && <label className="unity-inline-check" data-tooltip={GAME_CONTEXT_HINT}><input type="checkbox" checked={includeContext} disabled={flowConfigLocked} onChange={event => setIncludeContext(event.target.checked)} />附带上下文</label>}
          </div>
          {!connectionReady && <p className="unity-offline-error unity-group-note">{translationKind === "local" ? "请在通用设置添加本地模型，再选择翻译模型。" : translationKind === "llm" ? "所选模型尚未配置 API 地址，请前往通用设置配置。" : "请在下方列表中启用至少一个免 Key 或已配置凭证的引擎。"}</p>}
          </div>
          {(imagePart ? picture.kind : translationKind) === "engine" && <UnityEngineList choices={imagePart ? picture.engines : engineChoices} keys={parseEngineKeys(settings.translateEngineKeys)} disabled={flowConfigLocked} expanded={engineListExpanded} onExpandedChange={setEngineListExpanded} onChange={imagePart ? engines=>changePicture({engines}) : updateEngineChoices} />}</GameTranslationTabs>}
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
          {imagePart && flowConfig === "render" && <GameProcessingTabs label="译图排版" localLabel="保留底图排版" disabled={flowConfigLocked} value={imageLayoutModel!==undefined?"llm":"local"} onChange={value=>setImageLayoutModel(value==="llm"?"":undefined)}>{imageLayoutModel!==undefined&&<div className="unity-offline-fields"><GameModelSelect label="断行排版模型" promptKey="layout" models={gameModels} value={imageLayoutModel} disabled={flowConfigLocked} onChange={setImageLayoutModel}/></div>}</GameProcessingTabs>}
          {imagePart && flowConfig === "redraw" && <div className="unity-offline-fields">
            <label>模型工作流<select value={imageRedrawProfile} disabled={flowConfigLocked} onChange={event => setImageRedrawProfile(event.target.value as StyleRedrawProfileId)}>
              {Object.entries(styleRedrawLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select></label><span>勾选「识别到文字」中的图片即可批量重绘。</span>
          </div>}
          {imagePart && flowConfig === "recognize" && <GameProcessingTabs label="识别方式" localLabel="本地 OCR" disabled={flowConfigLocked} value={imageVisionModel!==undefined?"llm":"local"} onChange={value=>setImageVisionModel(value==="llm"?"":undefined)}>{imageVisionModel!==undefined&&<div className="unity-offline-fields"><GameModelSelect label="视觉模型（需支持图片输入）" promptKey="recognize" models={gameModels} value={imageVisionModel} disabled={flowConfigLocked} onChange={setImageVisionModel}/></div>}
          {imagePart && flowConfig === "recognize" && imageVisionModel !== undefined && <label className="unity-inline-check"><input type="checkbox" checked={imageOcrMode === "manga"} disabled={flowConfigLocked}
            onChange={event => setImageOcrMode(event.target.checked ? "manga" : "precise")} />用 Manga OCR 复读日文竖排</label>}
          {imagePart && flowConfig === "recognize" && imageVisionModel===undefined && <><div className="unity-offline-fields"><label>图片识别<select value={imageOcrMode} disabled={flowConfigLocked} onChange={event => setImageOcrMode(event.target.value as OcrMode)}>{OCR_MODE_OPTIONS.map(mode => <option key={mode.id} value={mode.id}>{mode.title}</option>)}</select></label><label>识别并发<select aria-label="Unity 图片识别并发" value={imageConcurrency} disabled={flowConfigLocked} onChange={event=>setImageConcurrency(Number(event.target.value))}>{[1,2,3,4,6,8].map(value=><option key={value} value={value}>{value}</option>)}</select></label><label data-tooltip="低于阈值的区域默认不自动翻译，可在图片结果中手动勾选后处理。">翻译置信度阈值<input aria-label="图片翻译置信度阈值" type="number" min={0} max={100} step={1} value={imageConfidenceThreshold} disabled={flowConfigLocked} onBlur={event => { event.currentTarget.value = String(imageConfidenceThreshold); }} onChange={event => { const value = Number(event.currentTarget.value); const next = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0; event.currentTarget.value = String(next); if (next !== imageConfidenceThreshold) { setImageConfidenceThreshold(next); } }} />%</label><span>可用底图优先按原像素恢复</span></div></>}
          </GameProcessingTabs>}
          {!imagePart && flowConfig === "translate" && <><div className="unity-control-group unity-line-group" role="group" aria-label="换行参数">
          <div className="unity-group-fields unity-line-fields">
            <label>换行处理<UnityDescriptionSelect label="换行处理" value={wrapMode} choices={translationKind==="engine"?UNITY_WRAP_CHOICES.filter(choice=>choice.value!=="natural"):UNITY_WRAP_CHOICES} disabled={flowConfigLocked} onChange={value => { const enabled = value !== "keep"; setJoinLines(enabled);setWrapMode(value as GameWrapMode); const saved = checkpointRef.current; if (saved && !saved.finished && saved.step === 2 && !saved.layoutOnly) remember({ ...saved, joinLines: enabled,wrapMode:value as GameWrapMode }); }} /></label>
            {joinLines && wrapMode!=="natural" && <label>断行方式<UnityDescriptionSelect label="断行方式" value={lineMode} choices={UNITY_LINE_CHOICES} disabled={flowConfigLocked} onChange={value => updateLineOptions(value as UnityLineMode, lineModel)} /></label>}
            {joinLines && wrapMode!=="natural" && <button className="unity-btn" disabled={!!busy || restoring || !scanReady || !selected.some(entry => !!entry.translation)} data-tooltip="保留译文，仅重新处理换行" aria-label="保留译文，仅重新处理换行" onClick={() => void reflowExisting()}>仅重新断行</button>}
            {joinLines && wrapMode!=="natural" && lineMode === "model" && <GameModelSelect label="断行辅助模型" promptKey="line" value={lineModel||settings.model} models={gameModels} disabled={flowConfigLocked} onChange={value=>updateLineOptions(lineMode,value===settings.model?"":value)}/>}
          </div>

          </div>

        </>}
        </div></GameFlowSequence></GamePromptContext.Provider>}
        {activeStep === 2 && !imagePart && (textBatch || textTransfer) && <div className="unity-step-batch">{textBatch}{textTransfer}</div>}
        {deploymentPage && <div className="unity-deployment-page">
          <UnityDeploymentPanel model={deployment.model} actions={deployment.actions} onFocusStep={focusDeploymentStep}
            mosaic={<GameMosaicPatchButton gamePath={root} label="安装或卸载" disabled={!root || !!busy || mosaicBusy || restoring || saving} />} />
        </div>}
        </>}
      </div>
    {activeStep === 3 && progressContent}
    {errorPanel && (generation?.state !== "error" || Math.min(generation.step, 3) === activeStep) && <div className="unity-step-batch">{errorPanel}</div>}
    </section>
    </div>
    </aside>
    {!deploymentPage && <button {...dividerProps} />}
    {mosaicMounted && <div className="unity-image-result-pane" hidden={!mosaicPage}>
      {active && scanReady && mosaicControls && mosaicStorage && project?.images?.some(image => image.sourceFile && image.width > 0 && image.height > 0) &&
        <GameMosaicWorkbench settings={settings} key={root} gamePath={root} images={project.images} read={readMosaicSource} prepareSources={prepareMosaicSources} controls={mosaicControls} storage={mosaicStorage} visible={mosaicPage} disabled={mosaicDisabled} onBusy={setMosaicBusy} />}
    </div>}
    <div hidden={!(activeStep===2&&imagePart) || mosaicPage} className="unity-image-result-pane"><UnityImageWorkbench redrawingId={redrawingId} key={imageResetRevision} initialScreeningComplete={!imagesNeedScreen} onRedrawFailure={async (image, reason) => {
      const current = latest.current;
      const row = current?.images?.find(item => item.id === image.id);
      if (current?.images && row) {
        if (!imageDraftOriginals.current.has(row.id)) imageDraftOriginals.current.set(row.id, row);
        publish({ ...current, images: current.images.map(item => item.id === row.id ? { ...item, error: reason } : item) });
        pendingEdits.current.add("图片重绘：" + row.name);
        setDirty(true);
      }
      logAction(reason, "error");
    }} onImportArchive={importImageArchive} onArchiveMessage={(text,error)=>{if(error)setActionError(text);else setMessage(text);logAction(text,error?"error":"info");}} leaveGuard={imageLeaveGuard} project={project} active={active&&activeStep===2&&imagePart&&!mosaicPage} dirty={imageDraftOriginals.current.size > 0} saving={saving} saveNotice={saveNotice} ocrMode={imageOcrMode} onTranslate={image=>void translateCurrentImage(image)} onRecognize={(image, mode) => void recognizeImage(image, mode)} confidenceThreshold={imageConfidenceThreshold} disabled={!!imageEditorBusy || restoring || saving || !!importPreview || (!!busy && (!translationJobs.current || translationJobs.current.state("images")==="running"))} onChange={editImage} onChangeMany={editImages} onRender={image => void updateImagePreview(image)} onImport={(image,source,modelCandidate)=>updateImagePreview(image,true,source,modelCandidate)} onDiscard={discardImageChanges} onSave={()=>saveUserChanges("images")} /></div>{!deploymentPage&&!mosaicPage&&!(activeStep===2&&imagePart)&&<section ref={textDropRoot} data-game-drop-zone="text" {...textDrop.handlers} className={`unity-offline-workbench${importPreview ? " is-import-choice" : ""}`}>
      <div className="unity-offline-toolbar">
      <div className="unity-result-filters">
        <strong>{importPreview ? `导入预览 · ${importPreview.entries.length} 条` : "文本与译文"}</strong><GameTextFileMenu kind="download" active={active} disabled={!!busy || restoring || !scanReady || !!importPreview} options={[
          {value:"all",label:"下载全部",title:`下载工程全部 ${project?.entries.length||0} 条，包含未勾选条目`,disabled:!project?.entries.length},
          {value:"filtered",label:"下载筛选内容",title:`下载当前筛选匹配的全部 ${filtered.length} 条，包含其他分页`,disabled:!filtered.length},
        ]} onSelect={range=>void downloadTranslations(range)}/>
        <GameTextFileMenu kind="import" active={active} disabled={!!busy || restoring || !scanReady || !!importPreview} options={GAME_TEXT_IMPORT_CHOICES} onSelect={mode=>{setImportMode(mode);void uploadTranslations(undefined,mode);}}/>

        <GameTextFilterMenu active={active} disabled={!scanReady} value={textFilters} matched={matched.length} shown={filtered.length}
          onLimitChange={limit => { setTextFilters(previous => ({ ...previous, limit })); setPage(0); }}
          onChange={value => { setTextFilters(value); setLocateAcrossLanguages(false); setReviewFilter("all"); setPage(0); }} />
        {errorsOnly && !importPreview && <button className="unity-btn" title={testTitle} disabled={testing || !!busy || restoring || !scanReady || !connectionReady || applied || !selected.some(entry => entry.error || unityTranslationError(entry.source, entry.translation))} onClick={() => void startWorkflow(2, 2, !!checkpoint?.layoutOnly, false, false, "text")}>重试未完成项</button>}
      </div>
      <div className="unity-result-tools">
        <input type="search" aria-label="搜索来源、原文和译文" data-tooltip="搜索来源、原文和译文" placeholder="搜索" value={scanReady ? search : ""} disabled={!scanReady} onChange={e => { setSearch(e.target.value); setPage(0); }} />
        <button className="unity-btn unity-text-discard" data-tooltip={importPreview?"取消此次导入预览，保留原工程":"取消当前未保存的文本勾选和译文修改，需要再次确认"} aria-label={importPreview?"取消此次导入预览，保留原工程":"取消当前未保存的文本勾选和译文修改，需要再次确认"} disabled={!project||saving||!!busy||restoring||!importPreview&&(!dirty||![...pendingEdits.current].some(key=>key.startsWith("文本与译文：")||key.startsWith("文本勾选：")))} onClick={()=>importPreview?cancelImportPreview():void discardTextChanges()}>{importPreview?"取消导入":"取消修改"}</button><button className="unity-btn unity-result-save" data-tooltip={importPreview?`${importMode==="replace"?"覆盖已有译文":"仅补空白"}；保存后重置补丁与应用进度，保留图片处理结果` : "仅保存文本勾选与译文修改"} aria-label={importPreview?`${importMode==="replace"?"覆盖已有译文":"仅补空白"}；保存后重置补丁与应用进度，保留图片处理结果` : "仅保存文本勾选与译文修改"} disabled={!project || !hasTextDraft&&!importPreview || saving || !!busy || restoring} onClick={() => void (importPreview?applyImportPreview(importMode):saveUserChanges("text"))}>{saving ? "保存中…" : importPreview?"保存导入":"保存"}</button>
      </div>
      </div>
      {scanReady && project ? <>
        <div className="unity-offline-table-scroll"><table ref={tableRef} className="unity-offline-table" style={{ minWidth: Math.max(560, (sourceWidth.width + 212) / (1 - originalRatio / 100)), "--unity-original-width": `${originalRatio}%` } as CSSProperties}><colgroup><col style={{ width: 32 }} /><col style={{ width: sourceWidth.width }} /><col style={{ width: "var(--unity-original-width)" }} /><col /></colgroup><thead><tr>
          <th><input type="checkbox" aria-label="勾选当前筛选结果"
            data-tooltip="仅勾选或取消当前筛选结果，包含其他分页。" disabled={entriesLocked || !!importPreview || !filtered.length}
            checked={filtered.length > 0 && checkedCount === filtered.length}
            ref={input => { if (input) input.indeterminate = hasMixedSelection; }} onChange={e => { textSearchSnapshot.current = null; editTextEntries(new Set(filtered.map(row => row.id)), { selected: e.target.checked }); }} /></th>
          <th className="unity-resizable-column">来源<button className="unity-column-divider" role="separator" aria-orientation="vertical" aria-label="调整来源列宽" aria-valuenow={Math.round(sourceWidth.width)} onMouseDown={e => sourceWidth.beginResize(e, "grow-right")} onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); sourceWidth.setWidth(sourceWidth.width + (e.key === "ArrowRight" ? 8 : -8)); } }} /></th>
          <th className="unity-resizable-column">原文<button className="unity-column-divider" role="separator" aria-orientation="vertical" aria-label="调整原文和译文列宽" aria-valuenow={Math.round(originalRatio)} onPointerDown={e => { e.preventDefault(); columnDrag.current = { x: e.clientX, ratio: originalRatio, latest: originalRatio, width: tableRef.current!.getBoundingClientRect().width }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { const drag = columnDrag.current; if (!drag) return; drag.latest = Math.max(20, Math.min(70, drag.ratio + (e.clientX - drag.x) / drag.width * 100)); tableRef.current?.style.setProperty("--unity-original-width", `${drag.latest}%`); }} onPointerUp={finishColumnDrag} onPointerCancel={finishColumnDrag} onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const ratio = Math.max(20, Math.min(70, originalRatio + (e.key === "ArrowRight" ? 2 : -2))); setOriginalRatio(ratio); localStorage.setItem("unity-offline-original-ratio", String(ratio)); } }} /></th><th>译文</th>
        </tr></thead><tbody>{rows.map(entry => <tr key={rowJump?.id === entry.id ? `${entry.id}:${rowJump.sequence}` : entry.id} data-entry-id={entry.id} tabIndex={-1} className={`${entryProblem(entry) ? "has-error" : ""}${rowJump?.id === entry.id ? ` unity-entry-target${rowJump.error ? " is-error-target" : ""}` : ""}`}>
          <td><input type="checkbox" aria-label={`选择第 ${entry.id} 条`} disabled={entriesLocked || !!importPreview} checked={entry.selected} onChange={e => update(entry.id, { selected: e.target.checked })} /></td>
          <td data-tooltip={`${entry.file}\n${entry.container}\n${entry.locator}${entry.locale ? `\n语言字段：${entry.locale}` : ""}`}><span><SearchHighlight query={search} text={`#${entry.id} · ${entry.kind}${entry.locale ? ` · ${unityLanguageLabel(unityEntryLanguage(entry))}` : ""}`} /></span><small><SearchHighlight query={search} text={`${entry.file.split(/[\\/]/).pop()} · 对象 #${entry.objectId === "0" ? entry.id : entry.objectId}`} /></small>{search && [entry.file, entry.container, entry.locator].filter(value => value?.toLowerCase().includes(search.toLowerCase())).map((value, index) => <small className="search-matched-field" key={index}><SearchHighlight text={value} query={search} /></small>)}</td>
          <td className="unity-offline-source"><div className="unity-source-text" data-tooltip={entry.source}><GameTextScreenedSource completed={!!entry.translation && !entry.error && !unityTranslationError(entry.source, entry.translation) && !gameDisplayTextProblem(entry.source, entry.translation)} source={entry.source} target={target} sourceLanguage={source} locale={entry.locale} skipTarget={skipTargetLanguage} screened={entry.selected && !importPreview && (textScreened || entry.screeningDraft !== undefined || entry.translation === entry.source)} query={search} /></div></td>
          <td><div className="unity-entry-editor"><GameTextScreenedEditor screening={{ source: entry.source, target, sourceLanguage: source, locale: entry.locale, skipTarget: skipTargetLanguage, screened: entry.selected && !importPreview && (textScreened || entry.screeningDraft !== undefined || entry.translation === entry.source) }} screeningDraft={importPreview ? undefined : entry.screeningDraft} query={search} aria-label={`第 ${entry.id} 条译文`} value={entry.translation || entry.layoutDraft || ""} disabled={entriesLocked} rows={1} onChange={e => update(entry.id, { translation: e.target.value, layoutDraft: undefined, screeningDraft: undefined })} />{entryProblem(entry) && <button className="unity-row-error" data-tooltip={entry.error ? explainUnityFailure(entry.error).reason : entryProblem(entry)} aria-label={`第 ${entry.id} 条错误详情`} onClick={() => { setQualityIssueId(null); setRowIssue({ ...entry, error: entryProblem(entry) }); }}>!</button>}{qualityIssues.has(entry.id) && <button className="unity-row-error" style={{ color: "#9a6700", borderColor: "#d6b56a", background: "#fff8e6" }} data-tooltip={qualityIssues.get(entry.id)!.join("；")} aria-label={`第 ${entry.id} 条疑似问题`} onClick={() => { setRowIssue(null); setQualityIssueId(entry.id); }}>?</button>}</div></td>
        </tr>)}</tbody></table>{!filtered.length && <div className="game-text-no-matches" role="status"><strong>没有匹配的文本</strong><span>请修改搜索词或筛选条件后重试。</span></div>}</div>
        <div className="unity-results-footer">
        {scanReady && <span aria-label="文本范围与选择统计">{locateAcrossLanguages ? "查看全部语言" : scope.label} · {selected.length ? <>可回写 {done} / {selected.length} 条{selected.length !== scope.count && <> · 范围共 {scope.count} 条</>}</> : <>未选择 · 范围共 {scope.count} 条</>}</span>}
        <div className="unity-offline-pagination" aria-label="文本结果分页"><button className="unity-btn" disabled={visiblePage === 0} onClick={() => setPage(Math.max(0, visiblePage - 10))}>-10 页</button><button className="unity-btn" disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>上一页</button><GamePageNumber page={visiblePage} pages={pageCount} onPage={setPage} /><button className="unity-btn" disabled={visiblePage + 1 >= pageCount} onClick={() => setPage(visiblePage + 1)}>下一页</button><button className="unity-btn" disabled={visiblePage + 1 >= pageCount} onClick={() => setPage(Math.min(pageCount - 1, visiblePage + 10))}>+10 页</button></div>
        </div>
      {rowIssue && rowFailure && <div className="unity-row-error-panel" role="dialog" aria-label={`第 ${rowIssue.id} 条错误详情`}><div className="unity-row-error-actions">{importPreview ? <button className="unity-btn" disabled={!!busy || restoring} onClick={() => checkImportPreview()}>校验当前预览</button> : <button className="unity-btn" aria-label={`重试第 ${rowIssue.id} 条`} title={testTitle} disabled={testing || rowRetryQueued || restoring || !scanReady || !connectionReady || applied || !!patch || !!busy && rowQueueStatus !== "failed"} data-tooltip={applied || patch ? "请先清理现有补丁再重试" : rowRetryQueued ? "该条目已在翻译队列中" : busy && rowQueueStatus !== "failed" ? "请在当前任务结束后单独重试此条目" : "重新加入翻译队列，保留已有译文和草稿"} onClick={() => void retryTranslationEntry(rowIssue.id)}>{rowRetryQueued ? "已在队列" : "重试此条"}</button>}<button className="unity-btn" onClick={() => setRowIssue(null)}>关闭</button></div><strong>第 {rowIssue.id} 条处理失败</strong><p>{rowFailure.reason}</p><p>{importPreview ? "请修改右侧预览译文，再校验或应用此次导入。" : rowFailure.action}</p>{rowFailure.technical && <details><summary>技术详情</summary><pre>{rowFailure.technical}</pre></details>}</div>}
      {qualityIssue && <div className="unity-row-error-panel" style={{ borderColor: "#d6b56a", background: "#fffaf0" }} role="dialog" aria-label={`第 ${qualityIssueId} 条疑似问题详情`}><div className="unity-row-error-actions"><button className="unity-btn" onClick={() => locateTranslationFailure(qualityIssueId!)}>定位此条</button><button className="unity-btn" onClick={() => setQualityIssueId(null)}>关闭</button></div><strong>第 {qualityIssueId} 条疑似问题</strong>{qualityIssue.map(issue => <p key={issue}>{issue}</p>)}<p>请结合原文和上下文复核；这些提示不会阻止生成补丁。</p></div>}
      </> : <div className="unity-offline-empty">扫描完成后显示文本与译文。</div>}
    </section>}
  </div>;
});
