import { useLayoutEffect, useRef, useState, type ComponentPropsWithRef } from "react";

const storageKey = "llmchat-training-dataset-list-width";
const defaultWidth = 320;
const minWidth = 280;
const clamp = (value: number, max: number) => Math.max(minWidth, Math.min(max, value));

// The workflow splitter includes rail/step-column geometry. This two-pane splitter
// keeps its pointer-capture/ARIA conventions without importing those layout rules.
export function useDatasetListSplit(enabled: boolean) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [preferred, setPreferred] = useState<number>();
  const [dragging, setDragging] = useState(false);
  const maximum = useRef(defaultWidth), current = useRef(defaultWidth);
  const gesture = useRef<{ pointer: number; divider: HTMLButtonElement; x: number; width: number; zoom: number } | undefined>(undefined);
  const detach = useRef<(() => void) | undefined>(undefined);
  const initialized = useRef(false);
  const maxWidth = containerWidth ? Math.max(minWidth, Math.min(Math.floor(containerWidth / 2), containerWidth - 360)) : defaultWidth;
  const width = clamp(preferred ?? defaultWidth, maxWidth);
  maximum.current = maxWidth;
  current.current = width;

  function save(value: number) {
    try { localStorage.setItem(storageKey, String(value)); } catch { /* Storage may be disabled. */ }
  }
  function setWidth(value: number) {
    const next = clamp(value, maximum.current);
    current.current = next; setPreferred(next); save(next);
  }
  function finish(cancel = false) {
    const drag = gesture.current;
    if (!drag) return;
    gesture.current = undefined;
    detach.current?.(); detach.current = undefined;
    if (drag.divider.hasPointerCapture(drag.pointer)) drag.divider.releasePointerCapture(drag.pointer);
    setDragging(false);
    if (cancel) { current.current = clamp(drag.width, maximum.current); setPreferred(current.current); }
    else save(current.current);
  }
  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!enabled || !workspace) return;
    const measure = () => {
      const measured = workspace.clientWidth;
      if (!measured) return;
      const limit = Math.max(minWidth, Math.min(Math.floor(measured / 2), measured - 360));
      maximum.current = limit;
      setContainerWidth(measured);
      if (!initialized.current) {
        initialized.current = true;
        let stored: number | undefined;
        try {
          const raw = localStorage.getItem(storageKey);
          if (raw !== null && raw.trim() !== "") stored = Number(raw);
        } catch { /* Use the default when storage is unavailable. */ }
        // Reject invalid preferences rather than clamping them to an unrelated edge.
        const next = stored !== undefined && Number.isFinite(stored) && stored >= minWidth && stored <= limit
          ? stored : clamp(defaultWidth, limit);
        current.current = next; setPreferred(next); save(next);
      } else if (gesture.current) {
        current.current = clamp(current.current, limit); setPreferred(current.current);
      }
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(workspace);
    return () => { observer.disconnect(); finish(); };
  }, [enabled]);

  const dividerProps: ComponentPropsWithRef<"button"> & { "data-tooltip": string; "data-dragging": boolean } = {
    type: "button", role: "separator", tabIndex: 0,
    className: "col-resizer-panel training-dataset-list-divider",
    "aria-label": "调整图片列表宽度", "aria-orientation": "vertical",
    "aria-valuemin": minWidth, "aria-valuemax": maxWidth, "aria-valuenow": Math.round(width),
    "data-tooltip": "拖动调整图片列表宽度；双击恢复320px；方向键调整，Home/End到边界",
    "data-dragging": dragging,
    onDoubleClick: () => { finish(); setWidth(defaultWidth); },
    onPointerDown: event => {
      if (event.button !== 0 || gesture.current) return;
      event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { pointer: event.pointerId, divider: event.currentTarget, x: event.clientX,
        width: current.current, zoom: event.currentTarget.currentCSSZoom || 1 };
      setDragging(true);
      const blur = () => finish(true);
      const escape = (key: KeyboardEvent) => { if (key.key === "Escape") { key.preventDefault(); finish(true); } };
      window.addEventListener("blur", blur); window.addEventListener("keydown", escape);
      detach.current = () => { window.removeEventListener("blur", blur); window.removeEventListener("keydown", escape); };
    },
    onPointerMove: event => {
      const drag = gesture.current;
      if (drag?.pointer !== event.pointerId) return;
      const next = clamp(drag.width + (event.clientX - drag.x) / drag.zoom, maximum.current);
      current.current = next; setPreferred(next);
    },
    onPointerUp: event => { if (gesture.current?.pointer === event.pointerId) finish(); },
    onPointerCancel: () => finish(true), onLostPointerCapture: () => finish(true),
    onKeyDown: event => {
      if (gesture.current || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      setWidth(event.key === "Home" ? minWidth : event.key === "End" ? maximum.current : current.current + (event.key === "ArrowRight" ? 16 : -16));
    },
  };
  return { workspaceRef, width, maxWidth, dividerProps };
}
