import { api, type OcrMode, type TranslateProvider } from "./api";
import { loadLocalModelProfiles, saveLocalModelProfiles } from "./modelPresets";
import { modelConcurrency, saveModelConcurrency } from "./gameModelPerformance";
import type { GamePromptScene, GamePromptSelection } from "./gamePrompts";
import type { GameTextOptions } from "./gameTextProject";
import { loadUnityEngines, normalizeUnityEngines, UNITY_ENGINE_CHOICES_KEY, type UnityEngineChoice } from "./unityEnginePool";
import type { UnityLineMode } from "./unityLineLayout";

const testModels = {
  hy: { id: "hf.co/tencent/Hy-MT2-7B-GGUF:Q8_0", pattern: /(?:^|\/)Hy-MT2-7B-GGUF:Q8_0$/i },
  gal: { id: "hf.co/SakuraLLM/GalTransl-v4-4B-2601:Q5_K_S", pattern: /(?:^|\/)GalTransl-v4-4B-2601:Q5_K_S$/i },
  qwen: { id: "qwen3.5:latest", pattern: /^qwen3\.5(?::(?:latest|9b(?:-q4_k_m)?))?$/i },
  vision: { id: "qwen3-vl:4b-instruct", pattern: /^qwen3-vl:4b-instruct$/i },
} as const;

export type GameTestRole = { model?: string; prompt: string; concurrency: number };
export type GameTestRoles = Partial<Record<GamePromptScene, GameTestRole>>;
export type GameTestPart<T> = { options: T; roles: GameTestRoles };
export type GameTestTextOptions = Omit<GameTextOptions, "model" | "screeningModel" | "dialogueModel" | "nameModel"> & {
  engines: UnityEngineChoice[]; lineMode?: UnityLineMode;
};
export type GameTestImageOptions = {
  mode: OcrMode; concurrency: number; confidence?: number; strategy?: "staged" | "full";
  refine?: { method: "local" | "llm" | "off"; mode: Exclude<OcrMode, "manga">; concurrency: number; confidence: number };
  translation?: Pick<GameTextOptions, "source" | "target" | "onlySourceLanguage" | "skipTargetLanguage" | "kind"> & {
    provider: TranslateProvider; engines: UnityEngineChoice[];
  };
};
export type GameTestConfiguration = { text: GameTestPart<GameTestTextOptions>; images?: GameTestPart<GameTestImageOptions>; detectedSource?: string };
export type GameTestConfigurationAccess = {
  scope: string; models: string[]; capture: () => GameTestConfiguration; apply: (value: GameTestConfiguration) => Promise<void>;
};
export type SavedGameTestConfiguration = { id: string; name: string; value: GameTestConfiguration };
export const DEFAULT_GAME_TEST_CONFIGURATION_ID = "builtin:default";

const configurationsKey = (scope: string) => "llmchat-game-test-configurations:" + scope.replaceAll("\\", "/").toLowerCase();
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

export async function prepareGameTestModels(value: GameTestConfiguration, available: string[]) {
  const text = value.text;
  const images = value.images;
  const roles = [text.roles.textScreen];
  if (text.options.kind !== "engine") roles.push(text.roles.text, text.roles.dialogue, text.roles.names);
  if (text.options.joinLines && text.options.wrapMode !== "natural" && text.options.lineMode === "model") roles.push(text.roles.line);
  if (images) {
    roles.push(images.roles.screen, images.roles.recognize, images.roles.layout);
    if (images.options.refine?.method === "llm") roles.push(images.roles.refine);
    const modelTranslation = (images.options.translation?.kind ?? text.options.kind) !== "engine";
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
  const dialogue = models.find(model => testModels.gal.pattern.test(model));
  const review = models.find(model => testModels.qwen.pattern.test(model));
  const vision = models.find(model => testModels.vision.pattern.test(model));
  return text && review ? { text, dialogue: dialogue || text, names: text, review, vision } : null;
}

export function defaultGameTestConfiguration(current: GameTestConfiguration): GameTestConfiguration {
  const value = structuredClone(current);
  const profiles = loadLocalModelProfiles();
  const configured = Object.keys(profiles).filter(model => profiles[model].apiUrl?.trim());
  const modelId = (spec: typeof testModels[keyof typeof testModels]) => configured.find(model => spec.pattern.test(model)) || spec.id;
  const normal = modelId(testModels.hy);
  const japanese = (options: Pick<GameTestTextOptions, "source" | "target">) =>
    (options.source === "auto" ? value.detectedSource : options.source) === "ja" && options.target === "zh-CN";
  const setRole = (roles: GameTestRoles, scene: GamePromptScene, model?: string, concurrency = 1) => {
    if (roles[scene]) roles[scene] = { model, concurrency, prompt: "builtin:" + scene };
  };
  const text = value.text;
  text.options.kind = "llm";
  text.options.includeContext = true;
  if (text.options.lineMode) text.options.lineMode = "local";
  setRole(text.roles, "textScreen"); setRole(text.roles, "line");
  setRole(text.roles, "text", normal); setRole(text.roles, "names", normal);
  setRole(text.roles, "dialogue", japanese(text.options) ? modelId(testModels.gal) : normal);
  const images = value.images;
  if (!images) return value;
  const imageLanguage = images.options.translation ?? text.options;
  images.options.mode = imageLanguage.source === "ja" || imageLanguage.source === "auto" ? "manga" : "precise";
  images.options.concurrency = 2;
  if (images.options.strategy) images.options.strategy = "staged";
  if (images.options.refine) Object.assign(images.options.refine, { method: "local", mode: "precise", concurrency: 2 });
  if (images.options.translation) Object.assign(images.options.translation, { kind: "llm", provider: "llm" });
  setRole(images.roles, "screen"); setRole(images.roles, "refine"); setRole(images.roles, "layout");
  setRole(images.roles, "recognize", modelId(testModels.vision), 2);
  setRole(images.roles, "image", japanese(imageLanguage) ? modelId(testModels.gal) : normal);
  setRole(images.roles, "review", modelId(testModels.qwen));
  return value;
}
