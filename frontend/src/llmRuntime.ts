import { acquireLocalModel, recordGameRequest, trackGameModel, measureGameAsync, type ModelServiceTiming } from "./gameModelPerformance";
type RuntimeSettings = { maxOutputTokens: number; batchInputTokens: number };
export function loadLlmRuntime(): RuntimeSettings {
  try { const v = JSON.parse(localStorage.getItem("llmchat-llm-runtime") || "{}"); return { maxOutputTokens: Number.isInteger(v.maxOutputTokens) && v.maxOutputTokens >= 0 && v.maxOutputTokens <= 1048576 ? v.maxOutputTokens : 0, batchInputTokens: Number.isInteger(v.batchInputTokens) && v.batchInputTokens >= 512 && v.batchInputTokens <= 32768 ? v.batchInputTokens : 2400 }; } catch { return { maxOutputTokens: 0, batchInputTokens: 2400 }; }
}
/** Serialize local service work across text, vision and layout. Queue time is not request time. */
export async function runModelRequest<T extends { ok?: boolean; promptTokens?: number; completionTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; generationTokensPerSecond?: number; serviceTiming?: ModelServiceTiming }>(connection: { model?: string; apiUrl?: string; localModel?: boolean; llmConcurrency?: number; performanceScope?: string; performanceStep?: string }, signal: AbortSignal | null | undefined, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const model = connection.model || "大模型";
  let release: (() => void) | undefined;
  if (connection.localModel) {
    const url = new URL(connection.apiUrl!); const origin = `${url.protocol}//${url.hostname.replace(/^(localhost|\[::1\])$/, "127.0.0.1")}:${url.port}`;
    release = await measureGameAsync(connection, "queueMs", () => acquireLocalModel(origin, model, connection.llmConcurrency || 1, signal));
  } else if (connection.performanceScope && connection.llmConcurrency) {
    release = await measureGameAsync(connection, "queueMs", () => acquireLocalModel(JSON.stringify([connection.apiUrl, model]), model, connection.llmConcurrency!, signal));
  }
  try {
    signal?.throwIfAborted();
    const started = performance.now();
    const timeout = AbortSignal.timeout(330000); const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const stopTracking = trackGameModel(connection, model, connection.localModel === undefined ? undefined : connection.localModel ? "local" : "online");
    let outcome: "succeeded" | "failed" | "cancelled" = "failed";
    try {
      const result = await measureGameAsync(connection, "modelRequestMs", () => request(combined));
      recordGameRequest(connection, model, result.completionTokens || 0, performance.now() - started, result.generationTokensPerSecond, result.serviceTiming, result);
      outcome = signal?.aborted ? "cancelled" : result.ok === false ? "failed" : "succeeded";
      return result;
    } finally {
      stopTracking?.(signal?.aborted ? "cancelled" : outcome);
    }
  } finally { release?.(); }
}
