import { useEffect, useRef, useState } from "react";
import type {OcrMode,TranslateProvider} from "../api";
export type GameImageTask={kind:"scan"|"screen"|"refine"|"recognize"|"translate"|"review"|"render"|"redraw";imageId?:string;mode?:OcrMode;options?:{backend?:"auto"|"wasm"|"webgpu";strategy:"staged"|"full";mode:OcrMode;source:string;target:string;concurrency:number;provider:TranslateProvider;translationKind?:"llm"|"local"|"engine";translationModel?:string;reviewModel?:string;onlySourceLanguage?:boolean;skipTargetLanguage?:boolean}};
function restoreClock(key: string) {
  let saved: { total?: number; task?: GameImageTask } | null = null;
  try { saved = JSON.parse(localStorage.getItem(key) || "null"); }
  catch { /* An unreadable checkpoint starts a new timer. */ }
  return {
    total: Number(saved?.total) || 0,
    started: null as number | null,
    pending: saved?.task,
    tracksTask: false,
  };
}

export function useGameImageTask(gamePath: string) {
  const key = `llmchat-image-task:${gamePath}`;
  const ref = useRef<ReturnType<typeof restoreClock> | null>(null);
  const clock = ref.current ??= restoreClock(key);
  const [elapsed, setElapsed] = useState(clock.total);
  const [task, setTask] = useState(clock.pending);
  const [running, setRunning] = useState(false);
  const value = () => clock.total + (clock.started === null ? 0 : performance.now() - clock.started);
  const save = () => {
    try { localStorage.setItem(key, JSON.stringify({ total: value(), task: clock.pending })); }
    catch { /* The timer can run while local storage is unavailable. */ }
  };
  const select = (next: GameImageTask) => {
    clock.pending = next;
    clock.tracksTask = true;
    setTask(next);
    save();
  };
  const begin = (next?: GameImageTask) => {
    if (clock.started !== null) return;
    clock.started = performance.now();
    if (next) select(next);
    else {
      clock.tracksTask = false;
      save();
    }
    setRunning(true);
  };
  const finish = (success: boolean) => {
    clock.total = value();
    clock.started = null;
    if (success && clock.tracksTask) {
      clock.pending = undefined;
      setTask(undefined);
    }
    clock.tracksTask = false;
    setElapsed(clock.total);
    setRunning(false);
    save();
  };
  const reset = () => {
    clock.started = null;
    clock.total = 0;
    clock.pending = undefined;
    clock.tracksTask = false;
    setElapsed(0);
    setTask(undefined);
    setRunning(false);
    save();
  };
  useEffect(() => {
    if (!running) return;
    let ticks = 0;
    const timer = setInterval(() => {
      setElapsed(value());
      if (++ticks % 5 === 0) save();
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => () => { save(); }, [key]);
  return { elapsed, task, pendingTask: () => clock.pending, begin, finish, select, reset };
}
export function imageTaskDuration(milliseconds:number){const seconds=Math.max(0,Math.floor(milliseconds/1000));return `${Math.floor(seconds/3600).toString().padStart(2,"0")}:${Math.floor(seconds%3600/60).toString().padStart(2,"0")}:${(seconds%60).toString().padStart(2,"0")}`;}
