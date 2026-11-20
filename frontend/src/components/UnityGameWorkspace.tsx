import {type ReactNode} from "react";
import {usePersistedWidth} from "../hooks/usePersistedWidth";
import "../unityOffline.css";
/** Unity's workspace DOM, sizing keys and styles, with engine-specific contents. */
export function UnityGameWorkspace({steps,controls,results,deployment=false}:{steps:ReactNode;controls:ReactNode;results:ReactNode;deployment?:boolean}){
 const width=usePersistedWidth("unity-offline-panel-width",480,300,900,"guide");
 return <div className={deployment ? "unity-offline is-deployment" : "unity-offline"}>
 <aside className="unity-offline-config" style={deployment ? { width: "100%", maxWidth: "none" } : {width:width.width}}>
 <div className="unity-offline-upper unity-workflow-layout">{steps}<section className="unity-generation unity-workflow" aria-label="分步设置与当前任务">{controls}</section></div>
 </aside>
 {!deployment && <button className="unity-workspace-divider" role="separator" aria-orientation="vertical" aria-label="调整步骤区和结果区宽度" aria-valuenow={width.width} onMouseDown={event=>width.beginResize(event,"grow-right")} onKeyDown={event=>{if(event.key==="ArrowLeft"||event.key==="ArrowRight"){event.preventDefault();const pane=event.currentTarget.previousElementSibling;if(pane instanceof HTMLElement)width.setWidth(pane.offsetWidth+(event.key==="ArrowRight"?16:-16));}}}/>}
 {results}
 </div>;
}
