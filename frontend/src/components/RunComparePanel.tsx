import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useChartColors, type ChartColors } from "./chartTheme";
import {
  buildConcurrencyHeatmap,
  buildQualityScatter,
  buildStageBars,
  summarizeRun,
  type BenchmarkCompareRun,
} from "../benchmark/benchmarkCompare";

echarts.use([
  ScatterChart,
  HeatmapChart,
  BarChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

const STAGE_LABEL: Record<string, string> = {
  modelRequestMs: "模型请求",
  ocrMs: "识别",
  saveMs: "保存",
  queueMs: "排队",
};

function useChart(hostRef: RefObject<HTMLDivElement | null>, option: Record<string, unknown> | null) {
  const colors = useChartColors();
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !option) return;
    const chart = echarts.init(host, undefined, { renderer: "canvas" });
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      textStyle: { color: colors.text, fontSize: colors.captionSize },
      ...option,
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [hostRef, option, colors]);
}

function tooltipStyle(colors: ChartColors) {
  return {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    textStyle: { color: colors.text, fontSize: colors.captionSize },
  };
}

export function RunComparePanel({
  runs,
  onClose,
}: {
  runs: readonly BenchmarkCompareRun[];
  onClose: () => void;
}) {
  const colors = useChartColors();
  const scatterRef = useRef<HTMLDivElement | null>(null);
  const heatRef = useRef<HTMLDivElement | null>(null);
  const barsRef = useRef<HTMLDivElement | null>(null);

  const points = useMemo(() => buildQualityScatter(runs), [runs]);
  const cells = useMemo(() => buildConcurrencyHeatmap(runs), [runs]);
  const stages = useMemo(() => buildStageBars(runs), [runs]);
  const summaries = useMemo(() => runs.map(summarizeRun), [runs]);

  const labeled = points.filter((point) => point.y != null);
  const scatterOption = {
    grid: { top: 14, right: 16, bottom: 32, left: 46 },
    tooltip: {
      ...tooltipStyle(colors),
      formatter: (params: { data: [number, number, string, number] }) => {
        const [x, y, label, size] = params.data;
        return `${label}<br/>用时 ${x.toFixed(1)} 秒<br/>F1 ${(y * 100).toFixed(1)}%<br/>标注 ${size}`;
      },
    },
    xAxis: {
      type: "value",
      name: "秒",
      nameTextStyle: { color: colors.mutedText, fontSize: colors.captionSize },
      axisLabel: { color: colors.mutedText, fontSize: colors.captionSize },
      splitLine: { lineStyle: { color: colors.border } },
    },
    yAxis: {
      type: "value",
      name: "F1",
      min: 0,
      max: 1,
      nameTextStyle: { color: colors.mutedText, fontSize: colors.captionSize },
      axisLabel: {
        color: colors.mutedText,
        fontSize: colors.captionSize,
        formatter: (value: number) => `${Math.round(value * 100)}%`,
      },
      splitLine: { lineStyle: { color: colors.border } },
    },
    series: [{
      type: "scatter",
      symbolSize: (value: [number, number, string, number]) =>
        Math.min(26, Math.max(8, 6 + Math.sqrt(value[3] || 1) * 2)),
      itemStyle: { color: colors.text, opacity: 0.85 },
      data: labeled.map((point) => [point.x, point.y ?? 0, point.label, point.size]),
    }],
  };

  const models = [...new Set(cells.map((cell) => cell.y))];
  const concurrencies = [...new Set(cells.map((cell) => cell.x))].sort((a, b) => a - b);
  const heatData = cells.map((cell) => [concurrencies.indexOf(cell.x), models.indexOf(cell.y), cell.value]);
  const heatOption = {
    grid: { top: 10, right: 16, bottom: 42, left: 96 },
    tooltip: {
      ...tooltipStyle(colors),
      formatter: (params: { data: [number, number, number, number] }) => {
        const [x, y, value] = params.data;
        return `${models[y]}<br/>并发 ${concurrencies[x]}<br/>${value.toFixed(1)} 张/秒`;
      },
    },
    xAxis: {
      type: "category",
      name: "并发",
      nameTextStyle: { color: colors.mutedText, fontSize: colors.captionSize },
      data: concurrencies.map(String),
      axisLabel: { color: colors.mutedText, fontSize: colors.captionSize },
      splitLine: { show: false },
    },
    yAxis: {
      type: "category",
      data: models,
      axisLabel: { color: colors.mutedText, fontSize: colors.captionSize, width: 84, overflow: "truncate" },
      splitLine: { show: false },
    },
    visualMap: {
      show: false,
      min: heatData.length ? Math.min(...heatData.map((row) => row[2])) : 0,
      max: heatData.length ? Math.max(...heatData.map((row) => row[2])) : 1,
      inRange: { color: [colors.mutedPanel, colors.text] },
    },
    series: [{ type: "heatmap", data: heatData, itemStyle: { borderWidth: 1, borderColor: colors.panel } }],
  };

  const stageNames = [...new Set(stages.map((bar) => bar.stack))];
  const stageLabels = [...new Set(stages.map((bar) => bar.label))];
  const barsOption = {
    grid: { top: 28, right: 16, bottom: 32, left: 52 },
    tooltip: { ...tooltipStyle(colors), trigger: "axis" },
    legend: {
      top: 0,
      textStyle: { color: colors.mutedText, fontSize: colors.captionSize },
      itemWidth: 10,
      itemHeight: 8,
    },
    xAxis: {
      type: "category",
      data: stageLabels,
      axisLabel: { color: colors.mutedText, fontSize: colors.captionSize, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: "秒",
      nameTextStyle: { color: colors.mutedText, fontSize: colors.captionSize },
      axisLabel: { color: colors.mutedText, fontSize: colors.captionSize },
      splitLine: { lineStyle: { color: colors.border } },
    },
    series: stageNames.map((stack, index) => ({
      name: STAGE_LABEL[stack] ?? stack,
      type: "bar",
      stack: undefined,
      barMaxWidth: 14,
      itemStyle: {
        color: [colors.text, colors.warning, colors.mutedText, colors.borderStrong][index % 4],
        borderRadius: [2, 2, 0, 0],
      },
      data: stageLabels.map((label) => {
        const found = stages.find((bar) => bar.label === label && bar.stack === stack);
        return found?.seconds ?? null;
      }),
    })),
  };

  useChart(scatterRef, scatterOption);
  useChart(heatRef, heatOption);
  useChart(barsRef, barsOption);

  const empty = labeled.length === 0 && cells.length === 0;
  const best = summaries
    .filter((summary) => summary.f1 != null)
    .sort((a, b) => (b.f1 ?? 0) - (a.f1 ?? 0))[0];

  return (
    <section className="game-benchmark-compare" aria-label="模型比较">
      <div className="game-benchmark-compare-head">
        <strong>模型比较</strong>
        <span className="hint">
          {empty
            ? "这次记录没有可比较的质量数据（需要有标注的样本集）"
            : best
              ? `共 ${runs.length} 次运行 · 当前最好 F1 ${(best.f1 ?? 0) * 100 > 0 ? ((best.f1 ?? 0) * 100).toFixed(1) + "%" : "—"}（${best.model ?? "混合配置"}）`
              : `共 ${runs.length} 次运行 · 未参与质量比较`}
        </span>
        <button type="button" className="unity-btn is-ghost" onClick={onClose}>关闭比较</button>
      </div>
      {!empty ? (
        <div className="game-benchmark-compare-grid">
          <div className="game-benchmark-compare-card is-wide">
            <header>
              <strong>质量与用时</strong>
              <span>越靠左越快，越靠上越准；点大小表示标注样本数</span>
            </header>
            <div ref={scatterRef} className="game-benchmark-compare-chart" />
          </div>
          <div className="game-benchmark-compare-card">
            <header>
              <strong>并发与吞吐</strong>
              <span>同一模型在不同并发下的张/秒</span>
            </header>
            <div ref={heatRef} className="game-benchmark-compare-chart" />
          </div>
          <div className="game-benchmark-compare-card">
            <header>
              <strong>阶段耗时</strong>
              <span>各步骤墙钟用时，区间可能重叠</span>
            </header>
            <div ref={barsRef} className="game-benchmark-compare-chart" />
          </div>
        </div>
      ) : null}
    </section>
  );
}
