import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { BenchmarkRequest, BenchmarkSnapshot, BenchmarkTaskDecision } from "./benchmark/benchmarkRunner";
import type { ArchivedBenchmarkRef, BenchmarkConfig, BenchmarkResult } from "./gameTextBenchmark";
import { useLayoutEffect, useRef } from "react";

export const isGameBenchmarkWindow = isTauri() && getCurrentWindow().label === "game-benchmark";
export const benchmarkChannelName = "llmchat-game-benchmark-window";
const projectBenchmarks = new Set<() => boolean>();

export function useProjectBenchmarkLauncher(active: boolean, open: () => boolean) {
  const latest = useRef(open);
  latest.current = open;
  useLayoutEffect(() => {
    if (!active) return;
    const launch = () => latest.current();
    projectBenchmarks.add(launch);
    return () => { projectBenchmarks.delete(launch); };
  }, [active]);
}

export function openProjectBenchmark() {
  return [...projectBenchmarks].some(open => open());
}

export type BenchmarkQueueCommand = "benchmark-start-queue" | "benchmark-pause-queue" | "benchmark-start" | "benchmark-stop" | "benchmark-remove" | "benchmark-cleanup" | "benchmark-continue-batch" | "benchmark-restart"
  | "benchmark-show-task" | "benchmark-hide-task" | "benchmark-release-task" | "benchmark-save-task" | "benchmark-set-task-dirty" | "benchmark-decide-task";
export type BenchmarkQueueArgument = string | ArchivedBenchmarkRef
  | { taskId: string; configs: BenchmarkConfig[] }
  | { taskId: string; dirty: boolean }
  | { taskId: string; decision: BenchmarkTaskDecision; configs?: BenchmarkConfig[] };

export function benchmarkHistoryForRecords(history: readonly BenchmarkResult[], jobs: BenchmarkSnapshot["jobs"]): BenchmarkResult[] {
  const unfinished = new Set(jobs.filter(job => job.status !== "完成" && job.status !== "失败").map(job => job.id));
  return history.filter(result => {
    const queueId = result.performance.benchmark?.queueId;
    return typeof queueId !== "string" || !unfinished.has(queueId);
  });
}

export function requestBenchmarkWindow<T>(channel: BroadcastChannel, kind: "setup" | "selection" | "benchmark-enqueue" | "benchmark-snapshot" | BenchmarkQueueCommand, data?: BenchmarkRequest | BenchmarkRequest[] | BenchmarkQueueArgument): Promise<T> {
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
