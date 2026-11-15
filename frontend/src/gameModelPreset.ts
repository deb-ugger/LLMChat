import { loadLocalModelProfiles } from "./modelPresets";

/** Model-role choices only; each workflow keeps its own options and progress. */
export function recommendedGameModels() {
  const models = Object.keys(loadLocalModelProfiles());
  const text = models.find(model => /(?:^|\/)Hy-MT2-7B-GGUF:Q8_0$/i.test(model));
  const dialogue = models.find(model => /(?:^|\/)Sakura-14B-Qwen2\.5-v1\.0-GGUF(?::latest)?$/i.test(model));
  const review = models.find(model => /^qwen3\.5(?::latest)?$/i.test(model));
  const vision = models.find(model => /^qwen3-vl:4b-instruct$/i.test(model));
  return text && dialogue && review && vision ? { text, dialogue, names: review, review, vision } : null;
}
export const gameModelPresetKey = (root: string, workflow: string) => `llmchat-game-model-setup:${workflow}:${root}`;
