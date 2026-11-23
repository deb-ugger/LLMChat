import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, type RefObject } from "react";
import { useChartColors } from "./chartTheme";
import type { RunCompare } from "../benchmark/runCompareTypes";

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

function useChart(
  hostRef: RefObject<HTMLDivElement | null>,
  option: Record<string, unknown> | null,
) {
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

function baseTooltip(colors: ReturnType<typeof useChartColors>) {
  return {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    textStyle: { color: colors.text, fontSize: colors.captionSize },
  };
}

export function RunComparePanel({
  compare,
  onClose,
}: {
  compare: RunCompare;
  onClose: () => void;
}) {
  const colors = useChartColors();
  const scatterRef = useRef<HTMLDivElement | null>(null);
  const heatRef = useRef<HTMLDivElement | null>(null);
  const barsRef = useRef<HTMLDivElement | null>(null);

  const scatterOption = {
    grid: { top: 16, right: 16, bottom: 30, left: 44 },
    tooltip: {
      ...baseTooltip(colors),
      formatter: (params: { data: [number, number, string, number] }) => {
        const [speed, quality, label, samples] = params.data;
        return `${label}<br/>速度 ${speed.toFixed(1)}<br/>质量 ${
          quality == null ? "未标注" : (quality * 100).toFixed(1) + "%"
        }<br/>样本 ${samples}`;
      },
    },
    xAxis: {
      type: "value",
      name: "速度",
      nameTextStyle: { color: colors.mutedText, fontSize: colors.captionSize },
      splitLine: { lineStyle: { color: colors.border } },
      axisLabel: { color: colors.mutedText, fontSize: colors.captionSize },
    },
    yAxis: {
      type: "value",
      name: "质量",
      min: 0,
      max: 1,
      nameTextStyle: { color: colors.mutedText, fontSize: colors.captionSize },
      splitLine: { lineStyle: { color: colors.border } },
      axisLabel: { color: colors.mutedText, fontSize: colors.captionSize },
    },
    series: [
      {
        type: "scatter",
        symbolSize: 10,
        itemStyle: { color: colors.text },
        data: compare.points
          .filter((point) => point.quality != null)
          .map((point) => [point.speed, point.quality, point.label, point.samples]),
      },
    ],
  };

  const models = compare.models;
  const concurrencies = [...new Set(compare.cells.map((cell) => cell.concurrency))].sort(
    (a, b) => a - b,
  );
  const heatData = compare.cells.map((cell) => [
    concurrencies.indexOf(cell.concurrency),
    models.indexOf(cell.model),
    cell.speed,
  ]);
  const heatOption = {
    grid: { top: 10, right: 16, bottom: 44, left: 88 },
    tooltip: {
      ...baseTooltip(colors),
      formatter: (params: { data: [number, number, number] }) => {
        const [x, y, value] = params.data;
        return `${models[y]} · 并发 ${concurrencies[x]}<br/>平均 ${value.toFixed(1)}`;
      },
    },
    xAxis: {
      type: "category",
      data: concurrencies.map(String),
      axisLabel: { color: colors.mutedText, fontSize: colors.captionSize },
      splitLine: { show: false },
      name: "并发",
      nameTextStyle: { color: colors.mutedText, fontSize: colors.captionSize },
    },
    yAxis: {
      type: "category",
      data: models,
      axisLabel: { color: colors.mutedText, fontSize: colors.captionSize },
      splitLine: { show: false },
    },
    visualMap: {
      min: Math.min(...heatData.map((row) => row[2])),
      max: Math.max(...heatData.map((row) => row[2])),
      show: false,
      inRange: { color: [colors.mutedPanel, colors.text] },
    },
    series: [{ type: "heatmap", data: heatData, itemStyle: { borderWidth: 1, borderColor: colors.panel } }],
  };

  const barsOption = {
    grid: { top: 28, right: 16, bottom: 30, left: 52 },
    tooltip: { ...baseTooltip(colors), trigger: "axis" },
    legend: {
      top: 0,
      textStyle: { color: colors.mutedText, fontSize: colors.captionSize },
      itemWidth: 10,
      itemHeight: 8,
    },
    xAxis: {
      type: "category",
      data: compare.stages.map((stage) => stage.stage),
      axisLabel: { color: colors.mutedText, fontSize: colors.captionSize },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: colors.border } },
      axisLabel: { color: colors.mutedText, fontSize: colors.captionSize },
    },
    series: models.map((model, index) => ({
      name: model,
      type: "bar",
      barMaxWidth: 18,
      itemStyle: {
        color: index === 0 ? colors.text : index === 1 ? colors.warning : colors.mutedText,
        borderRadius: [2, 2, 0, 0],
      },
      data: compare.stages.map((stage) => stage.values[index] ?? null),
    })),
  };

  useChart(scatterRef, scatterOption);
  useChart(heatRef, heatOption);
  useChart(barsRef, barsOption);

  const empty = compare.points.length === 0 && compare.cells.length === 0;

  return (
    <section className="game-benchmark-compare" aria-label="模型比较">
      <div className="game-benchmark-compare-head">
        <strong>模型比较</strong>
        <span className="hint">
          {empty ? "该次记录没有可比较的数据" : `${compare.models.length} 个模型 · ${compare.points.length} 个结果`}
        </span>
        <button type="button" className="unity-btn is-ghost" onClick={onClose}>
          关闭比较
        </button>
      </div>
      {!empty ? (
        <div className="game-benchmark-compare-grid">
          <div className="game-benchmark-compare-card is-wide">
            <header>
              <strong>速度与质量</strong>
              <span>越靠右越快，越靠上越好；没有标注的模型不显示</span>
            </header>
            <div ref={scatterRef} className="game-benchmark-compare-chart" />
          </div>
          <div className="game-benchmark-compare-card">
            <header>
              <strong>并发与吞吐</strong>
              <span>同一模型在不同并发下的平均速度</span>
            </header>
            <div ref={heatRef} className="game-benchmark-compare-chart" />
          </div>
          <div className="game-benchmark-compare-card">
            <header>
              <strong>阶段耗时</strong>
              <span>每个步骤的平均耗时对比</span>
            </header>
            <div ref={barsRef} className="game-benchmark-compare-chart" />
          </div>
        </div>
      ) : null}
    </section>
  );
}
