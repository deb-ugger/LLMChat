
import { readImageBenchmarkDetails, type ImageBenchmarkDetails } from "./imageBenchmarkHistory";
import { loadAnnotatedSampleSet } from "./imageSampleSet";
import { countMosaicResults } from "./mosaicScoreCounts";
import { mosaicTruthLookup, verifyMosaicFreeze, type MosaicScoreFreeze } from "./mosaicScoreInputs";
import { bestMosaicRuns, mosaicScoreTitle, scoreMosaicRun, type MosaicScoreStage } from "./mosaicScore";
import type { BenchmarkResult } from "../gameTextBenchmark";

export async function compareMosaicTaskWithDataset(queueId: string, runs: readonly BenchmarkResult[], path?: string, stage: MosaicScoreStage = "mosaicRefine") {
  const entries: { run: BenchmarkResult; runId: string; details?: ImageBenchmarkDetails; issue?: string }[] = [];
  for (const run of runs) {
    const runId = run.performance.taskId;
    if (!runId) continue;
    if (!run.performance.benchmark?.imageDetails) {
      entries.push({ run, runId, issue: "本轮没有逐图归档" });
      continue;
    }
    try { entries.push({ run, runId, details: await readImageBenchmarkDetails(queueId, runId) }); }
    catch (error) { entries.push({ run, runId, issue: "逐图归档读取失败：" + String(error) }); }
  }
  const shared = entries.find(entry => entry.details)?.details?.samples;
  if (!shared) throw new Error(entries.find(entry => entry.issue)?.issue || "此任务暂无逐图结果");
  const dataset = path && shared.some(sample => sample.mosaicTruth === undefined) ? await loadAnnotatedSampleSet(path) : undefined;
  const lookup = mosaicTruthLookup(dataset);
  const totals = [];
  for (const { run, runId, details, issue } of entries) {
    const { samples, results } = details ?? { samples: shared, results: {} };
    const issues = issue ? [issue] : [];
    const metadata = run.performance.benchmark;
    const expected = metadata?.scoreFreeze as MosaicScoreFreeze | undefined;
    let freeze: MosaicScoreFreeze | undefined;
    if (expected && samples.every(sample => sample.mosaicTruth !== undefined)) {
      try {
        freeze = await verifyMosaicFreeze(samples, expected);
        if (!freeze) issues.push("归档与冻结样本、初筛种子或标注版本不符");
      } catch (error) { issues.push(String(error)); }
    }
    if (samples.length !== run.selected) issues.push("归档样本数与计划不一致");
    const counts = countMosaicResults(samples, results, sample => {
      try { return lookup(sample); }
      catch (error) {
        issues.push(String(error));
        return null;
      }
    });
    const row = { ...counts, runId, label: run.label, round: run.round, elapsedMs: run.performance.elapsedMs,
      seconds: run.performance.elapsedMs / 1000, status: run.status, runFailures: run.failed, freeze, issues,
      timing: typeof metadata?.scoreTiming === "string" ? metadata.scoreTiming : undefined,
      configId: (metadata?.config as { id?: string } | undefined)?.id || run.label };
    totals.push({ ...row, score: scoreMosaicRun(stage, row) });
  }
  return { title: dataset?.title ?? "样本对照", stage, totals };
}
export type MosaicTaskReport = Awaited<ReturnType<typeof compareMosaicTaskWithDataset>>;

