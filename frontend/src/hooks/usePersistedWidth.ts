import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function usePersistedWidth(
  storageKey: string,
  defaultWidth: number,
  min: number,
  max: number,
) {
  const [width, setWidth] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return defaultWidth;
      const n = Number(raw);
      return Number.isFinite(n) ? clamp(n, min, max) : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {
      // ignore
    }
  }, [storageKey, width]);

  const beginResize = useCallback(
    (e: ReactMouseEvent, mode: "grow-right" | "grow-left") => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = width;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const next =
          mode === "grow-right" ? startW + dx : startW - dx;
        setWidth(clamp(next, min, max));
      };
      const onUp = () => {
        document.body.classList.remove("col-resizing");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      document.body.classList.add("col-resizing");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [max, min, width],
  );

  return { width, setWidth, beginResize };
}
