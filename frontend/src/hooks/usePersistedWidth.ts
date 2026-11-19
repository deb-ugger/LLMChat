import { useCallback, type MouseEvent } from "react";
import { usePersistedSize } from "./usePersistedSize";

export function usePersistedWidth(storageKey: string, defaultWidth: number, min: number, max: number,
  resizeMode: "live" | "guide" = "live",
) {
  const { size, setSize, beginResize: begin } = usePersistedSize(storageKey, defaultWidth, min, max, "x");
  const beginResize = useCallback((event: MouseEvent, mode: "grow-right" | "grow-left") => {
    const direction = mode === "grow-right" ? 1 : -1;
    const handle = event.currentTarget;
    const pane = mode === "grow-right" ? handle.previousElementSibling : handle.nextElementSibling;
    const container = handle.parentElement;
    if (resizeMode !== "guide" || !(handle instanceof HTMLElement) || !(pane instanceof HTMLElement) || !container) {
      begin(event, direction);
      return;
    }
    const { width, maxWidth } = getComputedStyle(pane);
    let paneLimit = max;
    if (maxWidth.endsWith("%")) {
      const { paddingLeft, paddingRight } = getComputedStyle(container);
      const contentWidth = container.clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight);
      paneLimit = contentWidth * parseFloat(maxWidth) / 100;
    } else if (maxWidth.endsWith("px")) paneLimit = parseFloat(maxWidth);
    begin(event, direction, { handle, startSize: parseFloat(width), maxSize: Math.max(min, Math.min(max, paneLimit)) });
  }, [begin, max, min, resizeMode]);
  return { width: size, setWidth: setSize, beginResize };
}