export async function createMosaicTaskWorkbook(report: MosaicTaskReport) {
  const { default: Zip } = await import("jszip");
  const book = new Zip();
  const namespace = "http://schemas.openxmlformats.org";
  const best = bestMosaicRuns(report.totals);
  const screening = report.stage === "mosaicScreen";
  const percentage = (value: number | null) => value === null ? "" : Number((value * 100).toFixed(2));
  const rows = [["配置", "轮次", "样本数", "不同原图", mosaicScoreTitle(report.stage), "评分标记", "有效权重", "缺项",
    "最佳", "最佳资格", "运行状态", "图级F1（%）", "判对有码", "漏图", "判对无码", "误报",
    "已确认有码图", "已确认无码图", "有码待复核", "无码待复核", "失败", "跳过", "待筛选", "缺行", "异常",
    "未确认样本", "未确认图判为有码", "未确认图待复核", "固定人工框数", "可评人工框数", "匹配框数（IoU≥0.5）",
    "未交付框数", "多余框（完整标注）", "完整域预测框数", "完整域匹配框数",
    "交付覆盖（%）", "可评框覆盖（%）", "有码明确判定率（%）", "无码明确判定率（%）",
    "用时秒", "每百张秒数", "冻结样本与种子", "冻结标注版本", "计时协议", "异常原因",
    ...(screening ? ["保留给下游的有码", "移交的无码"] : []),
    ...(report.totals[0]?.score.items ?? []).flatMap(item => ["分子", "分母", "权重", "得分"].map(column => item.label + " " + column))],
  ...report.totals.map(r => {
    const denominator = 2 * r.tp + r.fp + r.fn;
    return [r.label, r.round, r.samples, r.originals, r.score.displayScore ?? "", r.score.provisional ? "暂定" : "",
      r.score.effectiveWeight, r.score.items.filter(item => item.missing).map(item => item.label + "：" + item.missing).join(" · "),
      best.has(r.runId) ? "最佳" : "", r.score.eligible ? "合格" : r.score.rankingReasons.join(" · "), r.status,
      percentage(denominator ? 2 * r.tp / denominator : null), r.tp, r.fn, r.tn, r.fp, r.confirmedPositive, r.confirmedNegative,
      r.reviewPositive, r.reviewNegative, r.failed, r.skipped, r.pending, r.missing, r.invalid,
      r.unlabelled, r.unlabelledPositive, r.unlabelledReview, r.expectedBoxes, r.evaluatedBoxes, r.foundBoxes,
      r.expectedBoxes - r.foundBoxes, r.extraBoxes, r.completePredictedBoxes, r.completeMatchedBoxes,
      percentage(r.score.delivery), percentage(r.score.boxCoverage), percentage(r.score.positiveCoverage), percentage(r.score.negativeCoverage),
      Number.isFinite(r.seconds) ? r.seconds : "", r.score.speed ?? "", r.freeze?.inputs ?? "", r.freeze?.truth ?? "", r.timing ?? "",
      [...r.issues, ...Object.entries(r.reasons).map(([reason, count]) => reason + " × " + count)].join(" · "),
      ...(screening ? [r.evaluatedPositive - r.fn, r.fp + r.reviewNegative] : []),
      ...r.score.items.flatMap(item => [item.numerator, item.denominator, item.weight, item.ratio === null ? "" : item.ratio * item.weight])];
  })];
  const xml = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  book.file("[Content_Types].xml", '<Types xmlns="' + namespace + '/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  const link = (kind: string, target: string) => '<Relationships xmlns="' + namespace + '/package/2006/relationships"><Relationship Id="rId1" Type="' + namespace + '/officeDocument/2006/relationships/' + kind + '" Target="' + target + '"/></Relationships>';
  book.file("_rels/.rels", link("officeDocument", "xl/workbook.xml"));
  book.file("xl/_rels/workbook.xml.rels", link("worksheet", "worksheets/sheet1.xml"));
  book.file("xl/workbook.xml", '<workbook xmlns="' + namespace + '/spreadsheetml/2006/main" xmlns:r="' + namespace + '/officeDocument/2006/relationships"><sheets><sheet name="数据集对照" sheetId="1" r:id="rId1"/></sheets></workbook>');
  book.file("xl/worksheets/sheet1.xml", '<worksheet xmlns="' + namespace + '/spreadsheetml/2006/main"><sheetData>' +
    rows.map((row, index) => '<row r="' + (index + 1) + '">' + row.map((value, column) => {
      let letters = "";
      for (let number = column + 1; number > 0; number = Math.floor((number - 1) / 26))
        letters = String.fromCharCode(65 + (number - 1) % 26) + letters;
      const ref = letters + (index + 1);
      return typeof value === "number" ? '<c r="' + ref + '"><v>' + value + '</v></c>' :
        '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xml(value) + '</t></is></c>';
    }).join("") + '</row>').join("") + '</sheetData></worksheet>');
  return book.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export async function downloadMosaicTaskReport(report: MosaicTaskReport) {
  const blob = await createMosaicTaskWorkbook(report);
  const url = URL.createObjectURL(blob);
  const linkElement = document.createElement("a");
  linkElement.href = url; linkElement.download = "图片去码测试总结.xlsx"; linkElement.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
