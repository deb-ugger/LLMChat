import { defaultMosaicSettings } from "./gameMosaic";
import { api, type OcrMode, type TranslateProvider } from "./api";
import { loadLocalModelProfiles, saveLocalModelProfiles } from "./modelPresets";
import { gameDefaultTextModel, modelConcurrency, saveModelConcurrency } from "./gameModelPerformance";
import { gameJapanesePromptId, type GamePromptScene, type GamePromptSelection } from "./gamePrompts";
import type { GameTextOptions } from "./gameTextProject";
import { loadUnityEngines, normalizeUnityEngines, UNITY_ENGINE_CHOICES_KEY, type UnityEngineChoice } from "./unityEnginePool";
import type { UnityLineMode } from "./unityLineLayout";
import { defaultGameImageVision } from "./gameImagePlacement";
import { GAME_IMAGE_SCREENING_LANES } from "./gameImageScreening";

const testModels = {
  hy: gameDefaultTextModel,
  qwen: { id: "qwen3.5:latest", pattern: /^qwen3\.5(?::(?:latest|9b(?:-q4_k_m)?))?$/i },
  vision: { id: "qwen3-vl:8b-instruct", pattern: /^qwen3-vl:8b-instruct$/i },
} as const;
const imageLayoutModel = "qwen3.5:4b";

export type GameTestRole = { model?: string; prompt: string; concurrency: number };
export type GameTestRoles = Partial<Record<GamePromptScene, GameTestRole>>;
export type GameTestPart<T> = { options: T; roles: GameTestRoles };
export type GameTestTextOptions = Omit<GameTextOptions, "model" | "screeningModel" | "dialogueModel" | "nameModel" | "reviewModel"> & {
  engines: UnityEngineChoice[]; lineMode?: UnityLineMode;
};
export type GameTestImageOptions = {
  mosaic?: import("./gameMosaic").MosaicSettings;
  redrawProfile?: import("./gameImagePlacement").StyleRedrawProfileId;
  mode: OcrMode; concurrency: number; confidence?: number; strategy?: "staged" | "full";
  refine?: { method: "local" | "llm" | "off"; mode: Exclude<OcrMode, "manga">; concurrency: number; confidence: number };
  translation?: Pick<GameTextOptions, "source" | "target" | "onlySourceLanguage" | "skipTargetLanguage" | "kind"> & {
    provider: TranslateProvider; engines: UnityEngineChoice[];
  };
};
export type GameTestConfiguration = { text: GameTestPart<GameTestTextOptions>; images?: GameTestPart<GameTestImageOptions>; detectedSource?: string };
export type GameTestConfigurationPart = "text" | "images";
export type GameTestConfigurationAccess = {
  scope: string; models: string[]; capture: () => GameTestConfiguration; apply: (value: GameTestConfiguration, part?: GameTestConfigurationPart) => Promise<void>;
};
export type SavedGameTestConfiguration = { id: string; name: string; value: GameTestConfiguration };
export const DEFAULT_GAME_TEST_CONFIGURATION_ID = "builtin:default";
export const JAPANESE_GAME_TEST_CONFIGURATION_ID = "builtin:japanese";
export const JAPANESE_R18_GAME_TEST_CONFIGURATION_ID = "builtin:japanese-r18";

const configurationsPrefix = "llmchat-game-test-configurations:";
const configurationsKey = (scope: string) => configurationsPrefix + scope.replaceAll("\\", "/").toLowerCase();
export function readGameTestConfigurations(scope: string): SavedGameTestConfiguration[] {
  try {
    const value = JSON.parse(localStorage.getItem(configurationsKey(scope)) || "[]");
    return Array.isArray(value) ? value.filter(row => row?.id && row.name && row.value?.text?.options && row.value.text.roles) : [];
  } catch { return []; }
}
export function saveGameTestConfigurations(scope: string, rows: SavedGameTestConfiguration[]) {
  localStorage.setItem(configurationsKey(scope), JSON.stringify(rows));
}

const gameEngineChoicesKey = (scope: string) => UNITY_ENGINE_CHOICES_KEY + ":" + scope;
export function loadGameWorkflowEngines(scope: string) {
  const saved = localStorage.getItem(gameEngineChoicesKey(scope));
  if (saved === null) return loadUnityEngines();
  try { return normalizeUnityEngines(JSON.parse(saved)); } catch { return loadUnityEngines(); }
}
export function saveGameWorkflowEngines(scope: string, engines: UnityEngineChoice[]) {
  localStorage.setItem(gameEngineChoicesKey(scope), JSON.stringify(engines));
}

