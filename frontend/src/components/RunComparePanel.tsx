import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, LegendScrollComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { memo, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { compareMosaicTaskWithDataset, downloadMosaicTaskReport, type MosaicTaskReport } from "../benchmark/benchmarkMosaicReport";
import { groupBenchmarkTasks, readGameBenchmarkHistory } from "../gameTextBenchmark";
import { gameDuration } from "../gameModelPerformance";
import type { GameBenchmarkReviewSetup } from "../gameAuxWindows";
import { showAppNotice } from "./AppNotice";
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
  LegendScrollComponent,
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

export function BenchmarkReviewWindow({ setup, onClose }: { setup: GameBenchmarkReviewSetup; onClose: () => void }) {
  const { queueId, scope, step } = setup;
  const [runs, setRuns] = useState<readonly BenchmarkCompareRun[]>();
  const [report, setReport] = useState<MosaicTaskReport>();
  const [loadingReport, setLoadingReport] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [qualityError, setQualityError] = useState("");
  useEffect(() => {
    let active = true;
    void (async () => {
      const records = await readGameBenchmarkHistory(scope, step);
      if (!active) return;
      const task = groupBenchmarkTasks(records).find(item => item.id === queueId);
      if (!task) throw new Error("找不到该测试任务的记录");
      setRuns(task.runs);
      const metadata = task.runs[0].performance.benchmark;
      const path = metadata?.referenceSampleSetPath ?? metadata?.sampleSetPath;
      if (typeof path !== "string" || (step !== "mosaicScreen" && step !== "mosaicRefine")) return;
      setLoadingReport(true);
      try {
        const results = await compareMosaicTaskWithDataset(queueId, task.runs, path);
        if (!active) return;
        const qualityByRun = new Map(results.totals.map(row => [row.runId, row]));
        setRuns(task.runs.map(run => ({ ...run, quality: qualityByRun.get(run.performance.taskId ?? "") })));
        setReport(results);
      } catch (error) {
        if (active) setQualityError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) setLoadingReport(false);
      }
    })().catch(error => {
      if (active) setLoadError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [queueId, scope, step]);
  if (!runs) return <main className="game-aux-loading">
    <p role={loadError ? "alert" : "status"}>{loadError || "正在读取测试记录…"}</p>
    <button type="button" className="unity-btn" onClick={onClose}>关闭</button>
  </main>;
  return <RunComparePanel label={setup.label} runs={runs} report={report} loading={loadingReport}
    qualityError={qualityError} itemUnit={setup.itemUnit} onClose={onClose} />;
}

const RunComparePanel = memo(function RunComparePanel({
  label, runs, report, loading, qualityError, itemUnit, onClose,
}: {
  label: string;
  runs: readonly BenchmarkCompareRun[];
  report?: MosaicTaskReport;
  loading?: boolean;
  qualityError?: string;
  itemUnit: "条" | "张";
  onClose: () => void;
}) {
  const titleId = useId();
  const colors = useChartColors();
  const scatterRef = useRef<HTMLDivElement | null>(null);
  const heatRef = useRef<HTMLDivElement | null>(null);
  const barsRef = useRef<HTMLDivElement | null>(null);

  const points = useMemo(() => buildQualityScatter(runs), [runs]);
  const cells = useMemo(() => buildConcurrencyHeatmap(runs), [runs]);
  const stages = useMemo(() => buildStageBars(runs), [runs]);
  const summaries = useMemo(() => runs.map(summarizeRun), [runs]);

  const labeled = points.filter(point => point.y != null);
  const seriesNames = [...new Set(labeled.map(point => point.series))];
  const scatterOption = {
    grid: { top: seriesNames.length > 1 ? 34 : 14, right: 24, bottom: 32, left: 46 },
    legend: {
      type: "scroll",
      show: seriesNames.length > 1,
      top: 0,
      left: 46,
      right: 24,
      textStyle: { color: colors.mutedText, fontSize: colors.captionSize },
    },
    tooltip: {
      ...tooltipStyle(colors),
      renderMode: "richText",
      formatter: (params: { data: [number, number, string, number]; seriesName: string }) => {
        const [x, y, label, size] = params.data;
        return [params.seriesName, label, `用时 ${x.toFixed(1)} 秒`, `F1 ${(y * 100).toFixed(1)}%`, `标注 ${size}`].join("\n");
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
    series: seriesNames.map((model, index) => ({
      name: model ?? "未记录模型",
      type: "scatter",
      symbolSize: (value: [number, number, string, number]) =>
        Math.min(26, Math.max(8, 6 + Math.sqrt(value[3] || 1) * 2)),
      itemStyle: { color: [colors.text, colors.warning, colors.success, colors.mutedText][index % 4], opacity: 0.85 },
      data: labeled.filter(point => point.series === model).map(point => [point.x, point.y, point.label, point.size]),
    })),
  };

  const models = [...new Set(cells.map((cell) => cell.y))];
  const concurrencies = [...new Set(cells.map((cell) => cell.x))].sort((a, b) => a - b);
  const displayedModel = (id: string) => id.length > 23 ? id.slice(0, 8) + "…" + id.slice(-14) : id;
  const modelLabelWidth = Math.max(90, ...models.map(id => Math.ceil(displayedModel(id).length * colors.captionSize * 0.66)));
  const heatData = cells.map((cell) => [concurrencies.indexOf(cell.x), models.indexOf(cell.y), cell.value]);
  const heatOption = {
    grid: { top: 10, right: 24, bottom: 42, left: modelLabelWidth + 12 },
    tooltip: {
      ...tooltipStyle(colors),
      renderMode: "richText",
      formatter: (params: { data: [number, number, number] }) => {
        const [x, y, value] = params.data;
        return [models[y], `并发 ${concurrencies[x]}`, `${value.toFixed(1)} ${itemUnit}/秒`].join("\n");
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
      axisLabel: { color: colors.mutedText, fontSize: colors.captionSize, width: modelLabelWidth, formatter: displayedModel },
      splitLine: { show: false },
    },
    visualMap: {
      show: false,
      min: 0,
      max: Math.max(1, ...heatData.map(row => row[2])),
      inRange: { color: [colors.border, colors.text] },
    },
    series: [{ type: "heatmap", data: heatData, itemStyle: { borderWidth: 1, borderColor: colors.panel } }],
  };

  const stageNames = [...new Set(stages.map((bar) => bar.stack))];
  const multipleRounds = new Set(runs.map(run => run.round)).size > 1;
  const stageLabels = runs.map(run => multipleRounds ? `第 ${run.round} 轮 · ${run.label}` : run.label);
  const barsOption = {
    grid: { top: 28, right: 16, bottom: 32, left: 52 },
    tooltip: { ...tooltipStyle(colors), trigger: "axis", renderMode: "richText" },
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
      barMaxWidth: 14,
      itemStyle: {
        color: [colors.text, colors.warning, colors.mutedText, colors.borderStrong][index % 4],
        borderRadius: [2, 2, 0, 0],
      },
      data: stages.filter(bar => bar.stack === stack).map(bar => bar.seconds),
    })),
  };

  const hasStages = stages.some(bar => bar.seconds != null);
  useChart(scatterRef, labeled.length ? scatterOption : null);
  useChart(heatRef, cells.length ? heatOption : null);
  useChart(barsRef, hasStages ? barsOption : null);
  const best = summaries
    .filter((summary) => summary.f1 != null)
    .sort((a, b) => (b.f1 ?? 0) - (a.f1 ?? 0))[0];

  return <main className="game-benchmark-compare" aria-labelledby={titleId}>
      <header className="game-benchmark-compare-head">
        <h2 id={titleId}>{label}</h2>
        <span className="hint">
          共 {runs.length} 次运行
          {best?.f1 != null && ` · 最高 F1 ${(best.f1 * 100).toFixed(1)}%${best.model ? `（${best.model}）` : ""}`}
        </span>
        {report && <button type="button" className="unity-btn" onClick={() => void downloadMosaicTaskReport(report)
          .catch(error => showAppNotice(String(error), "error"))}>下载 Excel</button>}
        <button type="button" className="unity-btn" onClick={onClose}>关闭</button>
      </header>
      <div className="game-benchmark-compare-grid">
        {report && <section className="game-benchmark-compare-card is-wide" aria-label="数据集对照总结">
          <header><strong>数据集对照总结</strong><span>{report.title}</span></header>
          <p className="hint">未确认样本独立计数，定位框按 IoU ≥ 0.5 一对一匹配。</p>
          <div className="game-benchmark-compare-table"><table>
            <thead><tr><th>配置</th><th>轮次</th><th>漏检</th><th>误报</th><th>待复核</th>
              <th>匹配框 / 人工框</th><th>多余框</th><th>未确认判有码</th><th>用时</th></tr></thead>
            <tbody>{report.totals.map((row, index) => <tr key={row.runId ?? index}>
              <td>{row.label}</td><td>{row.round}</td><td>{row.fn}</td><td>{row.fp}</td><td>{row.review}</td>
              <td>{row.foundBoxes} / {row.expectedBoxes}</td><td>{row.extraBoxes}</td>
              <td>{row.unlabelledPositive}</td><td>{gameDuration(row.seconds * 1000)}</td>
            </tr>)}</tbody>
          </table></div>
        </section>}
        <section className="game-benchmark-compare-card is-wide" aria-label="质量与用时">
          <header>
            <strong>质量与用时</strong>
            {labeled.length > 0 && <span>点大小表示有效标注样本数</span>}
          </header>
          {labeled.length > 0 ? <div ref={scatterRef} className="game-benchmark-compare-chart" />
            : loading ? <p className="hint" role="status">正在读取样本标注…</p>
            : qualityError ? <p className="unity-offline-error" role="alert">读取样本标注失败：{qualityError}</p>
            : <p className="hint">没有可比较的质量数据。此图需要已标注样本的逐图结果。</p>}
        </section>
        <section className="game-benchmark-compare-card" aria-label="并发与吞吐">
          <header><strong>并发与吞吐</strong><span>成功样本 / 秒</span></header>
          {cells.length > 0 ? <div ref={heatRef} className="game-benchmark-compare-chart" />
            : <p className="hint">没有可比较的并发吞吐数据。</p>}
        </section>
        <section className="game-benchmark-compare-card" aria-label="阶段耗时">
          <header><strong>阶段耗时</strong><span>各阶段统计区间可能重叠</span></header>
          {hasStages ? <div ref={barsRef} className="game-benchmark-compare-chart" />
            : <p className="hint">此记录没有分阶段耗时。</p>}
        </section>
      </div>
    </main>;
});
