import { useCallback, useEffect, useRef, useState, type MouseEvent, type SetStateAction } from "react";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
type ResizeGuide = { handle: HTMLElement; startSize: number; maxSize: number };

/** One frame update while dragging, final storage write, and unified cleanup. */
export function usePersistedSize(
  storageKey: string, initial: number, min: number, max: number,
  axis: "x" | "y", collapseBelow?: number,
) {
  const finishValue = useCallback((value: number) =>
    collapseBelow != null && value < collapseBelow ? 0 : clamp(value, min, max),
  [collapseBelow, min, max]);
  const [preferredSize, setPreferredSize] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    } catch { return undefined; }
  });
  // Viewport limits affect display only; keep the saved preference for larger windows.
  const size = finishValue(preferredSize ?? initial);
  const current = useRef(size);
  current.current = size;
  const cleanup = useRef<(() => void) | null>(null);
  const save = useCallback((value: number) => {
    try { localStorage.setItem(storageKey, String(value)); } catch { /* Storage may be disabled. */ }
  }, [storageKey]);

  const setSize = useCallback((value: SetStateAction<number>) => {
    const next = finishValue(typeof value === "function" ? value(current.current) : value);
    current.current = next;
    setPreferredSize(next);
    save(next);
  }, [finishValue, save]);
  useEffect(() => () => { cleanup.current?.(); }, []);

  const beginResize = useCallback((event: MouseEvent, direction: 1 | -1, guide?: ResizeGuide) => {
    event.preventDefault();
    event.stopPropagation();
    cleanup.current?.();
    const origin = axis === "x" ? event.clientX : event.clientY;
    const initialSize = guide?.startSize ?? current.current;
    const handle = guide?.handle;
    const previousTranslate = handle?.style.translate ?? "";
    const previousZIndex = handle?.style.zIndex ?? "";
    if (handle) handle.style.zIndex = "2";
    let latest = initialSize;
    let frame = 0;
    const className = axis === "x" ? "col-resizing" : "row-resizing";
    const remove = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("blur", finish);
      if (handle) {
        handle.style.translate = previousTranslate;
        handle.style.zIndex = previousZIndex;
      }
      document.body.classList.remove(className);
      cleanup.current = null;
    };
    const finish = () => {
      remove();
      if (guide && latest === initialSize) return;
      const finalSize = finishValue(latest);
      current.current = finalSize;
      setPreferredSize(finalSize);
      save(finalSize);
    };
    const move = (event: globalThis.MouseEvent) => {
      const position = axis === "x" ? event.clientX : event.clientY;
      latest = clamp(initialSize + (position - origin) * direction, collapseBelow != null ? 0 : min, guide?.maxSize ?? max);
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (handle) {
          const offset = (latest - initialSize) * direction;
          handle.style.translate = axis === "x" ? `${offset}px 0` : `0 ${offset}px`;
        } else setPreferredSize(latest);
      });
    };
    cleanup.current = () => {
      remove();
      if (!guide) save(finishValue(latest));
    };
    document.body.classList.add(className);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", finish);
    window.addEventListener("blur", finish);
  }, [axis, collapseBelow, finishValue, max, min, save]);

  return { size, setSize, beginResize };
}
