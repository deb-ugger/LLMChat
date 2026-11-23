import * as echarts from "echarts/core";
import { BarChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, LegendScrollComponent, TooltipComponent } from "echarts/components";
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
  type BenchmarkCompareRun,
} from "../benchmark/benchmarkCompare";

import "../benchmarkReport.css";

echarts.use([
  ScatterChart,
  BarChart,
  GridComponent,
  LegendComponent,
  LegendScrollComponent,
  TooltipComponent,
  CanvasRenderer,
]);

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
  const projectPath = scope?.replace(/(?::text|:images)?:benchmark:(?:text|images|mosaic)$/, "");
  const projectName = projectPath?.split(/[\\/]/).filter(Boolean).at(-1);
  return <RunComparePanel label={setup.label} projectName={projectName} runs={runs} report={report} loading={loadingReport}
    qualityError={qualityError} itemUnit={setup.itemUnit} onClose={onClose} />;
}

const RunComparePanel = memo(function RunComparePanel({
  label, projectName, runs, report, loading, qualityError, itemUnit, onClose,
}: {
  label: string;
  projectName?: string;
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
  const throughputRef = useRef<HTMLDivElement | null>(null);

  const points = useMemo(() => buildQualityScatter(runs), [runs]);
  const cells = useMemo(() => buildConcurrencyHeatmap(runs), [runs]);
  const seriesColors = useMemo(() => [colors.success, colors.warning, "#6598ed", colors.text, colors.mutedText], [colors]);
  const labeled = useMemo(() => points.filter(point => point.y != null), [points]);
  const scatterOption = useMemo(() => {
    const seriesNames = [...new Set(labeled.map(point => point.series))];
    return {
      grid: { top: 32, right: 24, bottom: 32, left: 46 },
      legend: {
        type: "scroll",
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
        itemStyle: { color: seriesColors[index % seriesColors.length], opacity: 0.85 },
        data: labeled.filter(point => point.series === model).map(point => [point.x, point.y, point.label, point.size]),
      })),
    };
  }, [colors, labeled, seriesColors]);

  const throughputOption = useMemo(() => {
    const models = [...new Set(cells.map(cell => cell.y))];
    const concurrencies = [...new Set(cells.map(cell => cell.x))].sort((a, b) => a - b);
    return {
      grid: { top: 32, right: 14, bottom: 32, left: 48 },
      legend: { type: "scroll", top: 0, left: 48, right: 14,
        textStyle: { color: colors.mutedText, fontSize: colors.captionSize } },
      tooltip: {
        ...tooltipStyle(colors),
        renderMode: "richText",
        formatter: ({ seriesName, name, value }: { seriesName: string; name: string; value: number }) =>
          [seriesName, name, `${value.toFixed(2)} ${itemUnit}/秒`].join("\n"),
      },
      xAxis: {
        type: "category",
        data: concurrencies.map(value => `并发 ${value}`),
        axisLabel: { color: colors.mutedText, fontSize: colors.captionSize },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: colors.mutedText, fontSize: colors.captionSize },
        splitLine: { lineStyle: { color: colors.border } },
      },
      series: models.map((model, index) => {
        const byConcurrency = new Map(cells.filter(cell => cell.y === model).map(cell => [cell.x, cell.value]));
        return {
          name: model, type: "bar", barMaxWidth: 42,
          itemStyle: { color: seriesColors[index % seriesColors.length], borderRadius: [3, 3, 0, 0] },
          data: concurrencies.map(value => byConcurrency.get(value) ?? null),
        };
      }),
    };
  }, [cells, colors, itemUnit, seriesColors]);

  useChart(scatterRef, labeled.length ? scatterOption : null);
  useChart(throughputRef, cells.length ? throughputOption : null);

  const [sort, setSort] = useState<{ key: "f1" | "seconds"; descending: boolean }>({ key: "f1", descending: true });
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const scores = new Map(points.map(point => [point.runId, point.y]));
  const rows = (report?.totals ?? []).map(row => ({ ...row, f1: scores.get(row.runId) ?? null }));
  const rated = rows.filter(row => row.f1 !== null).sort((a, b) => b.f1! - a.f1!);
  const best = rated[0];
  const worst = rated.at(-1);
  const current = runs.reduce<BenchmarkCompareRun | undefined>((latest, run) => {
    const time = (item?: BenchmarkCompareRun) => item?.performance.endedAt || item?.performance.beginTime || "";
    return time(run) >= time(latest) ? run : latest;
  }, undefined);
  const activeRunId = selectedRunId ?? best?.runId ?? rows[0]?.runId;
  const totalMs = runs.reduce((sum, run) => sum + run.performance.elapsedMs, 0);
  const validSamples = rows.reduce((sum, row) => sum + row.tp + row.fp + row.tn + row.fn, 0);
  rows.sort((left, right) => {
    const a = left[sort.key];
    const b = right[sort.key];
    if (a === null || b === null) return Number(a === null) - Number(b === null);
    return sort.descending ? b - a : a - b;
  });

  const firstTime = runs[0]?.performance.beginTime || runs[0]?.performance.endedAt;
  const headerTime = firstTime && Number.isFinite(Date.parse(firstTime))
    ? new Date(firstTime).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }) : "";
  const percent = (f1: number | null | undefined) => f1 == null ? "—" : `${(f1 * 100).toFixed(1)}%`;
  const runName = (row: typeof best | undefined) => row ? `第 ${row.round} 轮 · ${row.label}` : "暂无可计算结果";
  const sortBy = (key: typeof sort.key) => setSort(previous => ({
    key, descending: previous.key === key ? !previous.descending : key === "f1",
  }));
  const sortState = (key: typeof sort.key) => sort.key === key ? (sort.descending ? "descending" : "ascending") : "none";
  const sortMark = (key: typeof sort.key) => sort.key === key ? (sort.descending ? "↓" : "↑") : "↕";

  return <main className="benchmark-report" aria-labelledby={titleId}>
    <header className="benchmark-report-head">
      <div>
        <h2 id={titleId}>{label}</h2>
        <p>{[projectName, headerTime, `共 ${runs.length} 次运行`].filter(Boolean).join(" · ")}</p>
      </div>
      <div className="benchmark-report-actions">
        {report && <button type="button" className="unity-btn is-secondary" onClick={() => void downloadMosaicTaskReport(report)
          .catch(error => showAppNotice(String(error), "error"))}>下载 Excel</button>}
        <button type="button" className="unity-btn" onClick={onClose}>关闭</button>
      </div>
    </header>
    <dl className="benchmark-report-kpis">
      <div><dt>最高 F1</dt><dd className="is-best">{percent(best?.f1)}</dd><dd title={runName(best)}>{runName(best)}</dd></div>
      <div><dt>有效样本数</dt><dd>{report ? `${validSamples.toLocaleString("zh-CN")} ${itemUnit}` : "—"}</dd>
        <dd>已标注且有明确结果，按运行累计</dd></div>
      <div><dt>最低 F1</dt><dd className="is-worst">{percent(worst?.f1)}</dd><dd title={runName(worst)}>{runName(worst)}</dd></div>
      <div><dt>总用时</dt><dd>{gameDuration(totalMs)}</dd><dd>{runs.length} 次运行累计</dd></div>
    </dl>
    {report && <section className="benchmark-report-table-section" aria-label="数据集对照总结">
      <p>{report.title} · 定位框按 IoU ≥ 0.5 一对一匹配</p>
      <div className="benchmark-report-table" tabIndex={0} role="region" aria-label="运行结果表">
        <table>
          <thead>
            <tr><th rowSpan={2} scope="col">配置</th><th colSpan={6} scope="colgroup">质量</th><th colSpan={3} scope="colgroup">效率</th></tr>
            <tr><th scope="col">轮次</th><th scope="col" aria-sort={sortState("f1")}><button type="button" onClick={() => sortBy("f1")}>F1 <span aria-hidden="true">{sortMark("f1")}</span></button></th>
              <th scope="col">漏检</th><th scope="col">误报</th><th scope="col">待复核</th><th scope="col">未确认判有码</th>
              <th scope="col">匹配框 / 人工框</th><th scope="col">多余框</th>
              <th scope="col" aria-sort={sortState("seconds")}><button type="button" onClick={() => sortBy("seconds")}>用时 <span aria-hidden="true">{sortMark("seconds")}</span></button></th></tr>
          </thead>
          <tbody>{rows.map(row => <tr key={row.runId} data-best={row.runId === best?.runId || undefined}
            data-selected={row.runId === activeRunId || undefined} onClick={() => setSelectedRunId(row.runId)}>
            <td><button type="button" className="benchmark-report-select" aria-pressed={row.runId === activeRunId}>
              {row.label}</button>
              {row.runId === best?.runId && <span className="benchmark-report-badge is-best">最佳</span>}
              {row.runId === current?.performance.taskId && <span className="benchmark-report-badge is-current">本次</span>}
            </td>
            <td>{row.round}</td><td>{percent(row.f1)}</td><td>{row.fn}</td><td>{row.fp}</td><td>{row.review}</td>
            <td>{row.unlabelledPositive}</td><td>{row.foundBoxes} / {row.expectedBoxes}</td><td>{row.extraBoxes}</td>
            <td>{gameDuration(row.seconds * 1000)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>}
    <div className="benchmark-report-charts">
      <section aria-label="质量与用时">
        <header><h3>质量与用时</h3><p>纵轴为 F1，点大小表示有效标注样本数</p></header>
        {labeled.length > 0 ? <div ref={scatterRef} className="benchmark-report-chart" />
          : loading ? <p role="status">正在读取样本标注…</p>
          : qualityError ? <p className="unity-offline-error" role="alert">读取样本标注失败：{qualityError}</p>
          : <p>需要已标注样本的逐图结果。</p>}
      </section>
      <section aria-label="并发与吞吐">
        <header><h3>并发与吞吐</h3><p>同模型、同并发的成功样本数 ÷ 累计用时</p></header>
        {cells.length > 0 ? <div ref={throughputRef} className="benchmark-report-chart" />
          : <p>没有可比较的并发吞吐数据。</p>}
      </section>
    </div>
  </main>;
});
