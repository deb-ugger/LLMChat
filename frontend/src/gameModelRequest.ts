import { gameModelExecution } from "./gameModelPerformance";
import { loadLlmRuntime, runModelRequest } from "./llmRuntime";
import { withGameOllama, gameOllamaNative, type OllamaOutput } from "./gameOllama";
import { API_BASE, type Settings } from "./api";
import { resolveFeatureLlm, loadLocalModelProfiles } from "./modelPresets";
import { ollamaRequestContext } from "./ollamaContext";

export async function requestGameModelJson(settings: Settings, model: string, prompt: string, signal: AbortSignal, image?: string, endpoint: "game-images" | "game-text" = "game-images", report?: OllamaOutput, execution?: { selection?: object; role: string; imageClassification?: boolean }): Promise<unknown> {
  if (!model) throw new Error("请选择处理模型");
  const connection = { ...resolveFeatureLlm(settings, model), ...(execution ? gameModelExecution(execution.selection, execution.role, model) : {}) };
  if (!connection.apiUrl) throw new Error("所选模型未配置接口地址");
  const localModel = !!loadLocalModelProfiles()[model];
  return withGameOllama({ ...connection, localModel }, signal, report, () => runModelRequest({ ...connection, localModel }, signal, async signal => {
    const taskId = crypto.randomUUID();
    const cancel = () => { void fetch(`${API_BASE}/api/translate/cancel`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({taskId})}).catch(() => {}); };
    signal.throwIfAborted(); signal.addEventListener("abort", cancel, { once: true });
    try {
      const response = await fetch(`${API_BASE}/api/${endpoint}/model`, { method: "POST", signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...connection, taskId, prompt, image, localModel,
          imageClassification: execution?.imageClassification === true,
          imageLayout: execution?.role === "layout",
          imageOcr: !!image && !execution?.imageClassification && (execution?.role === "recognize" || execution?.role === "screen" || execution?.role === "refine"),
          ollamaNative: gameOllamaNative({ ...connection, localModel }), ...(localModel ? ollamaRequestContext(connection.apiUrl) : {}),
          maxOutputTokens: loadLlmRuntime().maxOutputTokens }) });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || "模型处理失败"), {
        code: result.code, outputTokenLimit: result.outputTokenLimit, completionTokens: result.completionTokens, promptTokens: result.promptTokens,
      });
      const raw = String(result.content).trim();
      const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
      const content = (image || execution?.role === "layout") && fence?.length === 1 ? fence[0].replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "") : raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      try { return { value: JSON.parse(content), completionTokens: result.completionTokens, generationTokensPerSecond: result.generationTokensPerSecond }; } catch { throw Object.assign(new Error("模型未返回有效 JSON"), { code: "GAME_MODEL_INVALID_JSON" }); }
    } finally { signal.removeEventListener("abort", cancel); }
  }).then(result => result.value));
}
