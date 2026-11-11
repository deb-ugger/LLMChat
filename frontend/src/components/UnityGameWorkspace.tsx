import {useLayoutEffect,useRef,useState,type ReactNode} from "react";
import {usePersistedWidth} from "../hooks/usePersistedWidth";
import {usePersistedHeight} from "../hooks/usePersistedHeight";
import "../unityOffline.css";
/** Unity's workspace DOM, sizing keys and styles, with engine-specific contents. */
export function UnityGameWorkspace({controls,results,output}:{controls:ReactNode;results:ReactNode;output:ReactNode}){
 const width=usePersistedWidth("unity-offline-panel-width",480,300,900);
 const root=useRef<HTMLDivElement>(null);const [height,setHeight]=useState(window.innerHeight-100);
 useLayoutEffect(()=>{if(!root.current)return;const observer=new ResizeObserver(entries=>setHeight(entries[0].contentRect.height));observer.observe(root.current);return()=>observer.disconnect();},[]);
 const upper=usePersistedHeight("unity-offline-upper-height",520,300,Math.max(300,height-180));
 return <div ref={root} className="unity-offline">
 <aside className="unity-offline-config" style={{width:width.width}}>
 <div className="unity-offline-upper is-manual" style={{height:Math.min(upper.height,Math.max(300,height-180))}}><section className="unity-generation unity-workflow" aria-label="分步设置与当前任务">{controls}</section></div>
 <button className="unity-output-divider" role="separator" aria-orientation="horizontal" aria-label="调整步骤和输出区域高度" aria-valuenow={upper.height} onMouseDown={event=>upper.beginResize(event)} onKeyDown={event=>{if(event.key==="ArrowUp"||event.key==="ArrowDown"){event.preventDefault();upper.setHeight(upper.height+(event.key==="ArrowDown"?16:-16));}}}/>
 {output}
 </aside>
 <button className="unity-workspace-divider" role="separator" aria-orientation="vertical" aria-label="调整步骤区和结果区宽度" aria-valuenow={width.width} onMouseDown={event=>width.beginResize(event,"grow-right")} onKeyDown={event=>{if(event.key==="ArrowLeft"||event.key==="ArrowRight"){event.preventDefault();width.setWidth(width.width+(event.key==="ArrowRight"?16:-16));}}}/>
 {results}
 </div>;
}
