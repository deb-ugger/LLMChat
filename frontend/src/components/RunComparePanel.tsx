import * as echarts from "echarts/core";
import { BarChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, LegendScrollComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { memo, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { compareMosaicTaskWithDataset, downloadMosaicTaskReport, type MosaicTaskReport } from "../benchmark/benchmarkMosaicReport";
import { groupBenchmarkTasks, readGameBenchmarkHistory } from "../gameTextBenchmark";
import { gameDuration } from "../gameModelPerformance";
import { bestMosaicRuns, compareMosaicScores, mosaicScoreTitle } from "../benchmark/mosaicScore";
import type { GameBenchmarkReviewSetup } from "../gameAuxWindows";
import { showAppNotice } from "./AppNotice";
import { useChartColors, type ChartColors } from "./chartTheme";
import {
  buildConcurrencyHeatmap,
  buildQualityScatter,
  summarizeRun,
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
      if (step !== "mosaicScreen" && step !== "mosaicRefine") return;
      setLoadingReport(true);
      try {
        const results = await compareMosaicTaskWithDataset(queueId, task.runs, typeof path === "string" ? path : undefined, step);
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
  const [qualityMetric, setQualityMetric] = useState<"score" | "f1">("score");
  const scoreTitle = report ? mosaicScoreTitle(report.stage) : "综合分";
  const metric = report ? qualityMetric : "f1";
  const screening = report?.stage === "mosaicScreen";

  const points = useMemo(() => buildQualityScatter(runs, metric), [runs, metric]);
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
          return [params.seriesName, label, `用时 ${x.toFixed(1)} 秒`,
            metric === "score" ? `${scoreTitle} ${y.toFixed(1)} 分` : `F1 ${(y * 100).toFixed(1)}%`, `标注 ${size}`].join("\n");
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
        max: metric === "score" ? 100 : 1,
        nameTextStyle: { color: colors.mutedText, fontSize: colors.captionSize },
        axisLabel: {
          color: colors.mutedText,
          fontSize: colors.captionSize,
          formatter: (value: number) => metric === "score" ? String(value) : `${Math.round(value * 100)}%`,
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
  }, [colors, labeled, metric, scoreTitle, seriesColors]);

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

  const [sort, setSort] = useState<{ key: "score" | "f1" | "seconds"; descending: boolean }>({ key: "score", descending: true });
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const f1 = new Map(runs.map(run => [run.performance.taskId, summarizeRun(run).f1]));
  const groups = new Map<string, number>();
  const rows = (report?.totals ?? []).map(row => {
    const groupKey = JSON.stringify([row.score.group, row.score.items.filter(item => item.missing).map(item => item.label)]);
    if (!groups.has(groupKey)) groups.set(groupKey, groups.size + 1);
    return { ...row, f1: f1.get(row.runId) ?? null, groupNumber: groups.get(groupKey)! };
  });
  const winners = bestMosaicRuns(rows);
  const activeRunId = selectedRunId ?? rows.find(row => row.groupNumber === 1 && winners.has(row.runId))?.runId ?? rows[0]?.runId;
  const activeGroup = rows.find(row => row.runId === activeRunId)?.groupNumber ?? 1;
  const rated = rows.filter(row => row.groupNumber === activeGroup && row.score.displayScore !== null)
    .sort((a, b) => compareMosaicScores(a.score, b.score));
  const highest = rated[0], lowest = rated.at(-1);
  const current = runs.reduce<BenchmarkCompareRun | undefined>((latest, run) => {
    const time = (item?: BenchmarkCompareRun) => item?.performance.endedAt || item?.performance.beginTime || "";
    return time(run) >= time(latest) ? run : latest;
  }, undefined);
  const totalMs = runs.reduce((sum, run) => sum + run.performance.elapsedMs, 0);
  const validSamples = rows.reduce((sum, row) => sum + row.confirmedPositive + row.confirmedNegative, 0);
  rows.sort((left, right) => {
    if (left.groupNumber !== right.groupNumber) return left.groupNumber - right.groupNumber;
    if (sort.key === "score") {
      if (left.score.displayScore === null || right.score.displayScore === null)
        return Number(left.score.displayScore === null) - Number(right.score.displayScore === null);
      return (sort.descending ? 1 : -1) * compareMosaicScores(left.score, right.score);
    }
    const a = left[sort.key];
    const b = right[sort.key];
    if (a === null || b === null) return Number(a === null) - Number(b === null);
    return sort.descending ? b - a : a - b;
  });

  const firstTime = runs[0]?.performance.beginTime || runs[0]?.performance.endedAt;
  const headerTime = firstTime && Number.isFinite(Date.parse(firstTime))
    ? new Date(firstTime).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }) : "";
  const percent = (f1: number | null | undefined) => f1 == null ? "—" : `${(f1 * 100).toFixed(1)}%`;
  const scoreValue = (row: typeof highest | undefined) => row?.score.displayScore == null ? "—" :
    `${row.score.provisional ? "暂定 " : ""}${row.score.displayScore.toFixed(1)} 分`;
  const runName = (row: typeof highest | undefined) => row ? `第 ${row.round} 轮 · ${row.label}` : "暂无可计算结果";
  const sortBy = (key: typeof sort.key) => setSort(previous => ({
    key, descending: previous.key === key ? !previous.descending : key !== "seconds",
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
      <div><dt>最高{scoreTitle}{groups.size > 1 ? `（第 ${activeGroup} 组）` : ""}</dt>
        <dd className="is-best">{scoreValue(highest)}</dd><dd title={runName(highest)}>{runName(highest)}</dd></div>
      <div><dt>有效样本数</dt><dd>{report ? `${validSamples.toLocaleString("zh-CN")} ${itemUnit}` : "—"}</dd>
        <dd>已确认原图，按运行累计</dd></div>
      <div><dt>最低{scoreTitle}</dt><dd className="is-worst">{scoreValue(lowest)}</dd><dd title={runName(lowest)}>{runName(lowest)}</dd></div>
      <div><dt>总用时</dt><dd>{gameDuration(totalMs)}</dd><dd>{runs.length} 次运行累计</dd></div>
    </dl>
    {report && <section className="benchmark-report-table-section" aria-label="数据集对照总结">
      <p>{report.title} · 定位框按 IoU ≥ 0.5 做最大一对一匹配</p>
      <p id={titleId + "-f1"}>{screening ? "初筛按有码保留和无码剔除评分。" : "复筛按图级判定、框级匹配、复核与速度评分。交付覆盖采用固定人工框分母。"} F1 为明确图级判定的参考值。</p>
      <div className="benchmark-report-table" tabIndex={0} role="region" aria-label="运行结果表" aria-describedby={titleId + "-f1"}>
        <table>
          <thead>
            <tr><th scope="col">配置</th>{groups.size > 1 && <th scope="col">样本组</th>}<th scope="col">轮次</th>
              <th scope="col" className="benchmark-report-score" aria-sort={sortState("score")}><button type="button" onClick={() => sortBy("score")}>{scoreTitle} <span aria-hidden="true">{sortMark("score")}</span></button></th>
              <th scope="col" className="benchmark-report-provisional">暂定与缺项</th>
              {!screening && <th scope="col" className="benchmark-report-delivery">交付覆盖</th>}
              <th scope="col" className="benchmark-report-ranking">最佳资格</th><th scope="col">运行状态</th>
              <th scope="col" aria-sort={sortState("f1")}><button type="button" onClick={() => sortBy("f1")}>图级 F1 <span aria-hidden="true">{sortMark("f1")}</span></button></th>
              {screening ? <><th scope="col">直接筛掉的有码</th><th scope="col">保留给下游的有码</th><th scope="col">移交的无码</th></>
                : <><th scope="col">漏图</th><th scope="col">误报</th></>}
              <th scope="col">待复核</th><th scope="col">未确认判有码</th>
              <th scope="col">匹配框 / 可评人工框</th><th scope="col">多余框</th>
              {!screening && <th scope="col">明确判定率与可评框覆盖</th>}
              <th scope="col">每百张秒数</th><th scope="col" aria-sort={sortState("seconds")}><button type="button" onClick={() => sortBy("seconds")}>用时 <span aria-hidden="true">{sortMark("seconds")}</span></button></th></tr>
          </thead>
          <tbody>{rows.map(row => <tr key={row.runId} data-best={winners.has(row.runId) || undefined}
            data-selected={row.runId === activeRunId || undefined} onClick={() => setSelectedRunId(row.runId)}>
            <td><button type="button" className="benchmark-report-select" aria-pressed={row.runId === activeRunId}>
              {row.label}</button>
              {winners.has(row.runId) && <span className="benchmark-report-badge is-best">最佳</span>}
              {row.runId === current?.performance.taskId && <span className="benchmark-report-badge is-current">本次</span>}
            </td>
            {groups.size > 1 && <td>{row.groupNumber}</td>}<td>{row.round}</td>
            <td className="benchmark-report-score">{scoreValue(row)}<details className="benchmark-report-score-details">
              <summary>分项</summary><ul>{row.score.items.map(item => <li key={item.label}>
                {item.label} · {item.ratio === null ? item.missing : `${Number(item.numerator.toFixed(2))} / ${Number(item.denominator.toFixed(2))} · ${(item.ratio * item.weight).toFixed(2)} / ${item.weight} 分`}
              </li>)}</ul>
            </details></td>
            <td className="benchmark-report-provisional">{row.score.effectiveWeight}/100
              {row.score.items.filter(item => item.missing).map(item => <div key={item.label}>{item.label}：{item.missing}</div>)}
              {!row.freeze && <div>缺冻结样本或标注版本</div>}
            </td>
            {!screening && <td className="benchmark-report-delivery">{row.expectedBoxes ? `${row.foundBoxes} / ${row.expectedBoxes} · ${percent(row.score.delivery)}` : "—"}</td>}
            <td className="benchmark-report-ranking">{winners.has(row.runId) ? "最佳" : row.score.eligible ? "合格" :
              <details><summary>不参与</summary>{row.score.rankingReasons.join(" · ")}</details>}</td>
            <td className="benchmark-report-run-status">{row.status}
              {(row.failed > 0 || row.skipped > 0 || row.pending > 0 || row.missing > 0 || row.invalid > 0 || row.issues.length > 0) &&
                <details><summary>{`失败 ${row.failed} · 跳过 ${row.skipped} · 待筛选 ${row.pending} · 缺行 ${row.missing} · 异常 ${row.invalid}`}</summary>
                  {[...row.issues, ...Object.entries(row.reasons).map(([reason, count]) => `${reason} × ${count}`)].join(" · ")}
                </details>}
            </td>
            <td>{percent(row.f1)}</td><td>{row.fn}</td>
            {screening ? <><td>{row.evaluatedPositive - row.fn}</td><td>{row.fp + row.reviewNegative}</td></> : <td>{row.fp}</td>}
            <td>{row.review}</td><td>{row.unlabelledPositive}</td><td>{row.foundBoxes} / {row.evaluatedBoxes}</td><td>{row.extraBoxes}</td>
            {!screening && <td>有码 {percent(row.score.positiveCoverage)} · 无码 {percent(row.score.negativeCoverage)} · 框 {percent(row.score.boxCoverage)}</td>}
            <td>{row.score.speed?.toFixed(1) ?? "—"}</td><td>{gameDuration(row.elapsedMs)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>}
    <div className="benchmark-report-charts">
      <section aria-label="质量与用时">
        <header><h3>质量与用时</h3>{report && <label>纵轴 <select value={qualityMetric} onChange={event => setQualityMetric(event.target.value === "f1" ? "f1" : "score")}>
          <option value="score">{scoreTitle}</option><option value="f1">图级 F1</option></select></label>}
          <p>点大小表示已确认原图数</p></header>
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
