import {createElement,useEffect,useRef,useState,type DragEvent,type RefObject} from "react";
import {createPortal} from "react-dom";
import {isTauri} from "@tauri-apps/api/core";
import {getCurrentWindow} from "@tauri-apps/api/window";
import type {GameImportSource} from "../gameImageImport";
export function gameDropTarget(position:{x:number;y:number}):Element|null{return document.elementFromPoint(position.x/window.devicePixelRatio,position.y/window.devicePixelRatio);}
export function useGameFileDrop(options:{active:boolean;busy?:boolean;root:RefObject<HTMLElement|null>;match:(target:Element|null,names:string[])=>HTMLElement|null;label:(target:HTMLElement)=>string;drop:(source:GameImportSource,target:HTMLElement)=>Promise<unknown>;error:(text:string)=>void}){
 const latest=useRef(options);latest.current=options;
 const [hover,setHover]=useState<HTMLElement|null>(null),[pending,setPending]=useState<HTMLElement|null>(null),working=useRef(false);
 const nativeNames=useRef<string[]>([]);
 const targetFor=(target:Element|null,names:string[])=>{const value=latest.current;if(!value.active||working.current||!target||!value.root.current?.contains(target))return null;return value.match(target,names);};
 const perform=async(source:GameImportSource,target:HTMLElement)=>{if(working.current)return;working.current=true;setHover(null);setPending(target);try{await latest.current.drop(source,target);}catch(error){latest.current.error(error instanceof Error?error.message:String(error));}finally{working.current=false;setPending(null);}};
 useEffect(()=>{if(!isTauri())return;let disposed=false,unlisten:(()=>void)|undefined;
  void getCurrentWindow().onDragDropEvent(event=>{const payload=event.payload;if(payload.type==="leave"){setHover(null);nativeNames.current=[];return;}
   if(payload.type==="enter")nativeNames.current=payload.paths;
   const names=payload.type==="drop"?payload.paths:nativeNames.current;
   const area=targetFor(gameDropTarget(payload.position),names);
   if(payload.type==="drop"){setHover(null);if(area&&names.length===1)void perform(names[0],area);}
   else setHover(area);
  }).then(value=>{if(disposed)value();else unlisten=value;}).catch(error=>latest.current.error(String(error)));
  return()=>{disposed=true;unlisten?.();};
 },[]);
 useEffect(()=>{if(!options.active)setHover(null);},[options.active]);
 useEffect(()=>{const element=pending||(options.busy?options.root.current:null);if(!element)return;element.classList.add("game-drop-importing");return()=>element.classList.remove("game-drop-importing");},[pending,options.busy,options.root]);
 const handlers={
  onDragOver:(event:DragEvent<HTMLElement>)=>{if(!event.dataTransfer.types.includes("Files"))return;event.preventDefault();event.stopPropagation();const names=[...event.dataTransfer.files].map(file=>file.name);if(!names.length&&event.dataTransfer.items[0]?.type.startsWith("image/"))names.push("image.png");setHover(targetFor(event.target as Element,names));},
  onDragLeave:(event:DragEvent<HTMLElement>)=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setHover(null);},
  onDrop:(event:DragEvent<HTMLElement>)=>{event.preventDefault();event.stopPropagation();const files=[...event.dataTransfer.files];const area=targetFor(event.target as Element,files.map(file=>file.name));setHover(null);if(area&&files.length===1)void perform(files[0],area);else if(files.length>1)latest.current.error("一次请拖入一张图片或一个压缩包");}
 };
 const target=pending||(options.busy?options.root.current:null)||hover,rect=target?.getBoundingClientRect(),loading=!!pending||!!options.busy;
 const overlay=rect&&rect.width>0&&rect.height>0&&createPortal(createElement("div",{className:`game-drop-overlay ${loading?"is-loading":""}`,style:{left:rect.left,top:rect.top,width:rect.width,height:rect.height}},loading&&createElement("span",{className:"game-drop-spinner"}),createElement("strong",null,loading?"正在导入…":latest.current.label(target!))),document.body);
 return {handlers,overlay};
}