export function captureGameTestRoles(models: Partial<Record<GamePromptScene, string | undefined>>, prompts: { scope: string; selection: GamePromptSelection }, effectiveModels = models) {
  const roles: GameTestRoles = {};
  for (const scene of Object.keys(models) as GamePromptScene[]) {
    roles[scene] = { model: models[scene], prompt: prompts.selection[scene] || "builtin:" + scene,
      concurrency: modelConcurrency(prompts.scope, scene, effectiveModels[scene] || "") };
  }
  return roles;
}

export function applyGameTestRoles(roles: GameTestRoles, prompts: { scope: string; select: (scene: GamePromptScene, id: string) => void }, effectiveModels: Partial<Record<GamePromptScene, string>> = {}) {
  for (const scene of Object.keys(roles) as GamePromptScene[]) {
    const role = roles[scene];
    if (!role) continue;
    prompts.select(scene, role.prompt);
    const model = effectiveModels[scene] ?? role.model;
    if (model) saveModelConcurrency(prompts.scope, scene, model, role.concurrency);
  }
}

const gameOllamaEndpoint = () => localStorage.getItem("llmchat-ollama-url") || "http://127.0.0.1:11434/v1/chat/completions";
export function listGameTestOllamaModels() {
  return api.listOllamaModels(localStorage.getItem("llmchat-ollama-directory") || "", gameOllamaEndpoint());
}

export async function prepareGameTestModels(value: GameTestConfiguration, available: string[], part?: GameTestConfigurationPart) {
  const text = part === "images" ? undefined : value.text;
  const images = part === "text" ? undefined : value.images;
  const roles: (GameTestRole | undefined)[] = [];
  if (text) {
    roles.push(text.roles.textScreen);
    if (text.options.kind !== "engine") roles.push(text.roles.text, text.roles.dialogue, text.roles.names);
    if (text.options.kind !== "engine" && text.options.semanticReview !== false) roles.push(text.roles.textReview);
    if (text.options.joinLines && text.options.wrapMode !== "natural" && text.options.lineMode === "model") roles.push(text.roles.line);
  }
  if (images) {
    roles.push(images.roles.screen, images.roles.recognize, images.roles.layout);
    if (images.options.refine?.method === "llm") roles.push(images.roles.refine);
    const modelTranslation = (images.options.translation?.kind ?? value.text.options.kind) !== "engine";
    if (modelTranslation) roles.push(images.roles.image);
    if (modelTranslation || images.options.translation) roles.push(images.roles.review);
  }
  const profiles = loadLocalModelProfiles();
  const missing = [...new Set(roles.flatMap(role => role?.model && !available.includes(role.model) && !profiles[role.model]?.apiUrl?.trim() ? [role.model] : []))];
  if (!missing.length) return;
  const installed = await listGameTestOllamaModels();
  const unavailable = missing.filter(model => !installed.includes(model));
  if (unavailable.length) throw new Error(`模型未安装或未配置：${unavailable.join("、")}`);
  const latest = loadLocalModelProfiles();
  for (const model of missing) if (!latest[model]?.apiUrl?.trim()) latest[model] = { apiUrl: gameOllamaEndpoint(), apiKey: "" };
  saveLocalModelProfiles(latest);
  if (missing.some(model => !loadLocalModelProfiles()[model]?.apiUrl)) throw new Error("Ollama 模型配置保存失败");
}

export function recommendedGameModels() {
  const models = Object.entries(loadLocalModelProfiles()).filter(([, profile]) => profile.apiUrl?.trim()).map(([model]) => model);
  const text = models.find(model => testModels.hy.pattern.test(model));
  const review = models.find(model => testModels.qwen.pattern.test(model));
  const vision = models.find(model => testModels.vision.pattern.test(model));
  return { text, dialogue: text, names: text, review, vision };
}

