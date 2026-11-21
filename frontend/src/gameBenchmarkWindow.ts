import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const isGameBenchmarkWindow = isTauri() && getCurrentWindow().label === "game-benchmark";
export const benchmarkChannelName = "llmchat-game-benchmark-window";

export function requestBenchmarkWindow<T>(channel: BroadcastChannel, kind: "setup" | "selection" | "workload" | "images" | "mosaic" | "read-image" | "stop", timeout = 15000, imageId?: string, snapshotId?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const finish = () => { window.clearTimeout(timer); channel.removeEventListener("message", receive); };
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== "response" || message.id !== id) return;
      finish();
      if (message.error) reject(new Error(message.error)); else resolve(message.value as T);
    };
    const timer = window.setTimeout(() => { finish(); reject(new Error("测试队列窗口通信超时")); }, timeout);
    channel.addEventListener("message", receive);
    channel.postMessage({ type: "request", id, kind, imageId, snapshotId });
  });
}
