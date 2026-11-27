import { gameModelExecution, measureGameWork } from "./gameModelPerformance";
import type { OllamaOutput } from "./gameOllama";
import type { Settings } from "./api";
import { gameTextScreeningResult, preserveTargetGameText } from "./gameDisplayText";
import { requestGameModelJson } from "./gameModelRequest";
import { gameTextScreeningPrompt, type GamePromptSelection } from "./gamePrompts";
import type { UnityEntry } from "./unityOffline";

type ScreeningOptions = {
  settings: Settings;
  model?: string;
  prompts: GamePromptSelection;
  source: string;
  onlySource?: boolean;
  target: string;
  skipTarget: boolean;
  signal: AbortSignal;
  onOllamaStatus?: OllamaOutput;
  onProgress?: (completed: number, total: number) => void;
  onSample?: (sample: string) => void;
};

export async function screenGameText(rows: UnityEntry[], options: ScreeningOptions) {
  const { settings, model, source, target, skipTarget, signal, onProgress } = options;
  signal.throwIfAborted();
  if (model === "") throw new Error("请选择文本筛选模型，或切回本地筛选。");
  const execution = gameModelExecution(options.prompts, "textScreen", model || "");
  const eligible = rows.filter(row => row.selected && !row.error);
  if (model === undefined) return measureGameWork(execution, "processingMs", () => {
    preserveTargetGameText(eligible, target, source, skipTarget);
    let deselected = 0;
    for (const row of eligible) {
      if (!row.source.trim() || gameTextScreeningResult(row.source, target, source, skipTarget, row.locale).unchanged) {
        row.selected = false;
        deselected++;
      }
    }
    return deselected;
  });
  let kept = 0;
  if (!eligible.length) return kept;
  const prompt = gameTextScreeningPrompt(options.prompts, { source, target, onlySource: options.onlySource ?? source !== "auto", skipTarget });
  const bySource = new Map<string, UnityEntry[]>();
  for (const row of eligible) {
    const group = bySource.get(row.source);
    if (group) group.push(row); else bySource.set(row.source, [row]);
  }
  const groups = [...bySource.values()];
  let start = 0, completed = 0;
  let stopped = false;
  const concurrency = gameModelExecution(options.prompts, "textScreen", model).llmConcurrency || 1;
  onProgress?.(0, groups.length);
  const worker = async () => {
    while (!stopped && start < groups.length) {
      signal.throwIfAborted();
      const items: { id: number; text: string }[] = [];
      let size = 0;
      while (start + items.length < groups.length && items.length < 32) {
        const id = start + items.length;
        const text = groups[id][0].source;
        if (items.length && size + text.length > 4000) break;
        items.push({ id, text });
        size += text.length;
      }
      start += items.length;
      options.onSample?.(items[0].text);
      const reply = await requestGameModelJson(settings, model,
        `${prompt}\n${JSON.stringify(items)}`,
        signal, undefined, "game-text", options.onOllamaStatus, { selection: options.prompts, role: "textScreen" });
      signal.throwIfAborted();
      const ids = new Set(items.map(item => item.id));
      if (!Array.isArray(reply) || reply.length !== items.length || reply.some(item =>
        !item || typeof item.keep !== "boolean" || !ids.delete(item.id))) {
        throw new Error("筛选模型返回的条目与请求不一致，请重试或改用本地筛选。");
      }
      for (const item of reply) {
        for (const row of groups[item.id]) {
          delete row.screeningDraft;
          if (!item.keep) {
            if (row.translation === row.source) {
              row.translation = "";
              delete row.translationTarget;
            }
            continue;
          }
          if (!row.translation || row.translationTarget && row.translationTarget !== target) {
            row.translation = row.source;
            row.translationTarget = target;
          }
          row.selected = false;
          kept++;
        }
      }
      completed += items.length;
      onProgress?.(completed, groups.length);
    }
  };
  const runs = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    try { await worker(); } catch (error) { stopped = true; throw error; }
  }));
  const failed = runs.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  return kept;
}
