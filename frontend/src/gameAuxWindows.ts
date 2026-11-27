import { useLayoutEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import type { GameTestConfiguration, GameTestConfigurationAccess, GameTestConfigurationPart, SavedGameTestConfiguration } from "./gameModelPreset";

export type GameAuxKind = "help" | "configuration" | "benchmark-review";
export type GameHelpSetup = { kind: "help"; mode: "unity-offline" | "unity-runtime" | "embedded"; supportsImages: boolean };
export type GameConfigurationSetup = {
  kind: "configuration"; scope: string; models: string[]; current: GameTestConfiguration; initialPart: "text" | "images";
};
export type GameBenchmarkReviewSetup = {
  kind: "benchmark-review"; queueId: string; scope?: string; step?: string; label: string; itemUnit: "条" | "张"; formal?: boolean;
};
export type GameAuxOpenSetup = GameHelpSetup | GameConfigurationSetup | GameBenchmarkReviewSetup;
export type GameAuxSetup = GameAuxOpenSetup & { session: string };
export type GameAuxRequest = { action: "setup"; kind: GameAuxKind } |
  { action: "open-benchmark-review"; setup: GameBenchmarkReviewSetup } |
  { action: "capture"; session: string } | { action: "apply"; session: string; row: SavedGameTestConfiguration; part?: GameTestConfigurationPart };

export const gameAuxOpenEvent = "llmchat:open-game-aux";
export const gameAuxChannel = "llmchat:game-auxiliary";
const testSources = new Map<string, GameTestConfigurationAccess>();

export function useGameTestConfigurationSource(access: GameTestConfigurationAccess) {
  useLayoutEffect(() => {
    testSources.set(access.scope, access);
    return () => { if (testSources.get(access.scope) === access) testSources.delete(access.scope); };
  }, [access]);
}

export function gameTestSource(scope: string) {
  const source = testSources.get(scope);
  if (!source) throw new Error("原游戏工程已关闭，请从工程重新打开测试配置");
  return source;
}

export function currentGameAuxWindow(): GameAuxKind | undefined {
  const label = isTauri() ? getCurrentWindow().label : new URLSearchParams(window.location.search).get("game-window");
  if (label === "game-help") return "help";
  if (label === "game-configuration") return "configuration";
  if (label === "game-benchmark-review") return "benchmark-review";
}

export function openGameAuxWindow(setup: GameAuxOpenSetup) {
  window.dispatchEvent(new CustomEvent(gameAuxOpenEvent, { detail: setup }));
}

export const runReferenceKey = (queueId: string, formal?: boolean) =>
  `llmchat-run-reference:${formal ? "formal" : "test"}:${queueId}`;

export async function pickRunReference(path?: string) {
  const selected = await open({
    title: "选择对照集清单", multiple: false, defaultPath: path || "E:\\",
    filters: [{ name: "对照集清单", extensions: ["json"] }],
  });
  if (typeof selected !== "string") return undefined;
  if (selected.split(/[\\/]/).at(-1)?.toLowerCase() !== "manifest.json")
    throw new Error("请选择对照集目录里的 manifest.json");
  return selected;
}

export async function openBenchmarkReview(setup: GameBenchmarkReviewSetup) {
  if (!isTauri()) {
    openGameAuxWindow(setup);
    return;
  }
  const channel = new BroadcastChannel(gameAuxChannel);
  try { await requestGameAux(channel, { action: "open-benchmark-review", setup }); }
  finally { channel.close(); }
}

export function requestGameAux<T>(channel: BroadcastChannel, request: GameAuxRequest, timeout = 15000) {
  return new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID();
    const finish = () => { window.clearTimeout(timer); channel.removeEventListener("message", receive); };
    const receive = (event: MessageEvent) => {
      if (event.data?.type !== "response" || event.data.id !== id) return;
      finish();
      if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.value as T);
    };
    const timer = window.setTimeout(() => { finish(); reject(new Error("游戏翻译窗口与主窗口通信超时")); }, timeout);
    channel.addEventListener("message", receive);
    channel.postMessage({ type: "request", id, request });
  });
}
