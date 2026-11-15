import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { requestForceAppClose } from "../appClose";
import "./ClosingProgress.css";

export function useClosingProgress() {
  const [phase, setPhase] = useState<string | null>(null);
  const opened = useRef(false);
  const show = useCallback(async (detail: string) => {
    const wasOpen = opened.current; opened.current = true;
    flushSync(() => setPhase(detail));
    if (wasOpen || document.visibilityState === "hidden") return;
    // Occluded WebView windows may never produce animation frames.
    await new Promise<void>(resolve => {
      let first = 0, second = 0;
      const finish = () => { clearTimeout(timer); cancelAnimationFrame(first); cancelAnimationFrame(second); resolve(); };
      const timer = window.setTimeout(finish, 120);
      first = window.requestAnimationFrame(() => { second = window.requestAnimationFrame(finish); });
    });
  }, []);
  const clear = useCallback(() => { opened.current = false; setPhase(null); }, []);
  return { phase, show, clear };
}

export function ClosingProgress({ phase }: { phase: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [slow, setSlow] = useState(false), [forcing, setForcing] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setSlow(true), 15000); return () => clearTimeout(timer); }, []);
  useLayoutEffect(() => {
    const element = dialog.current!; element.showModal();
    return () => element.close();
  }, []);
  return createPortal(<dialog ref={dialog} className="closing-progress" aria-labelledby="closing-progress-title" aria-describedby="closing-progress-detail" aria-busy="true" onCancel={event => event.preventDefault()}>
    <h2 id="closing-progress-title"><span className="closing-progress-spinner" aria-hidden="true" />正在关闭</h2>
    <p id="closing-progress-detail" role="status" aria-live="polite">{phase}</p>
    {slow && <div className="closing-progress-actions"><button type="button" disabled={forcing} onClick={async () => { setForcing(true); try { await requestForceAppClose(); } finally { setForcing(false); } }}>强制退出</button></div>}
  </dialog>, document.body);
}