export function defaultGameTestConfiguration(current: GameTestConfiguration): GameTestConfiguration {
  const value = structuredClone(current);
  const profiles = loadLocalModelProfiles();
  const configured = Object.keys(profiles).filter(model => profiles[model].apiUrl?.trim());
  const modelId = (spec: typeof testModels[keyof typeof testModels]) => configured.find(model => spec.pattern.test(model)) || spec.id;
  const normal = modelId(testModels.hy);
  const setRole = (roles: GameTestRoles, scene: GamePromptScene, model?: string, concurrency = 1) => {
    roles[scene] = { model, concurrency, prompt: "builtin:" + scene };
  };
  const text = value.text;
  text.options.kind = "llm";
  text.options.includeContext = true;
  text.options.semanticReview = true;
  text.options.sceneAware = true;
  text.options.wrapMode = "natural";
  text.options.joinLines = true;
  text.options.lineMode = "local";
  delete text.options.lineModel;
  setRole(text.roles, "textScreen"); setRole(text.roles, "line");
  for (const scene of ["text", "dialogue"] as const)
    setRole(text.roles, scene, normal, gameDefaultTextModel.concurrency);
  setRole(text.roles, "names", modelId(testModels.qwen));
  setRole(text.roles, "textReview", modelId(testModels.qwen));
  const images = value.images;
  if (!images) return value;
  if (images.options.mosaic) images.options.mosaic = { ...defaultMosaicSettings };
  if (images.options.redrawProfile) images.options.redrawProfile = "turbo";
  const imageLanguage = images.options.translation ?? text.options;
  const hasScreeningStep = images.options.strategy !== undefined;
  images.options.mode = hasScreeningStep ? (imageLanguage.source === "ja" || imageLanguage.source === "auto" ? "manga" : "precise") : "fast";
  images.options.concurrency = GAME_IMAGE_SCREENING_LANES;
  if (hasScreeningStep) images.options.strategy = "staged";
  if (hasScreeningStep && !images.options.refine) images.options.refine = { method: "local", mode: "precise", concurrency: 2, confidence: 50 };
  else if (images.options.refine) Object.assign(images.options.refine, { method: "local", mode: "precise", concurrency: 2 });
  if (images.options.translation) Object.assign(images.options.translation, { kind: "llm", provider: "llm" });
  setRole(images.roles, "screen"); setRole(images.roles, "refine");
  setRole(images.roles, "layout", imageLayoutModel);
  setRole(images.roles, "recognize", hasScreeningStep ? defaultGameImageVision(configured) || modelId(testModels.vision) : undefined, 2);
  setRole(images.roles, "image", normal, gameDefaultTextModel.concurrency);
  setRole(images.roles, "review", modelId(testModels.qwen));
  return value;
}

export function japaneseGameTestConfiguration(current: GameTestConfiguration, r18 = false): GameTestConfiguration {
  const value = defaultGameTestConfiguration(current);
  const language = { source: "ja", target: "zh-CN", onlySourceLanguage: true, skipTargetLanguage: true };
  Object.assign(value.text.options, language);
  if (value.images?.options.translation) Object.assign(value.images.options.translation, language);
  if (value.images?.options.strategy) value.images.options.mode = "manga";
  value.detectedSource = "ja";
  for (const part of [value.text, value.images]) if (part) {
    for (const [scene, role] of Object.entries(part.roles) as [GamePromptScene, GameTestRole][]) role.prompt = gameJapanesePromptId(scene, r18);
  }
  return value;
}

function refreshSavedImageLayoutConfigurations() {
  const revision = "llmchat-game-test-config-image-layout-v1";
  if (localStorage.getItem(revision) !== null) return;
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  for (const key of keys) {
    if (!key?.startsWith(configurationsPrefix)) continue;
    let rows: SavedGameTestConfiguration[];
    try { rows = JSON.parse(localStorage.getItem(key) || "[]"); }
    catch { continue; }
    if (!Array.isArray(rows)) continue;
    let changed = false;
    const next = rows.map(row => {
      const images = row?.value?.images;
      if (!row?.id || !row.name || !images?.roles) return row;
      const role = images.roles.layout;
      if (role?.model === imageLayoutModel && role.concurrency === 1) return row;
      changed = true;
      return { ...row, value: { ...row.value, images: { ...images, roles: { ...images.roles,
        layout: { model: imageLayoutModel, concurrency: 1, prompt: role?.prompt || "builtin:layout" },
      } } } };
    });
    if (changed) localStorage.setItem(key, JSON.stringify(next));
  }
  localStorage.setItem(revision, "1");
}

