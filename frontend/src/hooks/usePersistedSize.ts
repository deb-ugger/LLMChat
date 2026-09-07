import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** One frame update while dragging, final storage write, and unified cleanup. */
export function usePersistedSize(
  storageKey: string, initial: number, min: number, max: number,
  axis: "x" | "y", collapseBelow?: number,
) {
  const finishValue = useCallback((value: number) =>
    collapseBelow != null && value < collapseBelow ? 0 : clamp(value, min, max),
  [collapseBelow, min, max]);
  const [size, setSize] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const value = raw === null ? initial : Number(raw);
      return Number.isFinite(value) ? finishValue(value) : initial;
    } catch { return initial; }
  });
  const current = useRef(size);
  current.current = size;
  const dragging = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  const save = useCallback((value: number) => {
    try { localStorage.setItem(storageKey, String(value)); } catch { /* Storage may be disabled. */ }
  }, [storageKey]);

  useEffect(() => { if (!dragging.current) save(size); }, [save, size]);
  useEffect(() => () => { cleanup.current?.(); }, []);

  const beginResize = useCallback((event: MouseEvent, direction: 1 | -1) => {
    event.preventDefault();
    event.stopPropagation();
    cleanup.current?.();
    const origin = axis === "x" ? event.clientX : event.clientY;
    const initialSize = current.current;
    let latest = initialSize;
    let frame = 0;
    const className = axis === "x" ? "col-resizing" : "row-resizing";
    dragging.current = true;
    const remove = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("blur", finish);
      document.body.classList.remove(className);
      dragging.current = false;
      cleanup.current = null;
    };
    const finish = () => {
      remove();
      const finalSize = finishValue(latest);
      current.current = finalSize;
      setSize(finalSize);
      save(finalSize);
    };
    const move = (event: globalThis.MouseEvent) => {
      const position = axis === "x" ? event.clientX : event.clientY;
      latest = clamp(initialSize + (position - origin) * direction, collapseBelow != null ? 0 : min, max);
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        setSize(latest);
      });
    };
    cleanup.current = () => { remove(); save(finishValue(latest)); };
    document.body.classList.add(className);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", finish);
    window.addEventListener("blur", finish);
  }, [axis, collapseBelow, finishValue, max, min, save]);

  return { size, setSize, beginResize };
}
