import type { ReactNode } from "react";
import { useGameWorkspaceSplit } from "../hooks/useGameWorkspaceSplit";
import "../unityOffline.css";

export function UnityGameWorkspace({ steps, controls, results, active, deployment, mosaic }: {
  steps: ReactNode;
  controls: ReactNode;
  results: ReactNode;
  active: boolean;
  deployment: boolean;
  mosaic: boolean;
}) {
  const { workspaceRef, workspaceStyle, panelRef, panelStyle, dividerProps } = useGameWorkspaceSplit(active && !deployment, mosaic);
  return <div ref={workspaceRef} style={workspaceStyle} className={`unity-offline${deployment ? " is-deployment" : mosaic ? " is-mosaic" : ""}`}>
    <aside ref={panelRef} className="unity-offline-config" style={deployment ? undefined : panelStyle}>
      <div className="unity-offline-upper unity-workflow-layout">
        {steps}
        <section className="unity-generation unity-workflow" aria-label="分步设置与当前任务">{controls}</section>
      </div>
    </aside>
    {!deployment && <button {...dividerProps} />}
    {results}
  </div>;
}
