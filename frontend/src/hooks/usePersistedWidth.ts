import { useCallback, type MouseEvent } from "react";
import { usePersistedSize } from "./usePersistedSize";

export function usePersistedWidth(storageKey: string, defaultWidth: number, min: number, max: number) {
  const { size, setSize, beginResize: begin } = usePersistedSize(storageKey, defaultWidth, min, max, "x");
  const beginResize = useCallback((event: MouseEvent, mode: "grow-right" | "grow-left") =>
    begin(event, mode === "grow-right" ? 1 : -1), [begin]);
  return { width: size, setWidth: setSize, beginResize };
}
