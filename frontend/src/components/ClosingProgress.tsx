import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import "./ClosingProgress.css";

export function useClosingProgress() {
  const [phase, setPhase] = useState<string | null>(null);
  const show = useCallback(async (detail: string) => {
    flushSync(() => setPhase(detail));
    if (document.visibilityState === "hidden") return;
    // Let the dialog paint before serialization or image work occupies the UI thread.
    await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  }, []);
  const clear = useCallback(() => setPhase(null), []);
  return { phase, show, clear };
}

export function ClosingProgress({ phase }: { phase: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!; element.showModal();
    return () => element.close();
  }, []);
  return createPortal(<dialog ref={dialog} className="closing-progress" aria-labelledby="closing-progress-title" aria-describedby="closing-progress-detail" aria-busy="true" onCancel={event => event.preventDefault()}>
    <h2 id="closing-progress-title"><span className="closing-progress-spinner" aria-hidden="true" />正在关闭</h2>
    <p id="closing-progress-detail" role="status" aria-live="polite">{phase}</p>
  </dialog>, document.body);
}
