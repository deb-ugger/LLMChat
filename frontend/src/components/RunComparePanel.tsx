import * as echarts from "echarts/core";
import { BarChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, LegendScrollComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { downloadMosaicTaskReport, readMosaicComparisonRuns, scoreMosaicComparisonRuns, type MosaicTaskReport } from "../benchmark/benchmarkMosaicReport";
import { groupBenchmarkTasks, readGameBenchmarkHistory, readGameFormalHistory, type BenchmarkConfig } from "../gameTextBenchmark";
import { gameDuration } from "../gameModelPerformance";
const MOSAIC_SPEED_CONDITIONS = "整轮成功完成、逐图结果完整且计时有效时显示。";
const mosaicSpeedHint = (row: { seconds: number; validRuns: number; samples: number; score: { speed: number | null; speedUnavailableReason?: string } }) =>
  row.score.speed !== null
    ? `整轮用时 ÷ 有效结果数 × 100\n本轮 ${row.seconds.toFixed(1)} 秒 ÷ ${row.validRuns} 张 × 100`
    : `${row.score.speedUnavailableReason ?? "用时无效"}（有效 ${row.validRuns} / ${row.samples} 张）\n${MOSAIC_SPEED_CONDITIONS}`;

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
      <div className="benchmark-report-sort" role="group" aria-label="排序方式">
        <span>排序</span>
        <span className="benchmark-report-sr" aria-live="polite" aria-atomic="true">
          {sort.key === "score"
            ? `组内按${screening ? "初筛排名" : "综合排名"}${sort.descending ? "正序" : "倒序"}列出`
            : `组内按${sort.key === "f1" ? "图级 F1" : "用时"}${sort.descending ? "降序" : "升序"}列出`}
        </span>
        {([["score", screening ? "候选保留分" : "综合分"], ["f1", "图级 F1"], ["seconds", "用时"]] as const).map(([key, text]) =>
          <button key={key} type="button" aria-pressed={sort.key === key} onClick={() => sortBy(key)}>
            {text}<span aria-hidden="true">{sort.key === key ? (sort.descending ? " ↓" : " ↑") : ""}</span>
          </button>)}
      </div>
      <div className="benchmark-report-cards" role="region" aria-label="运行结果卡片" tabIndex={0}
        aria-describedby={titleId + "-f1"}>
        {rows.map(row => {
          const config = runConfigs.get(row.runId)?.mosaic;
          const concurrency = screening ? config?.concurrency : config?.refineConcurrency;
          const hasConcurrency = concurrency !== undefined && Number.isInteger(concurrency) && concurrency > 0;
          const label = hasConcurrency ? row.label.replace(/\s*[\u00b7，,]\s*并发\s+\d+\s*$/u, "") : row.label;
          const isBest = winners.has(row.runId);
          const expanded = expandedRunId === row.runId;
          const reasonId = titleId + "-why-" + row.runId;
          const statusNote = row.score.details.find(detail => detail.key === "status")?.current;
          const anomalies = [
            statusNote && statusNote !== "完成" ? statusNote : "",
            row.pending > 0 ? `待筛选 ${row.pending} 张` : "",
            row.missing > 0 ? `缺行 ${row.missing} 张` : "",
            row.invalid > 0 ? `异常 ${row.invalid} 条` : "",
          ].filter(Boolean).join("，");
          const anomalyDetails = [...row.issues, ...Object.entries(row.reasons).map(([reason, count]) => `${reason} × ${count}`)]
            .join("，").replaceAll("·", "，");
          const figures = screening ? [
            ["直接筛掉的有码", String(row.fn)],
            ["保留给下游的有码", String(row.evaluatedPositive - row.fn)],
            ["移交的无码", String(row.fp + row.reviewNegative)],
            ["待复核", String(row.review)],
            ["未确认判有码", String(row.unlabelledPositive)],
            ["多余框", String(row.extraBoxes)],
            ["每百张秒数", row.score.speed?.toFixed(1) ?? "—", mosaicSpeedHint(row)],
            ["待筛选 / 缺行 / 异常", `${row.pending} / ${row.missing} / ${row.invalid}`],
          ] : [
            ["漏图", String(row.fn)],
            ["误报", String(row.fp)],
            ["待复核", String(row.review)],
            ["未确认判有码", String(row.unlabelledPositive)],
            ["交付覆盖 · 固定人工框分母", `${percent(row.score.delivery)}${row.expectedBoxes ? ` · ${row.foundBoxes}/${row.expectedBoxes} 框` : ""}`],
            ["人工框全覆盖图片", `${row.fullyCoveredPositiveImages}/${row.completePositiveImages}`],
            ["多余框", String(row.extraBoxes)],
            ["判定率 · 有码 / 无码 / 框", `${percent(row.score.positiveCoverage)} · ${percent(row.score.negativeCoverage)} · ${percent(row.score.boxCoverage)}`],
            ["每百张秒数", row.score.speed?.toFixed(1) ?? "—", mosaicSpeedHint(row)],
            ["待筛选 / 缺行 / 异常", `${row.pending} / ${row.missing} / ${row.invalid}`],
          ];
          return <article key={row.runId} className="benchmark-report-card" data-best={isBest || undefined}
            data-selected={row.runId === activeRunId || undefined} onClick={() => setSelectedRunId(row.runId)}>
            <header>
              <button type="button" className="benchmark-report-select" aria-pressed={row.runId === activeRunId} title={label}>{label}</button>
              <small>第 {row.round} 轮{hasConcurrency ? ` · 并发 ${concurrency}` : ""}{groups.size > 1 ? ` · 第 ${row.groupNumber} 组` : ""}</small>
              {anomalies && <small className="benchmark-report-anomaly" data-tooltip={anomalyDetails || undefined}
                tabIndex={anomalyDetails ? 0 : undefined}>{anomalies}</small>}
              <span className="benchmark-report-card-grow" />
              {row.score.eligible
                ? <span className={`benchmark-report-badge${isBest ? " is-best" : ""}`}>{isBest ? "最佳 · 合格" : "合格"}</span>
                : <button type="button" className="benchmark-report-badge is-out" aria-expanded={expanded}
                  aria-controls={expanded ? reasonId : undefined} aria-label={`${label}的资格，不参与`}
                  onClick={event => { event.stopPropagation(); setExpandedRunId(expanded ? undefined : row.runId); }}>不参与</button>}
              <button type="button" className="benchmark-report-expand" aria-expanded={expanded}
                aria-controls={expanded ? reasonId : undefined} aria-label={`${expanded ? "收起" : "展开"}${label}的细项`}
                onClick={event => { event.stopPropagation(); setExpandedRunId(expanded ? undefined : row.runId); }}>
                {expanded ? "收起" : "展开"}
              </button>
            </header>
            <dl className="benchmark-report-figs">
              <div>
                <dt>{screening ? "候选保留分" : "综合分"} · 权重 {row.score.effectiveWeight}/100</dt>
                <dd>{row.score.displayScore?.toFixed(1) ?? "—"}{row.score.provisional && <em>暂定</em>}</dd>
              </div>
              <div><dt>图级 F1</dt><dd>{percent(row.f1)}</dd></div>
              <div><dt>匹配框 / 可评框</dt><dd>{row.foundBoxes} <small>/ {row.evaluatedBoxes}</small></dd></div>
              <div><dt>用时</dt><dd>{gameDuration(row.elapsedMs)}</dd></div>
            </dl>
            {expanded && <div className="benchmark-report-detail" id={reasonId} onClick={event => event.stopPropagation()}>
              <div>
                <h4>本次结果细项</h4>
                <dl>{figures.map(([name, value, hint]) => <div key={name} data-tooltip={hint} tabIndex={hint ? 0 : undefined}>
                  <dt>{name}</dt><dd>{value}</dd>
                </div>)}</dl>
              </div>
              <div>
                <h4>评分构成 · 有效权重 {row.score.effectiveWeight} / 100</h4>
                {row.score.items.map(item => {
                  const width = item.ratio === null ? 0 : Math.max(0, Math.min(1, item.ratio)) * 100;
                  return <div key={item.label} className="benchmark-report-bar">
                    <span>{item.label}</span>
                    <i><b style={{ width: `${width}%` }} data-low={item.ratio !== null && item.ratio < 0.35 || undefined} /></i>
                    <em>{item.ratio === null ? item.missing : `${(item.ratio * item.weight).toFixed(2)} / ${item.weight}`}</em>
                  </div>;
                })}
                {!row.score.eligible && <p className="benchmark-report-reason">
                  未参与排名，{row.score.details.length} 项未达标：
                  {row.score.details.map(detail => ` ${detail.label}（当前 ${detail.current}，要求 ${detail.required}，补 ${detail.action}）`).join("；")}
                </p>}
                {(anomalies || anomalyDetails) && <p className="benchmark-report-reason is-anomaly">
                  异常：{anomalies || "运行异常"}{anomalyDetails ? ` · ${anomalyDetails}` : ""}
                </p>}
              </div>
            </div>}
          </article>;
        })}
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
