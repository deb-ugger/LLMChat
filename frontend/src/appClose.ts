import { showAppNotice } from "./components/AppNotice";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { logRuntimeError } from "./runtimeLog";

type CloseGuard = () => Promise<boolean>;
const guards = new Map<symbol, { guard: CloseGuard; registeredAt: string }>();
let unlisten: (() => void) | undefined;
let connecting: Promise<void> | undefined;
let closing = false, generation = 0;
let keepListener = false;

// Keep exit prompts in the live WebView; native dialog IPC can fail during teardown.
function closePrompt(title: string, description: string): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog"); dialog.className = "game-action-confirm";
    const heading = document.createElement("h2"); heading.textContent = title;
    const detail = document.createElement("p"); detail.textContent = description;
    const footer = document.createElement("footer");
    const finish = (accepted: boolean) => { dialog.close(); dialog.remove(); resolve(accepted); };
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "game-confirm-cancel";
    cancel.textContent = "继续等待"; cancel.autofocus = true; cancel.onclick = () => finish(false);
    { const accept = document.createElement("button"); accept.type = "button"; accept.className = "game-confirm-accept"; accept.textContent = "强制退出"; accept.onclick = () => finish(true); footer.append(accept); }
    footer.append(cancel); dialog.append(heading, detail, footer);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    document.body.append(dialog); dialog.showModal();
  });
}

async function finishAppClose() {
  logRuntimeError("app-close-native-dispatch", "Dispatching finish_app_close");
  try { await invoke("finish_app_close"); }
  catch (error) {
    // The exit command may destroy the WebView before its IPC response is delivered.
    if (!String(error).includes("failed to send message to the webview")) throw error;
  }
}

function releaseUnusedListener() {
  if (!keepListener && !guards.size && !closing && unlisten) { unlisten(); unlisten = undefined; }
}

async function handleAppClose() {
    if (closing) { logRuntimeError("app-close-duplicate", `Close already in progress; attempt=${generation}`); return; }
    closing = true;
    const attempt = ++generation;
    const started = performance.now();
    logRuntimeError("app-close-begin", `attempt=${attempt}; guards=${guards.size}`);
    try {
      // Finish each module's save/cancel decision before one final window destroy.
      let index = 0;
      for (const [id, { guard, registeredAt }] of [...guards]) {
        if (!guards.has(id)) continue;
        const guardIndex = ++index;
        const guardStarted = performance.now();
        logRuntimeError("app-close-guard-begin", `attempt=${attempt}; guard=${guardIndex}; registeredAt=${registeredAt}`);
        const waiting = window.setTimeout(() => logRuntimeError("app-close-guard-waiting", `attempt=${attempt}; guard=${guardIndex}; elapsed_ms=${Math.round(performance.now() - guardStarted)}; awaiting save/cancel decision or cleanup`), 10000);
        let accepted: boolean;
        try { accepted = await guard(); }
        catch (error) { logRuntimeError("app-close-guard-error", `attempt=${attempt}; guard=${guardIndex}; elapsed_ms=${Math.round(performance.now() - guardStarted)}; ${error instanceof Error ? error.stack || error.message : String(error)}`); throw error; }
        finally { window.clearTimeout(waiting); }
        logRuntimeError("app-close-guard-complete", `attempt=${attempt}; guard=${guardIndex}; accepted=${accepted}; elapsed_ms=${Math.round(performance.now() - guardStarted)}`);
        if (!accepted) return;
        if (attempt !== generation) return;
      }
      if (attempt === generation) await finishAppClose();
    } catch (error) {
      logRuntimeError("app-close", error);
      showAppNotice(`退出失败，窗口已保留：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      logRuntimeError("app-close-handler-returned", `attempt=${attempt}; elapsed_ms=${Math.round(performance.now() - started)}`);
      if (attempt === generation) closing = false;
      releaseUnusedListener();
    }
}

async function connect() {
  if (unlisten) return;
  if (!connecting) connecting = (async () => {
    const window = getCurrentWindow();
    const normal = await window.onCloseRequested(event => { event.preventDefault(); void handleAppClose(); });
    try {
      const external = await window.listen("llmchat://close-requested", () => {
        logRuntimeError("app-close-external-received", "Received build request; applying normal save/cancel guards");
        void handleAppClose();
      });
      unlisten = () => { normal(); external(); };
      logRuntimeError("app-close-listener-ready", "Normal window and build close listeners registered");
    } catch (error) { normal(); throw error; }
  })().finally(() => { connecting = undefined; });
  await connecting;
}

export async function initializeAppClose() {
  if (!isTauri()) return;
  keepListener = true;
  await connect();
}

export async function registerAppCloseGuard(guard: CloseGuard) {
  const id = Symbol();
  guards.set(id, { guard, registeredAt: new Error().stack?.split("\n").slice(2, 5).join(" | ") || "unavailable" });
  try { await connect(); } catch (error) { guards.delete(id); throw error; }
  return () => { guards.delete(id); releaseUnusedListener(); };
}

export async function requestForceAppClose() {
  if (!await closePrompt("强制退出 LLMChat", "立即关闭窗口并退出程序？未保存的修改可能丢失；如果正在写入游戏资源，建议继续等待。")) return;
  logRuntimeError("app-force-close-confirmed", `User confirmed force exit; previous_attempt=${generation}`);
  const previous = generation;
  generation++;
  try { await finishAppClose(); closing = false; releaseUnusedListener(); }
  catch (error) {
    generation = previous; closing = false;
    logRuntimeError("app-force-close", error);
    showAppNotice(`强制退出失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}
