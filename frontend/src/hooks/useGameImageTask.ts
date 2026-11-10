import {useEffect,useRef,useState} from "react";
import type {OcrMode,TranslateProvider} from "../api";
export type GameImageTask={kind:"scan"|"screen"|"recognize"|"translate";imageId?:string;mode?:OcrMode;options?:{backend?:"auto"|"wasm"|"webgpu";strategy:"staged"|"full";mode:OcrMode;source:string;target:string;concurrency:number;provider:TranslateProvider}};
export function useGameImageTask(gamePath:string){
  const key=`llmchat-image-task:${gamePath}`;
  const initial=useRef<{total:number;task?:GameImageTask}|undefined>(undefined);
  if(!initial.current){try{initial.current=JSON.parse(localStorage.getItem(key)||"null")||{total:0};}catch{initial.current={total:0};}}
  const total=useRef(Number(initial.current!.total)||0),started=useRef<number|null>(null),pending=useRef(initial.current!.task),operation=useRef<GameImageTask|undefined>(undefined);
  const [elapsed,setElapsed]=useState(total.current),[task,setTask]=useState(pending.current),[running,setRunning]=useState(false);
  const value=()=>total.current+(started.current===null?0:performance.now()-started.current);
  const save=()=>{try{localStorage.setItem(key,JSON.stringify({total:value(),task:pending.current}));}catch{/* Local storage may be disabled. */}};
  const select=(next:GameImageTask)=>{pending.current=next;operation.current=next;setTask(next);save();};
  const begin=(next?:GameImageTask)=>{if(started.current!==null)return;started.current=performance.now();operation.current=next;if(next)select(next);setRunning(true);save();};
  const finish=(success:boolean)=>{total.current=value();started.current=null;if(success&&operation.current){pending.current=undefined;setTask(undefined);}operation.current=undefined;setElapsed(total.current);setRunning(false);save();};
  useEffect(()=>{if(!running)return;let ticks=0;const timer=setInterval(()=>{setElapsed(value());if(++ticks%5===0)save();},1000);return()=>clearInterval(timer);},[running]);
  useEffect(()=>()=>{save();},[key]);
  return {elapsed,task,begin,finish,select};
}
export function imageTaskDuration(milliseconds:number){const seconds=Math.max(0,Math.floor(milliseconds/1000));return `${Math.floor(seconds/3600).toString().padStart(2,"0")}:${Math.floor(seconds%3600/60).toString().padStart(2,"0")}:${(seconds%60).toString().padStart(2,"0")}`;}