function refreshSavedMosaicQualityConfigurations() {
  const revision = "llmchat-game-test-config-mosaic-quality-v1";
  if (localStorage.getItem(revision) !== null) return;
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  for (const key of keys) {
    const workflow = key?.startsWith("llmchat-mosaic-settings:");
    if (!key || !workflow && !key.startsWith(configurationsPrefix)) continue;
    let saved: unknown;
    try { saved = JSON.parse(localStorage.getItem(key) || "null"); }
    catch { continue; }
    if (workflow) {
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) continue;
      const settings = saved as Partial<import("./gameMosaic").MosaicSettings>;
      if (settings.screening?.localZoom === true) continue;
      localStorage.setItem(key, JSON.stringify({ ...settings, screening: { ...settings.screening, localZoom: true } }));
    } else {
      if (!Array.isArray(saved)) continue;
      let changed = false;
      const next = (saved as SavedGameTestConfiguration[]).map(row => {
        const images = row?.value?.images;
        const mosaic = images?.options?.mosaic;
        if (!images || !mosaic || mosaic.screening?.localZoom === true) return row;
        changed = true;
        return { ...row, value: { ...row.value, images: { ...images, options: { ...images.options,
          mosaic: { ...mosaic, screening: { ...mosaic.screening, localZoom: true } },
        } } } };
      });
      if (changed) localStorage.setItem(key, JSON.stringify(next));
    }
  }
  localStorage.setItem(revision, "1");
}

export function refreshSavedGameTestConfigurations() {
  refreshSavedMosaicQualityConfigurations();
  refreshSavedImageLayoutConfigurations();
  const revision = "llmchat-game-test-config-semantics-v1";
  if (localStorage.getItem(revision) !== null) return;
  const updateCustomPrompts = localStorage.getItem("llmchat-game-test-config-japanese-prompts-v2") === null;
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  let refreshed = 0;
  for (const key of keys) {
    if (!key?.startsWith(configurationsPrefix)) continue;
    let rows: SavedGameTestConfiguration[];
    try { rows = JSON.parse(localStorage.getItem(key) || "[]"); }
    catch { continue; }
    if (!Array.isArray(rows)) continue;
    const next = rows.map(row => {
      if (!row?.id || !row.name || !row.value?.text?.options || !row.value.text.roles) return row;
      if (row.id === DEFAULT_GAME_TEST_CONFIGURATION_ID) { refreshed++; return { ...row, value: defaultGameTestConfiguration(row.value) }; }
      if (row.id === JAPANESE_GAME_TEST_CONFIGURATION_ID || row.id === JAPANESE_R18_GAME_TEST_CONFIGURATION_ID) {
        refreshed++; return { ...row, value: japaneseGameTestConfiguration(row.value, row.id === JAPANESE_R18_GAME_TEST_CONFIGURATION_ID) };
      }
      if (!updateCustomPrompts) return row;
      const r18 = /r18/i.test(row.name) || [row.value.text, row.value.images].some(part => Object.values(part?.roles || {}).some(role => role?.prompt?.startsWith("builtin:ja-zh-cn-r18:")));
      const fallback = japaneseGameTestConfiguration(row.value, r18);
      const value = structuredClone(row.value);
      let changed = false;
      for (const partName of ["text", "images"] as const) {
        const part = value[partName], defaults = fallback[partName];
        const language = partName === "text" ? value.text.options : value.images?.options.translation || value.text.options;
        if (!part || !defaults || language?.source !== "ja" || language.target !== "zh-CN") continue;
        for (const [scene, defaultRole] of Object.entries(defaults.roles) as [GamePromptScene, GameTestRole][]) {
          const role = part.roles[scene];
          if (!role) { part.roles[scene] = { ...defaultRole }; changed = true; continue; }
          if (role.prompt !== "builtin:" + scene && !role.prompt?.startsWith("builtin:ja-zh-cn")) continue;
          const prompt = gameJapanesePromptId(scene, r18);
          if (role.prompt !== prompt) { role.prompt = prompt; changed = true; }
        }
      }
      if (changed) { refreshed++; return { ...row, value }; }
      return row;
    });
    localStorage.setItem(key, JSON.stringify(next));
  }
  localStorage.setItem(revision, String(refreshed));
}

export function builtinGameTestConfigurations(current: GameTestConfiguration): SavedGameTestConfiguration[] {
  const value = defaultGameTestConfiguration(current);
  return [
    { id: DEFAULT_GAME_TEST_CONFIGURATION_ID, name: "默认配置", value },
    { id: JAPANESE_GAME_TEST_CONFIGURATION_ID, name: "日语配置", value: japaneseGameTestConfiguration(current) },
    { id: JAPANESE_R18_GAME_TEST_CONFIGURATION_ID, name: "日语 R18 配置", value: japaneseGameTestConfiguration(current, true) },
  ];
}
