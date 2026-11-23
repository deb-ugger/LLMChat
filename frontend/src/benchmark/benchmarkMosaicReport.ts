
import { readImageBenchmarkDetails } from "./imageBenchmarkHistory";
import { compareBoxes, loadAnnotatedSampleSet } from "./imageSampleSet";
import type { BenchmarkResult } from "../gameTextBenchmark";

export async function compareMosaicTaskWithDataset(queueId: string, runs: readonly BenchmarkResult[], path: string) {
  const dataset = await loadAnnotatedSampleSet(path, { preserveDuplicates: true });
  const byId = new Map(dataset.images.map(image => [image.id, image]));
  const byProject = new Map(dataset.images.filter(image => image.projectImageId && image.projectSourceHash)
    .map(image => [image.projectImageId + "\0" + image.projectSourceHash, image]));
  const totals = [];
  for (const run of runs) {
    const runId = run.performance.taskId;
    if (!runId || !run.performance.benchmark?.imageDetails) continue;
    const { samples, results } = await readImageBenchmarkDetails(queueId, runId);
    let tp = 0, fp = 0, tn = 0, fn = 0, review = 0, failed = 0, unlabelled = 0, unlabelledPositive = 0;
    let expectedBoxes = 0, foundBoxes = 0, extraBoxes = 0;
    for (const [index, sample] of samples.entries()) {
      const original = byId.get(sample.id);
      const annotation = (original?.sourceHash === sample.sourceHash ? original :
        byProject.get(sample.id + "\0" + sample.sourceHash))?.annotation.mosaic;
      const result = results[index];
      const present = result?.category === "疑似有码" || result?.category === "复筛确认有码";
      if (!annotation || annotation.state === "uncertain") {
        unlabelled++;
        if (present) unlabelledPositive++;
        continue;
      }
      if (annotation.state === "present") expectedBoxes += annotation.boxes?.length ?? 0;
      if (!result || result.status === "失败" || result.status === "跳过") { failed++; continue; }
      if (result.category === "待复核") { review++; continue; }
      if (annotation.state === "present") {
        if (present) tp++; else fn++;
      } else {
        if (present) fp++; else tn++;
      }
      if (present && (annotation.state === "none" || annotation.boxes?.length)) {
        const boxes = result.boxes ?? [];
        const count = compareBoxes(annotation.boxes ?? [], boxes).length;
        foundBoxes += count;
        if (!annotation.partialBoxes) extraBoxes += boxes.length - count;
      }
    }
    totals.push({ runId, label: run.label, round: run.round, samples: samples.length, tp, fp, tn, fn, review, failed, unlabelled,
      unlabelledPositive, expectedBoxes, foundBoxes, extraBoxes, seconds: Math.round(run.performance.elapsedMs / 10) / 100 });
  }
  if (!totals.length) throw new Error("此任务暂无逐图结果");
  return { title: dataset.title, totals };
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
