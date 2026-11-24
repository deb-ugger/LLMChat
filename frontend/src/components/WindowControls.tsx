import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { positionWindowPopover } from "../viewportLayout";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initializeAppClose } from "../appClose";
import { logRuntimeError } from "../runtimeLog";
import { showAppNotice } from "./AppNotice";
import { AppDownloadsButton } from "./AppDownloadsButton";
import { FeatureIcon } from "./FeatureIcon";
import { ApplicationHelpPage } from "./GameWorkflowHelp";
import { THEMES, getTheme, onThemeChange, setTheme } from "../theme";

export { positionWindowPopover } from "../viewportLayout";

function DesktopWindowControls({ mainWindow }: { mainWindow: boolean }) {
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
    if (mainWindow) await initializeAppClose();
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

function AppearanceButton() {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [theme, setSelectedTheme] = useState(getTheme);
  const [open, setOpen] = useState(false);

  useEffect(() => onThemeChange(setSelectedTheme), []);

  return <>
    <button type="button" className="window-action" popoverTarget={id}
      aria-haspopup="dialog" aria-controls={id} aria-expanded={open} aria-label="外观"
      data-tooltip="外观" onClick={event => positionWindowPopover(event.currentTarget, panel.current)}>
      <span aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.3 0 2.1-.9 2.1-1.9 0-1.5-1.6-1.7-1.6-3 0-.9.7-1.6 1.7-1.6H16a4.5 4.5 0 0 0 4.5-4.5c0-3.3-3.8-6-8.5-6Z" />
        <circle cx="8" cy="9.2" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="12" cy="7.4" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="15.8" cy="9.4" r="1.1" fill="currentColor" stroke="none" />
      </svg></span>
    </button>
    <div ref={panel} id={id} popover="auto" className="nav-appearance-popover window-action-popover" role="dialog"
      aria-label="外观" onToggle={event => setOpen(event.currentTarget.matches(":popover-open"))}>
      {THEMES.map(option => <button key={option.id} type="button" className="nav-appearance-option"
        aria-pressed={theme === option.id} onClick={() => setTheme(option.id)}>
        <span className="nav-appearance-swatch" aria-hidden="true" style={{
          "--swatch-base": option.swatch[0],
          "--swatch-panel": option.swatch[1],
          "--swatch-accent": option.swatch[2],
        } as CSSProperties} />
        <span>{option.label}</span>
        {theme === option.id && <span aria-hidden="true">✓</span>}
      </button>)}
    </div>
  </>;
}

export function WindowControls({ title, help }: {
  title?: string;
  help?: { open: boolean; toggle: () => void };
}) {
  const nativeWindow = window.self === window.top && isTauri();
  const mainWindow = nativeWindow && getCurrentWebview().label === "main";
  const desktop = mainWindow || nativeWindow && !!title;
  if (!desktop && !help && !title) return null;
  const dragRegion = desktop ? "" : undefined;
  return <>
    <div className="window-bar" data-tauri-drag-region={dragRegion} aria-hidden={title ? undefined : true}>
      {title && <span className="window-bar-title" data-tauri-drag-region={dragRegion}>{title}</span>}
    </div>
    <div className="window-controls" role="group" aria-label="标题栏">
      <div className="window-actions" role="group" aria-label="应用快捷操作">
        <AppearanceButton />
        {help && <button type="button" className="window-action" aria-label="帮助" data-tooltip="帮助"
          aria-expanded={help.open} onClick={help.toggle}><span><FeatureIcon feature="help" /></span></button>}
        <AppDownloadsButton />
      </div>
      {desktop && <DesktopWindowControls mainWindow={mainWindow} />}
    </div>
  </>;
}

export function AuxiliaryWindowChrome({ title, children }: { title: string; children: ReactNode }) {
  const [helpOpen, setHelpOpen] = useState(false);
  return <div className="game-aux-shell">
    <WindowControls title={title} help={{ open: helpOpen, toggle: () => setHelpOpen(open => !open) }} />
    <div className="game-aux-content" hidden={helpOpen}>{children}</div>
    {helpOpen && <div className="game-aux-content">
      <ApplicationHelpPage onBack={() => setHelpOpen(false)} />
    </div>}
  </div>;
}
