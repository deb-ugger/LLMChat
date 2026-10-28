import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export function UnityProjectLoading({ project, path, detail }: { project: string; path: string; detail: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    dialog.focus();
    return () => dialog.close();
  }, []);
  return createPortal(<dialog ref={ref} className="unity-project-loading" tabIndex={-1} aria-labelledby="unity-project-loading-title" aria-describedby="unity-project-loading-detail" aria-busy="true" onCancel={event => event.preventDefault()} onKeyDown={event => { event.preventDefault(); event.stopPropagation(); }}>
    <div className="unity-project-loading-content" role="status" aria-live="polite">
      <span className="unity-project-loading-spinner" aria-hidden="true" />
      <h2 id="unity-project-loading-title">正在加载 {project}</h2>
      <p id="unity-project-loading-detail">{detail}</p>
      <p className="unity-project-loading-path">{path}</p>
    </div>
  </dialog>, document.body);
}
