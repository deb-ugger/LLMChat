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

export const textScreeningErrorPrefix = "文本筛选失败：";

function screeningReply(reply: unknown, count: number) {
  const missing = new Set(Array.from({ length: count }, (_, id) => id));
  let invalid = 0;
  if (Array.isArray(reply)) for (const item of reply) {
    if (!item || !Number.isInteger(item.id) || typeof item.keep !== "boolean" || !missing.delete(item.id)) invalid++;
  }
  if (!Array.isArray(reply) || reply.length !== count || missing.size || invalid) {
    const detail = `筛选模型 JSON 条目不匹配：请求 ${count} 条，返回${Array.isArray(reply) ? ` ${reply.length} 条` : "非数组"}` +
      (missing.size ? `，缺少编号 ${[...missing].join("、")}` : "") + (invalid ? `，重复编号或无效字段 ${invalid} 项` : "");
    throw Object.assign(new Error(detail), { code: "GAME_TEXT_SCREENING_MISMATCH" });
  }
  return reply as { id: number; keep: boolean }[];
}

export async function screenGameText(rows: UnityEntry[], options: ScreeningOptions) {
  const { settings, model, source, target, skipTarget, signal, onProgress } = options;
  signal.throwIfAborted();
  if (model === "") throw new Error("请选择文本筛选模型，或切回本地筛选。");
  const execution = gameModelExecution(options.prompts, "textScreen", model || "");
  for (const row of rows) if (row.selected && row.error?.startsWith(textScreeningErrorPrefix)) row.error = "";
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
      const offset = start;
      let size = 0;
      while (start + items.length < groups.length && items.length < 32) {
        const id = start + items.length;
        const text = groups[id][0].source;
        if (items.length && size + text.length > 4000) break;
        items.push({ id: items.length, text });
        size += text.length;
      }
      start += items.length;
      options.onSample?.(items[0].text);
      let reply: { id: number; keep: boolean }[] | undefined, issue = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await requestGameModelJson(settings, model,
            `${prompt}\n本批编号从 0 开始，请只返回本批 ${items.length} 条的判定。${attempt ? `上次返回未通过校验：${issue}。请重新逐条对应本批编号，keep 必须为布尔值。` : ""}\n${JSON.stringify(items)}`,
            signal, undefined, "game-text", options.onOllamaStatus, { selection: options.prompts, role: "textScreen" });
          signal.throwIfAborted();
          reply = screeningReply(result, items.length);
          break;
        } catch (error) {
          signal.throwIfAborted();
          const code = (error as { code?: string })?.code;
          if (code !== "GAME_TEXT_SCREENING_MISMATCH" && code !== "GAME_MODEL_INVALID_JSON") throw error;
          issue = error instanceof Error ? error.message : String(error);
          options.onOllamaStatus?.(attempt ? "本批筛选返回仍有错误，已记录失败条目，继续后续批次" : "筛选返回有错误，正在重试当前批次", "error");
        }
      }
      if (!reply) {
        for (const item of items) for (const row of groups[offset + item.id]) row.error = textScreeningErrorPrefix + issue;
      }
      for (const item of reply ?? []) {
        for (const row of groups[offset + item.id]) {
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
