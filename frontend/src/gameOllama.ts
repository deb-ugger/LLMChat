import { acquireLocalModel, maximumModelConcurrency } from "./gameModelPerformance";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { api, type TranslateOptions } from "./api";
import { showAppNotice } from "./components/AppNotice";
import { gameImageJapaneseTextIssue } from "./gameDisplayText";
import { readGameTranslationEnvelope } from "./unityTokens";

export type OllamaOutput = (message: string, level: "info" | "success" | "error") => void;
export type GameTranslateOptions = TranslateOptions & { imageTranslationRole?: "image" | "review" };
type ModelConnection = Pick<TranslateOptions, "apiUrl" | "model" | "localModel">;
type OllamaRuntime = { running: boolean; parallel: number | null; models: { name: string; size: number; size_vram: number }[] };
const starting = new Map<string, Promise<void>>();

function ollamaAddress(connection: ModelConnection) {
  if (!connection.localModel || !connection.apiUrl) return;
  try {
    const url = new URL(connection.apiUrl);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) return;
    const configured = localStorage.getItem("llmchat-ollama-url");
    if (url.port !== "11434" && (!configured || new URL(configured).origin !== url.origin)) return;
    return { host: host === "localhost" ? "127.0.0.1" : host, port: Number(url.port || 80) };
  } catch { return; }
}

