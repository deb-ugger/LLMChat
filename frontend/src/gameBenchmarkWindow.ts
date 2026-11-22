import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { BenchmarkRequest, BenchmarkSnapshot } from "./benchmark/benchmarkRunner";
import type { ArchivedBenchmarkRef, BenchmarkResult } from "./gameTextBenchmark";

export const isGameBenchmarkWindow = isTauri() && getCurrentWindow().label === "game-benchmark";
export const benchmarkChannelName = "llmchat-game-benchmark-window";

export type BenchmarkQueueCommand = "benchmark-start" | "benchmark-stop" | "benchmark-remove" | "benchmark-cleanup" | "benchmark-continue-batch" | "benchmark-restart";
export type BenchmarkQueueArgument = string | ArchivedBenchmarkRef;

export function benchmarkHistoryForRecords(history: readonly BenchmarkResult[], jobs: BenchmarkSnapshot["jobs"]): BenchmarkResult[] {
  const unfinished = new Set(jobs.filter(job => job.status !== "完成" && job.status !== "失败").map(job => job.id));
  return history.filter(result => {
    const queueId = result.performance.benchmark?.queueId;
    return typeof queueId !== "string" || !unfinished.has(queueId);
  });
}

export function requestBenchmarkWindow<T>(channel: BroadcastChannel, kind: "setup" | "selection" | "benchmark-enqueue" | "benchmark-snapshot" | BenchmarkQueueCommand, data?: BenchmarkRequest | BenchmarkQueueArgument): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const finish = () => { window.clearTimeout(timer); channel.removeEventListener("message", receive); };
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== "response" || message.id !== id) return;
      finish();
      if (message.error) reject(new Error(message.error)); else resolve(message.value as T);
    };
    const timer = window.setTimeout(() => { finish(); reject(new Error("测试队列窗口通信超时")); }, 15000);
    channel.addEventListener("message", receive);
    channel.postMessage({ type: "request", id, kind, data });
  });
}
