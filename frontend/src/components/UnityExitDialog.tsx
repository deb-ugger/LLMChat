import { useEffect, useRef } from "react";
import "./UnityExitDialog.css";

export type UnityExitChoice = "save" | "discard" | "cancel";

export function UnityExitDialog({ running, projectOnly, changes, onChoice }: {
  running: boolean; projectOnly: boolean; changes: string[]; onChoice: (choice: UnityExitChoice) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current!;
    element.showModal(); cancel.current?.focus();
    return () => { element.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="unity-exit-dialog" aria-labelledby="unity-exit-title" aria-describedby="unity-exit-description" onCancel={event => { event.preventDefault(); onChoice("cancel"); }}>
    <h2 id="unity-exit-title">{projectOnly ? "离开当前工程" : "退出 LLMChat"}</h2>
    <p id="unity-exit-description">{running ? "退出前将中止当前任务或等待资源处理结束。请选择是否保存当前工程。" : "当前修改尚未保存，请选择退出方式。"}</p>
    <div className="unity-exit-changes"><strong>尚未保存的内容</strong><ul>{changes.slice(0, 10).map((change, index) => <li key={index}>{change}</li>)}</ul>{changes.length > 10 && <p>另有 {changes.length - 10} 项修改</p>}</div>
    <p>不保存退出将放弃尚未保存的修改，已自动保存的任务进度会保留。</p>
    <div className="unity-exit-actions">
      <button type="button" className="unity-btn" onClick={() => onChoice("discard")}>不保存退出</button>
      <button type="button" className="unity-btn unity-btn-primary" onClick={() => onChoice("save")}>保存后退出</button>
      <button ref={cancel} type="button" className="unity-btn" onClick={() => onChoice("cancel")}>取消</button>
    </div>
  </dialog>;
}
