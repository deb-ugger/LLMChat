import { useLayoutEffect, useRef } from "react";
import "./UnityImportDialog.css";

export type UnityImportChoice = "replace" | "fill" | "cancel";

export function UnityImportDialog({ container, error, onChoice }: { container: HTMLElement | null; error: string; onChoice: (choice: UnityImportChoice) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    const position = () => {
      const rect = container?.getBoundingClientRect();
      if (!rect) return;
      element.style.left = `${rect.left + rect.width / 2}px`;
      element.style.top = `${rect.top + rect.height / 2}px`;
      element.style.width = `${Math.min(480, rect.width - 32)}px`;
      element.style.maxHeight = `${Math.max(160, rect.height - 32)}px`;
    };
    position(); element.showModal();
    const observer = new ResizeObserver(position); if (container) observer.observe(container);
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); element.close(); };
  }, [container]);
  return <dialog ref={dialog} className="unity-import-dialog" aria-labelledby="unity-import-title" onCancel={event => { event.preventDefault(); onChoice("cancel"); }}>
    <h2 id="unity-import-title">保存导入译文</h2>
    <p className="unity-import-notice">保存后会清空「生成补丁」和「应用到游戏」的进度，需要重新生成并应用。</p>
    <p className="unity-import-retained">已安装补丁保留至再次应用时替换，图片处理进度保留。</p>
    {error && <p role="alert" className="unity-import-error">{error}</p>}
    <div className="unity-import-options">
      <button type="button" onClick={() => onChoice("replace")}><strong>覆盖保存</strong><span>替换对应译文，空译文也会覆盖</span></button>
      <button type="button" onClick={() => onChoice("fill")}><strong>只补充空白</strong><span>填充空白，保留已有译文和草稿</span></button>
    </div>
    <div className="unity-import-dialog-footer"><button type="button" autoFocus onClick={() => onChoice("cancel")}>取消</button></div>
  </dialog>;
}
