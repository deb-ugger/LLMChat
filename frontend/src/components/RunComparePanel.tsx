import * as echarts from "echarts/core";
import { BarChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, LegendScrollComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { Fragment, memo, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { downloadMosaicTaskReport, readMosaicComparisonRuns, scoreMosaicComparisonRuns, type MosaicTaskReport } from "../benchmark/benchmarkMosaicReport";
import { groupBenchmarkTasks, readGameBenchmarkHistory, readGameFormalHistory, type BenchmarkConfig } from "../gameTextBenchmark";
import { gameDuration } from "../gameModelPerformance";
import { bestMosaicRuns, compareMosaicScores, mosaicScoreTitle } from "../benchmark/mosaicScore";
import { pickRunReference, runReferenceKey, type GameBenchmarkReviewSetup } from "../gameAuxWindows";
import { formalHistoryResults, formalRecordProject, formalRecordStep } from "../benchmark/formalRunHistory";
import { isTauri } from "@tauri-apps/api/core";
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

const mosaicSpeedConditions = "整轮成功完成、逐图结果完整且计时有效时显示。";

function mosaicSpeedTooltip(row: MosaicTaskReport["totals"][number], anomalies: string, anomalyDetails: string) {
  if (row.score.speed !== null) {
    return `整轮用时 ÷ 有效结果数 × 100\n本轮 ${row.seconds.toFixed(1)} 秒 ÷ ${row.validRuns} 张 × 100`;
  }
  const timing = row.score.details.find(detail => detail.key === "timing")?.current;
  return [
    mosaicSpeedConditions,
    `本轮 ${row.validRuns} / ${row.samples} 张有有效结果`,
    anomalies,
    timing,
    anomalyDetails || (!anomalies && !timing ? row.score.speedUnavailableReason : ""),
  ].filter(Boolean).join("\n");
}

function tooltipStyle(colors: ChartColors) {
  return {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    textStyle: { color: colors.text, fontSize: colors.captionSize },
  };
}

export function BenchmarkReviewWindow({ setup, onClose }: { setup: GameBenchmarkReviewSetup; onClose: () => void }) {
  const { queueId, scope, step, formal } = setup;
  const referenceKey = runReferenceKey(queueId, formal);
  const [reference, setReference] = useState(() => localStorage.getItem(referenceKey) || "");
  const [runs, setRuns] = useState<readonly BenchmarkCompareRun[]>();
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof readMosaicComparisonRuns>>>();
  const [report, setReport] = useState<MosaicTaskReport>();
  const [loadingReport, setLoadingReport] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [qualityError, setQualityError] = useState("");
  const record = runs?.[0]?.performance;
  const target = formal && record ? formalRecordStep(record) : step;
  const stage = target === "mosaicScreen" || target === "mosaicRefine" ? target : undefined;
  const archivedPath = record?.benchmark?.referenceSampleSetPath ?? record?.benchmark?.sampleSetPath;
  const referencePath = reference || (typeof archivedPath === "string" ? archivedPath : undefined);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === referenceKey || event.key === null) setReference(localStorage.getItem(referenceKey) || "");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [referenceKey]);

  function selectReference(path: string) {
    if (path) localStorage.setItem(referenceKey, path);
    else localStorage.removeItem(referenceKey);
    setReference(path);
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      const records = formal ? formalHistoryResults(await readGameFormalHistory(scope, step)) : await readGameBenchmarkHistory(scope, step);
      if (!active) return;
      const task = groupBenchmarkTasks(records).find(item => item.id === queueId);
      if (!task) throw new Error("找不到该任务的记录");
      setRuns(task.runs);
      const target = formal ? formalRecordStep(task.runs[0].performance) : step;
      if (target !== "mosaicScreen" && target !== "mosaicRefine") return;
      if (!task.runs.some(run => run.performance.formalRun?.imageDetails || run.performance.benchmark?.imageDetails)) return;
      const archive = await readMosaicComparisonRuns(queueId, task.runs);
      if (active) setEntries(archive);
    })().catch(error => {
      if (active) setLoadError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [queueId, scope, step, formal]);

  useEffect(() => {
    if (!stage || !entries) return;
    let active = true;
    setLoadingReport(true);
    setQualityError("");
    setReport(undefined);
    void scoreMosaicComparisonRuns(entries, referencePath, stage, !!reference).then(result => {
      if (active) setReport(result);
    }).catch(error => {
      if (active) setQualityError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (active) setLoadingReport(false);
    });
    return () => { active = false; };
  }, [entries, reference, referencePath, stage]);

  const scoredRuns = useMemo(() => {
    if (!report) return runs;
    const quality = new Map(report.totals.map(row => [row.runId, row]));
    return runs?.map(run => ({ ...run, quality: quality.get(run.performance.taskId ?? "") }));
  }, [runs, report]);

  if (!scoredRuns) return <main className="game-aux-loading">
    <p role={loadError ? "alert" : "status"}>{loadError || "正在读取运行记录…"}</p>
    <button type="button" className="unity-btn" onClick={onClose}>关闭</button>
  </main>;
  const projectPath = formal ? formalRecordProject(scope) : scope?.replace(/(?::text|:images)?:benchmark:(?:text|images|mosaic)$/, "");
  const projectName = projectPath?.split(/[\\/]/).filter(Boolean).at(-1);
  const canCompare = !!stage && scoredRuns.some(run => run.performance.formalRun?.imageDetails || run.performance.benchmark?.imageDetails);
  return <RunComparePanel label={setup.label} projectName={projectName} runs={scoredRuns} report={report}
    loading={loadingReport || (canCompare && !entries && !loadError)} qualityError={qualityError || loadError}
    itemUnit={setup.itemUnit} onClose={onClose} formal={formal}
    referenceActions={canCompare && isTauri() && <>
      <button type="button" className="unity-btn" title={referencePath} onClick={() =>
        void pickRunReference(referencePath).then(path => { if (path) selectReference(path); })
          .catch(error => showAppNotice(String(error), "error"))}>选择对照集</button>
      {reference && <button type="button" className="unity-btn" onClick={() => selectReference("")}>恢复原对照集</button>}
    </>} />;
}

