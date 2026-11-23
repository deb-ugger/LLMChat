
import { readImageBenchmarkDetails, type ImageBenchmarkDetails } from "./imageBenchmarkHistory";
import { loadAnnotatedSampleSet } from "./imageSampleSet";
import { countMosaicResults } from "./mosaicScoreCounts";
import { freezeMosaicInputs, mosaicTruthLookup, type MosaicScoreFreeze } from "./mosaicScoreInputs";
import type { BenchmarkResult } from "../gameTextBenchmark";

export async function compareMosaicTaskWithDataset(queueId: string, runs: readonly BenchmarkResult[], path?: string) {
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
        const actual = await freezeMosaicInputs(samples);
        if (expected.version === actual.version && expected.inputs === actual.inputs && expected.truth === actual.truth) freeze = actual;
        else issues.push("归档与冻结样本、初筛种子或标注版本不符");
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
    totals.push({ ...counts, runId, label: run.label, round: run.round, elapsedMs: run.performance.elapsedMs,
      seconds: run.performance.elapsedMs / 1000, status: run.status, runFailures: run.failed, freeze, issues,
      timing: typeof metadata?.scoreTiming === "string" ? metadata.scoreTiming : undefined,
      configId: (metadata?.config as { id?: string } | undefined)?.id || run.label });
  }
  return { title: dataset?.title ?? "冻结样本对照", totals };
}
export type MosaicTaskReport = Awaited<ReturnType<typeof compareMosaicTaskWithDataset>>;

export async function downloadMosaicTaskReport(report: MosaicTaskReport) {
  const { default: Zip } = await import("jszip");
  const book = new Zip();
  const namespace = "http://schemas.openxmlformats.org";
  const rows = [["配置", "轮次", "样本数", "判对有码", "漏检", "判对无码", "误报", "已标注待复核", "已标注失败或跳过",
    "未确认样本", "未确认图判为有码", "人工框数", "匹配框数（IoU≥0.5）", "未找回框数", "多余框（完整标注）", "用时秒"],
  ...report.totals.map(r => [r.label, r.round, r.samples, r.tp, r.fn, r.tn, r.fp, r.review, r.failed,
    r.unlabelled, r.unlabelledPositive, r.expectedBoxes, r.foundBoxes, r.expectedBoxes-r.foundBoxes, r.extraBoxes, r.seconds])];
  const xml = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  book.file("[Content_Types].xml", '<Types xmlns="' + namespace + '/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  const link = (kind: string, target: string) => '<Relationships xmlns="' + namespace + '/package/2006/relationships"><Relationship Id="rId1" Type="' + namespace + '/officeDocument/2006/relationships/' + kind + '" Target="' + target + '"/></Relationships>';
  book.file("_rels/.rels", link("officeDocument", "xl/workbook.xml"));
  book.file("xl/_rels/workbook.xml.rels", link("worksheet", "worksheets/sheet1.xml"));
  book.file("xl/workbook.xml", '<workbook xmlns="' + namespace + '/spreadsheetml/2006/main" xmlns:r="' + namespace + '/officeDocument/2006/relationships"><sheets><sheet name="数据集对照" sheetId="1" r:id="rId1"/></sheets></workbook>');
  book.file("xl/worksheets/sheet1.xml", '<worksheet xmlns="' + namespace + '/spreadsheetml/2006/main"><sheetData>' +
    rows.map((row, index) => '<row r="' + (index + 1) + '">' + row.map((value, column) => {
      const ref = String.fromCharCode(65 + column) + (index + 1);
      return typeof value === "number" ? '<c r="' + ref + '"><v>' + value + '</v></c>' :
        '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xml(value) + '</t></is></c>';
    }).join("") + '</row>').join("") + '</sheetData></worksheet>');
  const blob = await book.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const linkElement = document.createElement("a");
  linkElement.href = url; linkElement.download = "图片去码测试总结.xlsx"; linkElement.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