export async function withGameOllama<T>(connection: ModelConnection, signal: AbortSignal | undefined,
  report: OllamaOutput | undefined, request: () => Promise<T>): Promise<T> {
  try { return await request(); }
  catch (error) {
    const address = isTauri() && (error as { code?: string } | null)?.code === "LLM_LOCAL_CONNECTION_FAILED" && ollamaAddress(connection);
    if (!address) throw error;
    signal?.throwIfAborted();
    const endpoint = address.host === "::1" ? `[::1]:${address.port}` : `${address.host}:${address.port}`;
    let pending = starting.get(endpoint);
    if (!pending) {
      report?.(`Ollama 未运行，正在启动 ${endpoint}，所需模型：${connection.model || "默认模型"}`, "info");
      pending = invoke<void>("ollama_service_start", {
        ...address, parallel: maximumModelConcurrency(), models: localStorage.getItem("llmchat-ollama-directory")?.trim() || "",
        proxyEnabled: localStorage.getItem("llmchat-ollama-proxy-enabled") === "true",
        proxyUrl: localStorage.getItem("llmchat-ollama-proxy-url")?.trim() || "http://127.0.0.1:7890",
      }).then(() => {
        report?.(`Ollama 已就绪（${endpoint}），正在重试模型请求。`, "success");
      }).catch((cause: unknown) => {
        const detail = `Ollama 启动失败（${endpoint}）：${cause instanceof Error ? cause.message : String(cause)}`;
        report?.(detail, "error");
        throw new Error(detail, { cause });
      }).finally(() => starting.delete(endpoint));
      starting.set(endpoint, pending);
    }
    await pending;
    signal?.throwIfAborted();
    try { return await request(); }
    catch (cause) {
      signal?.throwIfAborted();
      const model = connection.model || "默认模型";
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Ollama 启动后重试失败（${endpoint}，模型 ${model}）：${reason}`, { cause });
    }
  }
}

export async function prepareGameOllamaModels(connections: Array<{ connection: ModelConnection; lanes: number }>, signal: AbortSignal, report: OllamaOutput) {
  if (!isTauri()) return;
  const endpoints = new Map<string, { connection: ModelConnection; parallel: number }>();
  for (const { connection, lanes } of connections) {
    const address = ollamaAddress(connection);
    if (!address) continue;
    const key = JSON.stringify(address);
    const parallel = Math.max(lanes, endpoints.get(key)?.parallel ?? 1);
    endpoints.set(key, { connection, parallel });
  }
  for (const endpoint of endpoints.values()) {
    signal.throwIfAborted();
    await prepareGameOllamaParallel(endpoint.connection, endpoint.parallel, signal, report);
    signal.throwIfAborted();
  }
}

export async function prepareGameOllamaParallel(connection: ModelConnection, lanes: number, signal: AbortSignal, report: OllamaOutput, options?: { keepExternalService?: boolean }) {
  if (!isTauri()) return;
  const address = ollamaAddress(connection);
  if (!address) return;
  signal.throwIfAborted();
  const status = await invoke<OllamaRuntime>("ollama_runtime_status", address);
  if (status.running && (lanes === 1 || status.parallel !== null && status.parallel >= lanes)) return;
  if (status.running && status.parallel === null && options?.keepExternalService) {
    report("正在使用外部启动的 Ollama，实际并行数取决于该服务的配置。", "info");
    return;
  }
  if (status.running) {
    report(`正在自动调整 Ollama 服务并发为 ${lanes}，服务将重启，当前连接到该服务的请求会中断。`, "info");
    showAppNotice("正在自动调整 Ollama 服务并发");
  }
  report(`正在准备 Ollama，服务并发 ${lanes}`, "info");
  const url = new URL(connection.apiUrl!);
  const origin = `${url.protocol}//${url.hostname.replace(/^(localhost|\[::1\])$/, "127.0.0.1")}:${url.port}`;
  const release = await acquireLocalModel(origin, connection.model || "", 1, signal);
  try {
    await invoke("ollama_service_start", {
      ...address, parallel: lanes, ensureParallel: true,
      models: localStorage.getItem("llmchat-ollama-directory")?.trim() || "",
      proxyEnabled: localStorage.getItem("llmchat-ollama-proxy-enabled") === "true",
      proxyUrl: localStorage.getItem("llmchat-ollama-proxy-url")?.trim() || "http://127.0.0.1:7890",
    });
  } catch (error) {
    report("Ollama 并发自动配置失败：" + String(error), "error");
    showAppNotice("Ollama 并发自动配置失败：" + String(error), "error");
    throw error;
  } finally { release(); }
  signal.throwIfAborted();
  report(`Ollama 服务已就绪，服务并发 ${lanes}。`, "success");
  showAppNotice(`Ollama 服务并发已设为 ${lanes}`);
}

export function ollamaGpuDescription(model: { size: number; size_vram: number }) {
  if (!(model.size > 0) || !Number.isFinite(model.size_vram)) return "服务未提供 GPU 分配信息";
  if (model.size_vram >= model.size) return "模型完全加载在 GPU";
  if (model.size_vram <= 0) return "模型当前使用 CPU，复筛速度会受影响";
  const percent = Math.round(model.size_vram / model.size * 100);
  return `模型约 ${percent}% 分配到 GPU，部分计算使用 CPU。可减少并发或关闭其他占用显存的模型后重试`;
}

export async function reportRefinementGpu(connection: ModelConnection, signal: AbortSignal, report: OllamaOutput) {
  if (!isTauri()) return;
  const address = ollamaAddress(connection);
  if (!address) return;
  try {
    const status = await invoke<OllamaRuntime>("ollama_runtime_status", address);
    signal.throwIfAborted();
    const name = (value: string) => value.replace(/:latest$/, "");
    const model = status.models.find(model => name(model.name) === name(connection.model || ""));
    report(model ? ollamaGpuDescription(model) : "复筛模型当前未驻留，后续图片可能需要重新加载。", "info");
  } catch (error) {
    signal.throwIfAborted();
    report("无法读取 Ollama GPU 状态：" + String(error), "info");
  }
}

export function gameOllamaNative(connection: ModelConnection) { return !!ollamaAddress(connection) && new URL(connection.apiUrl!).pathname.replace(/\/$/, "") === "/v1/chat/completions"; }

export async function translateGameWithOllama(text: string, init: RequestInit, options: GameTranslateOptions, report: OllamaOutput) {
  const { imageTranslationRole, ...request } = options;
  if (imageTranslationRole === "review" && request.provider === "llm" && canDisableOllamaNameThinking(request))
    request.ollamaReasoningOff = true;
  const translate = async (config: TranslateOptions) => {
    const result = await withGameOllama(config, init.signal ?? undefined, report,
      () => api.translate(text, init, { ...config, ollamaNative: gameOllamaNative(config) }));
    if (!result.ok || config.provider !== "llm" || !imageTranslationRole) return result;
    const translation = readGameTranslationEnvelope(text, result.translation);
    return translation == null ? result : { ...result, translation };
  };
  const result = await translate(request);
  if (imageTranslationRole !== "review" || request.provider !== "llm" || !result.ok ||
    !gameImageJapaneseTextIssue(text, result.translation, request.target)) return result;

  init.signal?.throwIfAborted();
  const correction = "上次译文仍含日文。请把日文正文译成目标语言。已有术语优先，未收录的人名可音译。保留原有符号、格式和换行，只输出译文。";
  return translate({ ...request, prompt: [request.prompt, correction].filter(Boolean).join("\n") });
}

export function canDisableOllamaNameThinking(connection: ModelConnection) {
  return !!ollamaAddress(connection) && /^qwen3\.5(?::|$)/i.test(connection.model || "") &&
    new URL(connection.apiUrl!).pathname.replace(/\/$/, "") === "/v1/chat/completions";
}
