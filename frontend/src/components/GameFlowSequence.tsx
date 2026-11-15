import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useGameActionConfirm } from "./GameActionConfirm";

export type GameFlowStep = {
  id: string;
  title: string;
  summary?: string;
  state: "done" | "current" | "waiting";
  run?: () => void;
  stop?: () => void;
  runLabel?: string;
  runDisabled?: boolean;
  clear?: () => void;
};
type Activity = { step: string; state: string; progress?: ReactNode };
const stateLabels: Record<string, string> = {
  done: "已完成", current: "未完成", waiting: "等待上一步",
  running: "正在处理", error: "失败", stopped: "已中止",
};
// Layout-only session state. Closing the app starts a new module instance.
const settingsHeights = new Map<string, number>();

export function GameFlowSequence({ steps, configured, onConfigure, onRun, actions, activity, children, onSaveConfiguration, configurationScope, configuration, restoreConfiguration }: {
  steps: GameFlowStep[];
  configured: string | null;
  onConfigure: (step: string | null) => void;
  onRun?: () => void;
  onSaveConfiguration?:()=>void|Promise<void>;
  configurationScope: string | null;
  configuration: Readonly<Partial<Record<string, string>>>;
  restoreConfiguration: (step: string) => void;
  actions?: ReactNode;
  activity?: Activity;
  children?: ReactNode;
}) {
  const [savingConfiguration, setSavingConfiguration] = useState(false);
  const [configurationError, setConfigurationError] = useState("");
  const snapshot = { scope: configurationScope, values: configuration, restore: restoreConfiguration };
  const [saved, setSaved] = useState(snapshot);
  const { dialog, message } = useGameActionConfirm();
  if (saved.scope !== configurationScope) {
    setSaved(snapshot);
    setConfigurationError("");
  }
  const changed = (step: string) => !!configurationScope && saved.scope === configurationScope && configuration[step] !== saved.values[step];
  const withConfiguration = async (action?: () => void, manualStep?: string) => {
    if (savingConfiguration || (manualStep && !changed(manualStep))) return;
    setConfigurationError("");
    if (!onSaveConfiguration || !Object.keys(configuration).some(changed)) { action?.(); return; }
    setSavingConfiguration(true);
    try {
      await onSaveConfiguration();
      setSaved(previous => previous.scope === configurationScope ? snapshot : previous);
      if (manualStep) void message(`${steps.find(step => step.id === manualStep)?.title ?? "当前步骤"}的配置已保存。`, { title: "保存成功" });
      action?.();
    } catch (error) {
      setConfigurationError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingConfiguration(false);
    }
  };
  const panel = useRef<HTMLDivElement>(null);
  const cancelConfiguration = (step: string) => {
    if (changed(step)) saved.restore(step);
    setConfigurationError("");
    onConfigure(null);
  };
  const content = useRef<HTMLDivElement>(null);
  const layoutKey = steps.map(step => step.id).join("/") + ":" + configured;
  useLayoutEffect(() => {
    const element = panel.current;
    const body = content.current;
    if (!configured || !element || !body) return;
    const grow = () => {
      const height = Math.max(settingsHeights.get(layoutKey) || 0, Math.ceil(body.getBoundingClientRect().height));
      settingsHeights.set(layoutKey, height);
      element.style.minHeight = height + "px";
    };
    grow();
    const observer = new ResizeObserver(grow);
    observer.observe(body);
    return () => observer.disconnect();
  }, [configured, layoutKey]);
  return <div className="game-flow">
    {dialog}
    <div className="game-flow-list">
      {(onRun || actions) && <div className="game-flow-run">
        {onRun && <button type="button" className="unity-btn unity-btn-primary" disabled={savingConfiguration} onClick={()=>void withConfiguration(onRun)}>运行流程</button>}
        {actions}
      </div>}
      <ol>{steps.map(step => {
        const matchesActivity = activity?.step === step.id;
        const state = matchesActivity && ["running", "error", "stopped"].includes(activity.state) ? activity.state : step.state;
        const current = state === "running" || (activity?.state === "running" ? false : step.state === "current");
        const expanded = configured === step.id;
        const clearAllowed = !!step.clear && step.state !== "waiting" && state !== "running";
        return <li key={step.id} className={`game-flow-item is-${state}`}><div className={`game-flow-step is-${state}${current ? " is-current-step" : ""}${expanded ? " is-configured" : ""}`}>
          <div className="game-flow-row">
            <button type="button" className="game-flow-step-toggle" aria-label={`${expanded ? "收起" : "展开"}${step.title}设置`}
              aria-expanded={expanded} data-tooltip={expanded ? "收起设置" : "展开设置"} onClick={() => onConfigure(expanded ? null : step.id)} />
            <div className="game-flow-step-main"><strong>{step.title}</strong><small>{stateLabels[state]}</small></div>
            <div className="game-flow-summary" data-tooltip={step.summary}>{step.summary}</div>
            <div className="game-flow-actions">
              {(step.run || step.stop) && <button type="button" className="unity-btn unity-btn-primary game-flow-start"
                aria-label={`${step.stop ? "中止" : step.runLabel || "开始"}${step.title}`} disabled={step.runDisabled||savingConfiguration}
                onClick={step.stop || (()=>void withConfiguration(step.run))}>{step.stop ? "中止" : step.runLabel || "开始"}</button>}
              <button type="button" className="unity-btn game-flow-clear" disabled={!clearAllowed||savingConfiguration} aria-label={`清理${step.title}`} onClick={()=>void withConfiguration(step.clear)}>清理</button>
            </div>
          </div>
          </div>
          {expanded && children && <div ref={panel} className="game-flow-config" role="region" aria-label={`${step.title}设置`}>
            <div ref={content} className="game-flow-config-content">
              {children}
              {onSaveConfiguration && <div className="game-flow-config-save">
                <button type="button" className="unity-btn unity-btn-primary" disabled={savingConfiguration || activity?.state === "running" || !changed(step.id)} onClick={() => void withConfiguration(undefined, step.id)}>{savingConfiguration ? "保存中…" : "保存配置"}</button>
                <button type="button" className="unity-btn" disabled={savingConfiguration || activity?.state === "running"} onClick={() => cancelConfiguration(step.id)}>取消</button>
              </div>}
            </div>
          </div>}
        </li>;
      })}</ol>
    </div>
    {configurationError&&<p className="unity-offline-error" role="alert">配置保存失败：{configurationError}</p>}
    {activity?.progress && <div className="game-flow-progress">{activity.progress}</div>}
  </div>;
}
