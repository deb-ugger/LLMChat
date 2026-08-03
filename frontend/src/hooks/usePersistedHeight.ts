import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export type PersistedHeightOptions = {
  /**
   * If the pointer is released below this height, snap to 0 (collapsed).
   * While dragging, height may go down to 0.
   */
  collapseBelow?: number;
};

export function usePersistedHeight(
  storageKey: string,
  defaultHeight: number,
  min: number,
  max: number,
  options?: PersistedHeightOptions,
) {
  const collapseBelow = options?.collapseBelow;
  const floor = collapseBelow != null ? 0 : min;

  const [height, setHeight] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return defaultHeight;
      const n = Number(raw);
      if (!Number.isFinite(n)) return defaultHeight;
      if (collapseBelow != null && n === 0) return 0;
      return clamp(n, min, max);
    } catch {
      return defaultHeight;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(height));
    } catch {
      // ignore
    }
  }, [storageKey, height]);

  const beginResize = useCallback(
    (e: ReactMouseEvent, mode: "grow-down" | "grow-up" = "grow-down") => {
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startH = height;

      const onMove = (ev: MouseEvent) => {
        const dy = ev.clientY - startY;
        const next = mode === "grow-down" ? startH + dy : startH - dy;
        setHeight(clamp(next, floor, max));
      };
      const onUp = () => {
        document.body.classList.remove("row-resizing");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (collapseBelow != null) {
          setHeight((h) => {
            if (h < collapseBelow) return 0;
            if (h > 0 && h < min) return min;
            return h;
          });
        }
      };
      document.body.classList.add("row-resizing");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [collapseBelow, floor, height, max, min],
  );

  return {
    height,
    setHeight,
    beginResize,
    collapsed: height === 0,
  };
}
