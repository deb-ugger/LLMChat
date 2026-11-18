import { api } from "./api";
import { loadLocalModelProfiles, saveLocalModelProfiles } from "./modelPresets";

const testModels = {
  hy: { label: "Hy-MT2 7B Q8", pattern: /(?:^|\/)Hy-MT2-7B-GGUF:Q8_0$/i },
  gal: { label: "GalTransl 4B 2601 Q5", pattern: /(?:^|\/)GalTransl-v4-4B-2601:Q5_K_S$/i },
  qwen: { label: "Qwen3.5 9B", pattern: /^qwen3\.5(?::(?:latest|9b(?:-q4_k_m)?))?$/i },
} as const;

export type GameTestConfiguration = {
  text: string; dialogue: string; names: string; image: string; review: string;
  ocrMode: "precise"; ocrConcurrency: 2;
};

export const GAME_TEST_CONFIGURATION_HINT = "同时应用到文本和图片。日译简中对白用 GalTransl 4B，常规文本、术语和图片初译用 Hy-MT2 7B，失败重译用 Qwen3.5 9B。图片使用本地 PaddleOCR 和原位排版。";

export function recommendedGameModels() {
  const models = Object.entries(loadLocalModelProfiles()).filter(([, profile]) => profile.apiUrl?.trim()).map(([model]) => model);
  const text = models.find(model => testModels.hy.pattern.test(model));
  const dialogue = models.find(model => testModels.gal.pattern.test(model));
  const review = models.find(model => testModels.qwen.pattern.test(model));
  const vision = models.find(model => /^qwen3-vl:4b-instruct$/i.test(model));
  return text && review ? { text, dialogue: dialogue || text, names: text, review, vision } : null;
}

export async function loadGameTestConfiguration(japaneseToSimplified: boolean): Promise<GameTestConfiguration> {
  const required = japaneseToSimplified ? [testModels.hy, testModels.gal, testModels.qwen] : [testModels.hy, testModels.qwen];
  let profiles = loadLocalModelProfiles();
  const configured = () => Object.keys(profiles).filter(model => profiles[model].apiUrl?.trim());
  const missing = () => required.filter(spec => !configured().some(model => spec.pattern.test(model)));
  if (missing().length) {
    const endpoint = localStorage.getItem("llmchat-ollama-url") || "http://127.0.0.1:11434/v1/chat/completions";
    const directory = localStorage.getItem("llmchat-ollama-directory") || "";
    const available = await api.listOllamaModels(directory, endpoint);
    profiles = loadLocalModelProfiles();
    const uninstalled = missing().filter(spec => !available.some(model => spec.pattern.test(model)));
    if (uninstalled.length) throw new Error(`测试配置缺少模型：${uninstalled.map(spec => spec.label).join("、")}。请在 Ollama 安装后再应用。`);
    for (const spec of missing()) {
      const model = available.find(id => spec.pattern.test(id))!;
      profiles[model] = { apiUrl: endpoint, apiKey: "" };
    }
    saveLocalModelProfiles(profiles);
    profiles = loadLocalModelProfiles();
    if (missing().length) throw new Error("Ollama 模型配置保存失败");
  }
  const models = configured();
  const text = models.find(model => testModels.hy.pattern.test(model))!;
  const dialogue = japaneseToSimplified ? models.find(model => testModels.gal.pattern.test(model))! : text;
  const review = models.find(model => testModels.qwen.pattern.test(model))!;
  return { text, dialogue, names: text, image: text, review, ocrMode: "precise", ocrConcurrency: 2 };
}
