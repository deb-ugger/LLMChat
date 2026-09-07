import { useCallback, type MouseEvent } from "react";
import { usePersistedSize } from "./usePersistedSize";

export type PersistedHeightOptions = { collapseBelow?: number };

export function usePersistedHeight(
  storageKey: string, defaultHeight: number, min: number, max: number,
  options?: PersistedHeightOptions,
) {
  const { size, setSize, beginResize: begin } = usePersistedSize(
    storageKey, defaultHeight, min, max, "y", options?.collapseBelow,
  );
  const beginResize = useCallback((event: MouseEvent, mode: "grow-down" | "grow-up" = "grow-down") =>
    begin(event, mode === "grow-down" ? 1 : -1), [begin]);
  return { height: size, setHeight: setSize, beginResize, collapsed: size === 0 };
}
