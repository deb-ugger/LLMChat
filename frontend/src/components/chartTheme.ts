import { useEffect, useState } from "react";
import { onThemeChange } from "../theme";

function readChartColors() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    panel: token("--bg-panel"),
    mutedPanel: token("--bg-muted"),
    border: token("--border"),
    borderStrong: token("--border-strong"),
    text: token("--text"),
    mutedText: token("--text-muted"),
    warning: token("--warning"),
    success: token("--success"),
    captionSize: Number.parseFloat(token("--fs-caption")),
    bodySize: Number.parseFloat(token("--fs-body")),
    radiusSmall: Number.parseFloat(token("--radius-sm")),
    radiusMedium: Number.parseFloat(token("--radius-md")),
    mono: token("--mono"),
  };
}

export type ChartColors = ReturnType<typeof readChartColors>;

export function useChartColors(): ChartColors {
  const [colors, setColors] = useState(readChartColors);
  useEffect(() => onThemeChange(() => setColors(readChartColors())), []);
  return colors;
}
