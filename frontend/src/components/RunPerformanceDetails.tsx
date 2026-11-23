
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, useState } from "react";
import { useChartColors } from "./chartTheme";
import type { StepPerformance } from "../gameModelPerformance";
import type { SystemPerformanceMetric, SystemPerformancePoint, SystemPerformanceSample, SystemPerformanceSource } from "../benchmark/systemPerformanceTypes";
import { fetchRunSystemPerformance } from "../systemPerformance";

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const metrics: ReadonlyArray<{ key: SystemPerformanceMetric; label: string; rate?: boolean }> = [
  { key: "cpu", label: "CPU" },
  { key: "memory", label: "内存" },
  { key: "gpu", label: "GPU" },
  { key: "disk", label: "磁盘读写", rate: true },
  { key: "network", label: "网络收发", rate: true },
];

function format(value: number | null, rate?: boolean) {
  if (value === null) return "—";
  if (!rate) return value.toFixed(1) + "%";
  if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " MB/s";
  if (value >= 1024) return (value / 1024).toFixed(0) + " KB/s";
  return value.toFixed(0) + " B/s";
}

const timeOf = (point: SystemPerformancePoint) => typeof point.at === "number" ? point.at : Date.parse(point.at);

function PerformanceTimeline({ timelines }: { timelines: SystemPerformancePoint[][] }) {
  const host = useRef<HTMLDivElement | null>(null);
  const colors = useChartColors();
  useEffect(() => {
    if (!host.current) return;
    const chart = echarts.init(host.current, undefined, { renderer: "canvas" });
    const palette = [colors.text, colors.mutedText, colors.warning, colors.success, "#b28add"];
    chart.setOption({
      animation: false,
      textStyle: { color: colors.text, fontSize: colors.captionSize },
      grid: { top: 42, right: 68, bottom: 30, left: 50 },
      legend: { top: 2, textStyle: { color: colors.text } },
      tooltip: { trigger: "axis", backgroundColor: colors.panel, borderColor: colors.border, textStyle: { color: colors.text } },
      xAxis: { type: "time", min: "dataMin", max: "dataMax" },
      yAxis: [
        { type: "value", min: 0, max: 100, axisLabel: { formatter: (n: number) => format(n) } },
        { type: "value", min: 0, axisLabel: { formatter: (n: number) => format(n, true) }, splitLine: { show: false } },
      ],
      series: metrics.map(({ key, label, rate }, index) => ({
        name: label, type: "line", symbolSize: 4, showSymbol: timelines.reduce((n, part) => n + part.length, 0) < 20,
        yAxisIndex: rate ? 1 : 0, connectNulls: false, encode: { x: 0, y: 1, tooltip: 1 },
        itemStyle: { color: palette[index] },
        tooltip: { valueFormatter: (value: unknown) => format(typeof value === "number" ? value : null, rate) },
        data: timelines.flatMap((part, segment) => {
          const values: [number, number | null][] = [];
          if (segment && timeOf(part[0]) > timeOf(timelines[segment - 1].at(-1)!))
            values.push([timeOf(part[0]) - 1, null]);
          for (const point of part) {
            values.push([timeOf(point), point[key]]);
          }
          return values;
        }),
      })),
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [timelines, colors]);
  return <div className="game-run-system-chart" ref={host} role="img" aria-label="运行期间 CPU、内存、GPU、磁盘和网络变化图" />;
}

export function RunPerformanceDetails({ run, source }: { run: StepPerformance; source: SystemPerformanceSource }) {
  const { taskId, endedAt } = run;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SystemPerformanceSample>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || !taskId) return;
    const abort = new AbortController();
    setData(undefined);
    setError("");
    void fetchRunSystemPerformance(taskId, source, endedAt, abort.signal).then(result => {
      if (!abort.signal.aborted) setData(result);
    }).catch(reason => {
      if (!abort.signal.aborted) setError(String(reason));
    });
    return () => abort.abort();
  }, [open, taskId, source, endedAt]);

  return <details className="game-run-system" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>系统性能</summary>
    {open && (error ? <p className="unity-offline-error" role="alert">{error}</p> :
      !taskId || data?.samples === 0 ? <p className="hint">本次运行暂无可用的系统性能采样。</p> :
      !data ? <p className="hint" role="status">正在读取系统性能记录…</p> : <>
        <p className="hint">运行期间共采样 {data.samples} 次</p>
        <table className="game-run-system-metrics"><thead><tr><th>指标</th><th>平均</th><th>峰值</th></tr></thead>
          <tbody>{metrics.map(({ key, label, rate }) => <tr key={key}>
            <th scope="row">{label}</th><td>{format(data.average[key], rate)}</td><td>{format(data.peak[key], rate)}</td>
          </tr>)}</tbody>
        </table>
        {data.timelines.length ? <PerformanceTimeline timelines={data.timelines} /> :
          <p className="hint">此历史记录仅保留了统计值。</p>}
      </>)}
  </details>;
}
