import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, type RefObject } from "react";
import { useChartColors } from "./chartTheme";
import type { SystemPerformancePoint } from "../benchmark/systemPerformanceTypes";

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

type MetricKey = "cpu" | "memory" | "disk" | "network" | "gpu";

const METRICS: { key: MetricKey; label: string }[] = [
  { key: "cpu", label: "CPU" },
  { key: "memory", label: "内存" },
  { key: "disk", label: "磁盘" },
  { key: "network", label: "以太网" },
  { key: "gpu", label: "GPU" },
];

function formatValue(key: MetricKey, value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  if (key === "network" || key === "disk") {
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB/s`;
    if (value >= 1024) return `${(value / 1024).toFixed(0)} KB/s`;
    return `${value.toFixed(0)} B/s`;
  }
  return `${value.toFixed(0)}%`;
}

function useTimeline(
  hostRef: RefObject<HTMLDivElement | null>,
  points: readonly SystemPerformancePoint[],
  colors: ReturnType<typeof useChartColors>,
) {
  useEffect(() => {
    const host = hostRef.current;
    if (!host || points.length === 0) return;
    const chart = echarts.init(host, undefined, { renderer: "canvas" });
    const times = points.map((point) =>
      typeof point.at === "number" ? point.at : Date.parse(point.at),
    );
    chart.setOption({
      animation: false,
      grid: { top: 4, right: 4, bottom: 4, left: 4, containLabel: false },
      tooltip: {
        trigger: "axis",
        backgroundColor: colors.panel,
        borderColor: colors.border,
        textStyle: { color: colors.text, fontSize: colors.captionSize },
        axisPointer: { type: "line", lineStyle: { color: colors.borderStrong } },
      },
      xAxis: { type: "time", show: false },
      yAxis: { type: "value", show: false, min: 0, max: 100 },
      series: [
        {
          name: "CPU",
          type: "line",
          showSymbol: false,
          smooth: true,
          lineStyle: { width: 1.4, color: colors.text },
          data: points.map((point, i) => [times[i], point.cpu]),
        },
        {
          name: "内存",
          type: "line",
          showSymbol: false,
          lineStyle: { width: 1, color: colors.mutedText },
          data: points.map((point, i) => [times[i], point.memory]),
        },
        {
          name: "GPU",
          type: "line",
          showSymbol: false,
          smooth: true,
          lineStyle: { width: 1.4, color: colors.warning },
          data: points.map((point, i) => [times[i], point.gpu]),
        },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [hostRef, points, colors]);
}

export function SystemPerfBar({
  latest,
  points,
}: {
  latest: SystemPerformancePoint | null;
  points: readonly SystemPerformancePoint[];
}) {
  const colors = useChartColors();
  const chartRef = useRef<HTMLDivElement | null>(null);
  useTimeline(chartRef, points, colors);
  const hasData = METRICS.some(({ key }) => latest?.[key] != null);

  return (
    <div className="game-benchmark-sysbar" role="status" aria-label="系统性能">
      <span className="game-benchmark-sys-title">性能</span>
      {METRICS.map(({ key, label }) => {
        const value = latest?.[key] ?? null;
        const peak = points.reduce<number | null>((max, point) => {
          const current = point[key];
          if (current == null) return max;
          return max == null || current > max ? current : max;
        }, null);
        return (
          <span className="game-benchmark-sys-item" key={key}>
            <span>{label}</span>
            <strong>{formatValue(key, value)}</strong>
            {peak != null && value != null ? <small>峰 {formatValue(key, peak)}</small> : null}
          </span>
        );
      })}
      <div className="game-benchmark-syschart">
        {hasData && points.length > 0 ? (
          <div ref={chartRef} className="game-benchmark-syschart-canvas" role="img" aria-label="最近 30 分钟 CPU、内存和 GPU 趋势" />
        ) : (
          <span className="game-benchmark-syschart-empty">等待采样</span>
        )}
      </div>
    </div>
  );
}
