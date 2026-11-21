import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type CSSProperties, type PointerEvent } from "react";
import { usePersistedWidth } from "./usePersistedWidth";

const previewProperty = "--unity-panel-drag-width";

type PanelDrag = {
  divider: HTMLButtonElement;
  pointerId: number;
  startX: number;
  startWidth: number;
  latest: number;
  painted: number;
  zoom: number;
  frame: number;
  detach: () => void;
};

export function useGameWorkspaceSplit(enabled: boolean, mosaic = false) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const dividerRef = useRef<HTMLButtonElement>(null);
  const previewRef = mosaic ? workspaceRef : panelRef;
  const dragRef = useRef<PanelDrag | null>(null);
  const minWidth = mosaic ? 360 : 300;
  const [maxWidth, setMaxWidth] = useState(900);
  const maxWidthRef = useRef(maxWidth);
  const [mosaicViewport, setMosaicViewport] = useState(() => window.innerWidth);
  const workflowWidth = usePersistedWidth("unity-offline-panel-width", 480, 300, maxWidth);
  const mosaicWidth = usePersistedWidth("game-mosaic-step-column-width",
    Math.min(600, Math.max(420, mosaicViewport / 4)), 360, Math.max(360, Math.min(720, maxWidth)));
  const { width, setWidth } = mosaic ? mosaicWidth : workflowWidth;
  const committedWidth = useRef(width);

  const paint = useCallback((drag: PanelDrag) => {
    if (drag.painted === drag.latest) return;
    drag.painted = drag.latest;
    previewRef.current?.style.setProperty(previewProperty, `${drag.painted}px`);
    drag.divider.setAttribute("aria-valuenow", String(Math.round(drag.painted)));
  }, [previewRef]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry.contentRect.width) return;
      const styles = getComputedStyle(workspace);
      const fixedWidth = parseFloat(styles.getPropertyValue("--workflow-rail-width"))
        + (mosaic ? 3 * parseFloat(styles.columnGap) : parseFloat(styles.getPropertyValue("--workflow-column-gap")))
        + parseFloat(styles.getPropertyValue("--workflow-divider-width"));
      const paneSpace = entry.contentRect.width - fixedWidth;
      const limit = Math.max(minWidth, Math.min(mosaic ? 720 : 900, Math.floor(paneSpace - (mosaic ? 420 : 260))));
      if (mosaic) setMosaicViewport(window.innerWidth);
      maxWidthRef.current = limit;
      setMaxWidth(limit);
      const drag = dragRef.current;
      if (drag) {
        drag.latest = Math.min(drag.latest, limit);
        if (drag.painted > limit) paint(drag);
      }
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [mosaic, minWidth, paint]);

  const clearPreview = useCallback(() => {
    previewRef.current?.style.removeProperty(previewProperty);
    dividerRef.current?.setAttribute("aria-valuenow", String(Math.round(committedWidth.current)));
  }, [previewRef]);

  const endDrag = useCallback((pointerId?: number) => {
    const drag = dragRef.current;
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
    dragRef.current = null;
    cancelAnimationFrame(drag.frame);
    drag.detach();
    if (drag.divider.hasPointerCapture(drag.pointerId)) drag.divider.releasePointerCapture(drag.pointerId);
    return drag;
  }, []);

  const cancelDrag = useCallback((pointerId?: number) => {
    if (endDrag(pointerId)) clearPreview();
  }, [endDrag, clearPreview]);

  useLayoutEffect(() => {
    committedWidth.current = width;
    const drag = dragRef.current;
    if (drag) drag.divider.setAttribute("aria-valuenow", String(Math.round(drag.painted)));
    else clearPreview();
  }, [width, clearPreview]);

  const resizeActive = enabled && (!mosaic || mosaicViewport > 1080);
  useLayoutEffect(() => () => cancelDrag(), [resizeActive, cancelDrag]);

  function clampWidth(value: number) {
    return Math.max(minWidth, Math.min(maxWidth, maxWidthRef.current, value));
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!resizeActive || event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    const divider = event.currentTarget;
    divider.focus({ preventScroll: true });
    divider.setPointerCapture(event.pointerId);
    const onKey = (keyEvent: globalThis.KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      cancelDrag();
    };
    const onBlur = () => cancelDrag();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    dragRef.current = {
      divider, pointerId: event.pointerId, startX: event.clientX,
      startWidth: width, latest: width, painted: width,
      zoom: divider.currentCSSZoom || 1, frame: 0,
      detach: () => {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("blur", onBlur);
      },
    };
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    drag.latest = clampWidth(drag.startWidth + (event.clientX - drag.startX) / drag.zoom);
    if (!drag.frame) {
      drag.frame = requestAnimationFrame(() => {
        drag.frame = 0;
        if (dragRef.current === drag) paint(drag);
      });
    }
  }

  function commitDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = endDrag(event.pointerId);
    if (!drag) return;
    const finalWidth = clampWidth(drag.latest);
    // 保留预览，等 React 写入最终宽度后再清除临时变量。
    if (finalWidth === width) clearPreview();
    else setWidth(finalWidth);
  }

  const dividerProps: ComponentPropsWithRef<"button"> = {
    ref: dividerRef,
    type: "button",
    className: "unity-workspace-divider",
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "调整步骤区和结果区宽度",
    "aria-valuemin": minWidth,
    "aria-valuemax": maxWidth,
    "aria-valuenow": Math.round(width),
    style: { touchAction: "none", zIndex: 2 },
    onPointerDown: startDrag,
    onPointerMove: moveDrag,
    onPointerUp: commitDrag,
    onPointerCancel: event => cancelDrag(event.pointerId),
    onLostPointerCapture: event => cancelDrag(event.pointerId),
    onKeyDown: event => {
      if (!resizeActive || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      event.preventDefault();
      if (dragRef.current) return;
      const target = clampWidth(width + (event.key === "ArrowRight" ? 16 : -16));
      if (target !== width) setWidth(target);
    },
  };
  const workspaceStyle = mosaic ? { "--game-mosaic-step-column-width": `${width}px` } as CSSProperties : undefined;
  const panelStyle: CSSProperties | undefined = mosaic ? undefined : {
    width: `calc(var(${previewProperty}, ${width}px) + var(--workflow-rail-width) + var(--workflow-column-gap))`,
    minWidth: 0,
    maxWidth: "none",
  };
  return { workspaceRef, workspaceStyle, panelRef, panelStyle, dividerProps };
}