const RunComparePanel = memo(function RunComparePanel({
  label, projectName, runs, report, loading, qualityError, itemUnit, onClose, formal, referenceActions,
}: {
  label: string;
  formal?: boolean;
  referenceActions?: ReactNode;
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
  const [expandedRunId, setExpandedRunId] = useState<string>();
  const f1 = new Map(runs.map(run => [run.performance.taskId, summarizeRun(run).f1]));
  const runConfigs = new Map(runs.map(run => [run.performance.taskId, run.performance.benchmark?.config as BenchmarkConfig | undefined]));
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
    .sort((a, b) => (b.score.displayScore ?? -1) - (a.score.displayScore ?? -1));
  const highest = rated[0], lowest = rated.at(-1);
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
  const qualityCols = screening ? 9 : 6;
  const totalCols = 2 + qualityCols + (screening ? 0 : 4) + 2;

  return <main className="benchmark-report" aria-labelledby={titleId}>
    <header className="benchmark-report-head">
      <div>
        <h2 id={titleId}>{label}</h2>
        <p>{[projectName, headerTime, `共 ${runs.length} 次运行`].filter(Boolean).join("，")}</p>
      </div>
      <div className="benchmark-report-actions">
        {referenceActions}
        {report && <button type="button" className="unity-btn is-secondary" onClick={() => void downloadMosaicTaskReport(report, formal)
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
      <p>{report.title}，定位框按 IoU ≥ 0.5 最大一对一匹配</p>
      <p id={titleId + "-f1"}>{screening ? "初筛按有码保留和无码剔除评分。" : "复筛按图级判定、框级匹配、复核与速度评分。交付覆盖采用固定人工框分母。"} 排名先比较漏选，再比较漏框。F1 为明确图级判定的参考值。</p>
      <div className="benchmark-report-table" tabIndex={0} role="region" aria-label="运行结果表" aria-describedby={titleId + "-f1"}>
        <table>
          <colgroup span={1} /><colgroup span={qualityCols} />{!screening && <colgroup span={4} />}<colgroup span={2} /><colgroup span={1} />
          <thead>
            <tr>
              <th rowSpan={2} scope="col" className="benchmark-report-config">配置</th>
              <th colSpan={qualityCols} scope="colgroup" className="benchmark-report-group is-quality">质量</th>
              {!screening && <th colSpan={4} scope="colgroup" className="benchmark-report-group is-coverage benchmark-report-group-start">覆盖</th>}
              <th colSpan={2} scope="colgroup" className="benchmark-report-group is-efficiency benchmark-report-group-start">效率</th>
              <th rowSpan={2} scope="col" className="benchmark-report-ranking benchmark-report-group-start">资格</th>
            </tr>
            <tr>
              <th scope="col" aria-sort={sortState("score")}><button type="button" title="按漏选、漏框、分数的顺序排名" onClick={() => sortBy("score")}>{screening ? "候选保留分" : "综合分"} <span aria-hidden="true">{sortMark("score")}</span></button></th>
              <th scope="col" aria-sort={sortState("f1")}><button type="button" onClick={() => sortBy("f1")}>图级 F1 <span aria-hidden="true">{sortMark("f1")}</span></button></th>
              {screening ? <><th scope="col">直接筛掉的有码</th><th scope="col">保留给下游的有码</th><th scope="col">移交的无码</th></>
                : <><th scope="col">漏图</th><th scope="col">误报</th></>}
              <th scope="col">待复核</th><th scope="col">未确认判有码</th>
              <th scope="col" className={screening ? undefined : "benchmark-report-group-start"}>匹配框/可评框</th>
              {!screening && <th scope="col">交付覆盖</th>}<th scope="col">多余框</th>
              {!screening && <th scope="col" className="benchmark-report-ratio">判定率</th>}
              <th scope="col" className="benchmark-report-group-start"
                data-tooltip={"整轮用时 ÷ 有效结果数 × 100\n" + mosaicSpeedConditions}>每百张秒数</th>
              <th scope="col" aria-sort={sortState("seconds")}><button type="button" onClick={() => sortBy("seconds")}>用时 <span aria-hidden="true">{sortMark("seconds")}</span></button></th>
            </tr>
          </thead>
          <tbody>{rows.map(row => {
            const config = runConfigs.get(row.runId)?.mosaic;
            const concurrency = screening ? config?.concurrency : config?.refineConcurrency;
            const hasConcurrency = concurrency !== undefined && Number.isInteger(concurrency) && concurrency > 0;
            const label = hasConcurrency ? row.label.replace(/\s*[\u00b7，,]\s*并发\s+\d+\s*$/u, "") : row.label;
            const isBest = winners.has(row.runId);
            const expanded = expandedRunId === row.runId;
            const reasonId = titleId + "-why-" + row.runId;
            const anomalies = [
              row.score.details.find(detail => detail.key === "status")?.current,
              row.pending > 0 ? `待筛选 ${row.pending} 张` : "",
              row.missing > 0 ? `缺行 ${row.missing} 张` : "",
              row.invalid > 0 ? `异常 ${row.invalid} 条` : "",
            ].filter(Boolean).join("，");
            const anomalyDetails = [...row.issues, ...Object.entries(row.reasons).map(([reason, count]) => `${reason} × ${count}`)]
              .join("，").replaceAll("·", "，");
            return <Fragment key={row.runId}><tr data-best={isBest || undefined}
              data-selected={row.runId === activeRunId || undefined} onClick={() => setSelectedRunId(row.runId)}>
            <td className="benchmark-report-config">
              <button type="button" className="benchmark-report-select" aria-pressed={row.runId === activeRunId} title={label}>{label}</button>
              <small>第 {row.round} 轮{hasConcurrency ? `，并发 ${concurrency}` : ""}
                {groups.size > 1 ? `，第 ${row.groupNumber} 组` : ""}</small>
              {(anomalies || anomalyDetails) && <small className="benchmark-report-anomaly" data-tooltip={anomalyDetails || undefined}
                tabIndex={anomalyDetails ? 0 : undefined}>{anomalies || "运行异常"}</small>}
            </td>
            <td className="benchmark-report-score"><b>{row.score.displayScore?.toFixed(1) ?? "—"}</b>
              <i>{row.score.provisional && "暂定 "}{row.score.effectiveWeight}/100</i><details className="benchmark-report-score-details">
              <summary>分项</summary><ul>{row.score.items.map(item => <li key={item.label}>
                {item.label} {item.ratio === null ? item.missing : `${Number(item.numerator.toFixed(2))}/${Number(item.denominator.toFixed(2))}，得 ${(item.ratio * item.weight).toFixed(2)}/${item.weight} 分`}
              </li>)}</ul>
            </details></td>
            <td>{percent(row.f1)}</td><td>{row.fn}</td>
            {screening ? <><td>{row.evaluatedPositive - row.fn}</td><td>{row.fp + row.reviewNegative}</td></> : <td>{row.fp}</td>}
            <td>{row.review}</td><td>{row.unlabelledPositive}</td>
            <td className={screening ? undefined : "benchmark-report-group-start"}>{row.foundBoxes} / {row.evaluatedBoxes}</td>
            {!screening && <td title={row.expectedBoxes ? `${row.foundBoxes}/${row.expectedBoxes} 框` : undefined}>{percent(row.score.delivery)}</td>}
            <td>{row.extraBoxes}</td>
            {!screening && <td className="benchmark-report-ratio"><span>有码 {percent(row.score.positiveCoverage)}</span>
              {row.score.negativeCoverage !== null && <span>无码 {percent(row.score.negativeCoverage)}</span>}
              <span>框 {percent(row.score.boxCoverage)}</span>
            </td>}
            <td className="benchmark-report-group-start" data-tooltip={mosaicSpeedTooltip(row, anomalies, anomalyDetails)}
              tabIndex={row.score.speed === null ? 0 : undefined}>
              {row.score.speed?.toFixed(1) ?? "—"}
            </td><td>{gameDuration(row.elapsedMs)}</td>
            <td className="benchmark-report-ranking benchmark-report-group-start">
              {row.score.eligible ? <span className={`benchmark-report-badge${isBest ? " is-best" : ""}`}>{isBest ? "最佳" : "合格"}</span> :
                <button type="button" className="benchmark-report-badge" aria-expanded={expanded} aria-controls={expanded ? reasonId : undefined}
                  aria-label={`${label}的资格，不参与`} onClick={() => setExpandedRunId(expanded ? undefined : row.runId)}>不参与</button>}
            </td>
          </tr>{expanded && <tr className="benchmark-report-why" id={reasonId}><td colSpan={totalCols}>
            <p>不参与排名，{row.score.details.length} 项未达标</p>
            <ul>{row.score.details.map(detail => <li key={detail.key}>
              <b>{detail.label}</b><span>当前 {detail.current}</span>
              <span>要求 {detail.required}</span><span>补 {detail.action}</span>
            </li>)}</ul>
          </td></tr>}</Fragment>;
          })}</tbody>
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
