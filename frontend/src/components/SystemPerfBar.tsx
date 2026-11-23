import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useChartColors } from "./chartTheme";
import type { SystemPerformancePoint } from "../benchmark/systemPerformanceTypes";
import { fetchSystemPerformanceHistory, fetchSystemPerformanceNow } from "../systemPerformance";

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
  const chartRef = useRef<ReturnType<typeof echarts.init> | undefined>(undefined);
  const hasPoints = points.length > 0;
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !hasPoints) return;
    const chart = echarts.init(host, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = undefined;
    };
  }, [hostRef, hasPoints]);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const times = points.map((point) =>
      typeof point.at === "number" ? point.at : Date.parse(point.at),
    );
    const lineData = (metric: "cpu" | "memory" | "gpu") => points.flatMap((point, i) => {
      const current = [times[i], point[metric]];
      return i > 0 && times[i] - times[i - 1] > 12000 ? [[times[i] - 1, null], current] : [current];
    });
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
          data: lineData("cpu"),
        },
        {
          name: "内存",
          type: "line",
          showSymbol: false,
          lineStyle: { width: 1, color: colors.mutedText },
          data: lineData("memory"),
        },
        {
          name: "GPU",
          type: "line",
          showSymbol: false,
          smooth: true,
          lineStyle: { width: 1.4, color: colors.warning },
          data: lineData("gpu"),
        },
      ],
    });
  }, [points, colors]);
}

const atMs = (point: SystemPerformancePoint) => typeof point.at === "number" ? point.at : Date.parse(point.at);
const timelineLength = 30 * 60 * 1000;

export function SystemPerfBar() {
  const [latest, setLatest] = useState<SystemPerformancePoint | null>(null);
  const [points, setPoints] = useState<SystemPerformancePoint[]>([]);
  useEffect(() => {
    let active = true, hasHistory = false;
    let timer: number;
    const update = async () => {
      try {
        if (document.hidden) return;
        const [point, previous] = await Promise.all([
          fetchSystemPerformanceNow(),
          hasHistory ? Promise.resolve(undefined) : fetchSystemPerformanceHistory({ from: Date.now() - timelineLength }).catch(() => undefined),
        ]);
        if (!active) return;
        if (previous) hasHistory = true;
        if (point) setLatest(point);
        if (point || previous) setPoints(current => {
          const timeline = previous ?? current;
          if (!point || timeline.length && atMs(timeline[timeline.length - 1]) >= atMs(point)) return timeline;
          return [...timeline.filter(sample => atMs(sample) >= atMs(point) - timelineLength), point];
        });
      } catch {
        // Keep the last reading if the sidecar is temporarily unavailable.
      } finally {
        if (active) timer = window.setTimeout(update, 3000);
      }
    };
    void update();
    return () => { active = false; window.clearTimeout(timer); };
  }, []);
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
