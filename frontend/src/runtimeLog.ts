import { invoke, isTauri } from "@tauri-apps/api/core";

export function redactRuntimeMessage(message: string) {
  return message.replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|secret|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted]").slice(0, 8000);
}
export function logRuntimeError(kind: string, cause: unknown) {
  if (!isTauri()) return;
  const message = redactRuntimeMessage(cause instanceof Error ? `${cause.message}\n${cause.stack || ""}` : String(cause));
  void invoke("write_runtime_log", { kind, message }).catch(error => console.warn("运行日志写入失败", error));
}
export function installRuntimeLogging() {
  window.addEventListener("error", event => logRuntimeError("frontend-error", event.error || event.message));
  window.addEventListener("unhandledrejection", event => logRuntimeError("unhandled-rejection", event.reason));
}
