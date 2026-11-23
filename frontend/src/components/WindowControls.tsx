import { useEffect, useState, type ReactNode } from "react";
import { getLayoutRect, getLayoutViewport } from "../viewportLayout";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initializeAppClose } from "../appClose";
import { logRuntimeError } from "../runtimeLog";
import { showAppNotice } from "./AppNotice";

function DesktopWindowControls() {
  const [appWindow] = useState(getCurrentWindow);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      void appWindow.isMaximized().then(value => {
        if (!disposed && current === request) setMaximized(value);
      }).catch(error => {
        if (!disposed) logRuntimeError("window-controls-state", error);
      });
    };

    void appWindow.onResized(refresh).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(error => {
      if (!disposed) logRuntimeError("window-controls-resize-listener", error);
    });
    refresh();
    return () => { disposed = true; unlisten?.(); };
  }, [appWindow]);

  const toggleMaximize = async () => {
    await appWindow.toggleMaximize();
    setMaximized(await appWindow.isMaximized());
  };
  const close = async () => {
    await initializeAppClose();
    await appWindow.close();
  };
  const buttons = [
    { label: "最小化窗口", path: "M1.5 6h9", action: () => appWindow.minimize() },
    { label: maximized ? "还原窗口" : "最大化窗口",
      path: maximized ? "M4 2V1.5h6.5V8H10 M1.5 4h6.5v6.5H1.5z" : "M1.5 1.5h9v9h-9z",
      action: toggleMaximize },
    { label: "关闭窗口", path: "m2 2 8 8M10 2l-8 8", action: close, danger: true },
  ];

  return <>
    {buttons.map(({ label, path, action, danger }, index) => <button key={index} type="button"
      className={danger ? "is-close" : undefined} aria-label={label} data-tooltip={label}
      onClick={() => void action().catch(error => showAppNotice(label + "失败：" + String(error), "error"))}>
      <span aria-hidden="true">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1">
          <path d={path} />
        </svg>
      </span>
    </button>)}
  </>;
}

export function positionWindowPopover(anchor: HTMLElement, panel: HTMLElement | null) {
  if (!panel) return;
  const { scale, width } = getLayoutViewport();
  const bounds = getLayoutRect(anchor.getBoundingClientRect(), scale);
  panel.style.setProperty("--window-popover-top", (bounds.bottom + 6) + "px");
  panel.style.setProperty("--window-popover-right", Math.max(8, width - bounds.right) + "px");
}

export function WindowControls({ actions }: { actions?: ReactNode }) {
  const desktop = window.self === window.top && isTauri() && getCurrentWebview().label === "main";
  if (!desktop && !actions) return null;
  return <>
    <div className="window-bar" data-tauri-drag-region={desktop ? "" : undefined} aria-hidden="true" />
    <div className="window-controls" role="group" aria-label="标题栏">
      {actions && <div className="window-actions" role="group" aria-label="应用快捷操作">{actions}</div>}
      {desktop && <DesktopWindowControls />}
    </div>
  </>;
}
