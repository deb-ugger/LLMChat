import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { gameAuxChannel, gameAuxOpenEvent, gameTestSource, requestGameAux,
  type GameAuxKind, type GameAuxOpenSetup, type GameAuxRequest, type GameAuxSetup } from "../gameAuxWindows";
import { prepareGameTestModels, type GameTestConfiguration } from "../gameModelPreset";
import { showAppNotice } from "./AppNotice";
import { GameTestConfigurations } from "./GameTestConfigurations";
import { GameWorkflowHelpPage } from "./GameWorkflowHelp";
import { BenchmarkReviewWindow } from "./RunComparePanel";
import { AuxiliaryWindowChrome } from "./WindowControls";

const windowTitles: Record<GameAuxKind, string> = {
  help: "游戏翻译流程", configuration: "测试配置", "benchmark-review": "测试结果对照",
};

export function GameAuxiliaryHost() {
  useEffect(() => {
    const channel = new BroadcastChannel(gameAuxChannel);
    const sessions: Partial<Record<GameAuxKind, GameAuxSetup>> = {};
    const opening = new Set<GameAuxKind>();
    let applying = false;
    const openSetup = async (setup: GameAuxOpenSetup) => {
      if (opening.has(setup.kind)) return;
      const previous = sessions[setup.kind];
      const sameContext = setup.kind === "help"
        ? previous?.kind === "help" && previous.mode === setup.mode && previous.supportsImages === setup.supportsImages
        : setup.kind === "benchmark-review"
          ? previous?.kind === "benchmark-review" && previous.queueId === setup.queueId
          : previous?.kind === "configuration" && previous.scope === setup.scope;
      sessions[setup.kind] = { ...setup, session: sameContext ? previous!.session : crypto.randomUUID() };
      opening.add(setup.kind);
      try {
        if (isTauri()) await invoke("open_game_aux_window", { kind: setup.kind });
        else {
          const url = new URL(window.location.href);
          const label = "game-" + setup.kind;
          url.searchParams.set("game-window", label);
          const size = setup.kind === "help" ? "760,height=730" : setup.kind === "configuration" ? "980,height=740" : "1180,height=800";
          const child = window.open(url, label, "popup,width=" + size);
          if (!child) throw new Error("浏览器阻止了新窗口");
          child.focus();
        }
        if (!sameContext) channel.postMessage({ type: "setup-changed", kind: setup.kind });
      } catch (error) {
        sessions[setup.kind] = previous;
        throw error;
      } finally { opening.delete(setup.kind); }
    };
    const open = (event: Event) => void openSetup((event as CustomEvent<GameAuxOpenSetup>).detail)
      .catch(error => showAppNotice(error instanceof Error ? error.message : String(error), "error"));
    const handle = async (request: GameAuxRequest) => {
      if (request.action === "open-benchmark-review") return openSetup(request.setup);
      if (request.action === "setup") {
        const setup = sessions[request.kind];
        if (!setup) throw new Error("请从原游戏工程打开此窗口");
        return setup;
      }
      const setup = sessions.configuration;
      if (setup?.kind !== "configuration" || setup.session !== request.session) throw new Error("配置窗口的游戏工程已切换");
      const source = gameTestSource(setup.scope);
      if (request.action === "capture") return source.capture();
      if (applying) throw new Error("正在应用测试配置");
      applying = true;
      try {
        await prepareGameTestModels(request.row.value, source.models, request.part);
        if (sessions.configuration?.session !== request.session) throw new Error("配置窗口的游戏工程已切换");
        await gameTestSource(setup.scope).apply(request.row.value, request.part);
        showAppNotice(`已应用「${request.row.name}」${request.part ? `的${request.part === "text" ? "文本翻译" : "图片翻译"}部分` : "的全部配置"}`);
      } finally { applying = false; }
    };
    let active = true;
    channel.onmessage = async event => {
      if (event.data?.type !== "request") return;
      const { id, request } = event.data as { id: string; request: GameAuxRequest };
      try {
        const value = await handle(request);
        if (active) channel.postMessage({ type: "response", id, value });
      } catch (error) {
        if (active) channel.postMessage({ type: "response", id, error: error instanceof Error ? error.message : String(error) });
      }
    };
    window.addEventListener(gameAuxOpenEvent, open);
    return () => { active = false; window.removeEventListener(gameAuxOpenEvent, open); channel.close(); };
  }, []);
  return null;
}

export function GameAuxiliaryWindow({ kind }: { kind: GameAuxKind }) {
  const [page, setPage] = useState<{ setup: GameAuxSetup; channel: BroadcastChannel }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const channel = new BroadcastChannel(gameAuxChannel);
    const read = () => void requestGameAux<GameAuxSetup>(channel, { action: "setup", kind }).then(setup => {
      if (active) { setPage({ setup, channel }); setError(""); }
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    channel.onmessage = event => { if (event.data?.type === "setup-changed" && event.data.kind === kind) read(); };
    document.title = windowTitles[kind] + " · LLMChat";
    read();
    return () => { active = false; channel.close(); };
  }, [kind]);
  const close = () => {
    if (isTauri()) void getCurrentWindow().close().catch(error => showAppNotice(String(error), "error"));
    else window.close();
  };
  const setup = page?.setup;
  const channel = page?.channel;
  return <AuxiliaryWindowChrome title={windowTitles[kind]}>
    {!setup || !channel || error ? <main className="game-aux-loading">
      <p role={error ? "alert" : "status"}>{error || "正在加载" + windowTitles[kind] + "…"}</p>
      <button type="button" className="unity-btn" onClick={close}>关闭</button>
    </main> : setup.kind === "help" ? <GameWorkflowHelpPage {...setup} onClose={close} />
      : setup.kind === "benchmark-review" ? <BenchmarkReviewWindow key={setup.session} setup={setup} onClose={close} />
      : <GameTestConfigurations key={setup.session} setup={setup}
        capture={() => requestGameAux<GameTestConfiguration>(channel, { action: "capture", session: setup.session })}
        onApply={(row, part) => requestGameAux<void>(channel, { action: "apply", session: setup.session, row, part }, 120000)} onClose={close} />}
  </AuxiliaryWindowChrome>;
}
