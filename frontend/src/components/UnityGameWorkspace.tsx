import {type ReactNode} from "react";
import {usePersistedWidth} from "../hooks/usePersistedWidth";
import "../unityOffline.css";
/** Unity's workspace DOM, sizing keys and styles, with engine-specific contents. */
export function UnityGameWorkspace({steps,controls,results}:{steps:ReactNode;controls:ReactNode;results:ReactNode}){
 const width=usePersistedWidth("unity-offline-panel-width",480,300,900);
 return <div className="unity-offline">
 <aside className="unity-offline-config" style={{width:width.width}}>
 <div className="unity-offline-upper unity-workflow-layout">{steps}<section className="unity-generation unity-workflow" aria-label="分步设置与当前任务">{controls}</section></div>
 </aside>
 <button className="unity-workspace-divider" role="separator" aria-orientation="vertical" aria-label="调整步骤区和结果区宽度" aria-valuenow={width.width} onMouseDown={event=>width.beginResize(event,"grow-right")} onKeyDown={event=>{if(event.key==="ArrowLeft"||event.key==="ArrowRight"){event.preventDefault();width.setWidth(width.width+(event.key==="ArrowRight"?16:-16));}}}/>
 {results}
 </div>;
}
