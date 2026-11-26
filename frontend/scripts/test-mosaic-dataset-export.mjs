import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { build } from "../node_modules/esbuild/lib/main.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(repo, "tmp/mosaic-export");
await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, "regression-"));
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
globalThis.window = { dispatchEvent() {} };
// Node has no bitmap decoder; real browser decoding is covered by the screenshot fixture.
globalThis.createImageBitmap = async file => {
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), close() {} };
};
const built = await build({ entryPoints: [path.join(repo, "frontend/src/benchmark/trainingDatasets.ts")],
  bundle: true, write: false, format: "esm", platform: "browser", treeShaking: true });
const production = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64"));
const { exportMosaicDataset, csvRows } = production;
function chunk(name, bytes) {
  const kind = Buffer.from(name), data = Buffer.concat([kind, bytes]);
  let crc = 0xffffffff;
  for (const value of data) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), tail = Buffer.alloc(4); size.writeUInt32BE(bytes.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, data, tail]);
}
function png(value) {
  const header = Buffer.alloc(13); header.writeUInt32BE(64); header.writeUInt32BE(48, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((64 * 3 + 1) * 48);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    const offset = y * 193 + 1 + x * 3; pixels[offset] = value * 11; pixels[offset + 1] = x * 3 + (value >> 8); pixels[offset + 2] = y * 5;
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
const key = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
function encrypted(bytes) { const body = Buffer.from(bytes); for (let i = 0; i < 16; i++) body[i] ^= key[i]; return Buffer.concat([Buffer.from("5250474d560000000003010000000000", "hex"), body]); }
const inputs = Array.from({ length: 20 }, (_, index) => {
  const group = index < 6 ? Math.floor(index / 2) : index - 3;
  const checked = group % 2 === 0;
  const boxes = group % 3 === 0 ? [] : [Object.assign([4, 5, 24, 30], { part: checked ? "female_external" : "" })];
  return { image: { id: "image-" + index, file: "img/pictures/sample_" + index + ".png_", name: "sample_" + index + ".png_",
    sourceHash: "original-" + group, width: 64, height: 48 }, checked, boxes };
});
const sources = new Map(inputs.map(input => [input.image.id, encrypted(png(Number(input.image.sourceHash.split("-").at(-1))))]));
const sourceHashes = [...sources].map(([id, value]) => [id, createHash("sha256").update(value).digest("hex")]);
const read = async (image, signal) => {
  signal.throwIfAborted(); const original = sources.get(image.id), bytes = Buffer.from(original.subarray(16));
  assert.equal(original.subarray(0, 4).toString(), "RPGM");
  for (let i = 0; i < 16; i++) bytes[i] ^= key[i];
  return new Blob([bytes], { type: "image/png" });
};
async function execute(name, records, readImage = read, configure = () => {}, writeError = () => false) {
  const directory = path.join(run, name).replaceAll("\\", "/");
  await mkdir(directory, { recursive: true });
  const controller = new AbortController(), events = [];
  const target = { id: crypto.randomUUID(), directory, title: "当前工程 · 全量导出 · 2026-11-26" };
  const writer = async request => {
    if (writeError(request)) throw Error("注入写盘失败");
    const destination = path.join(directory, request.file); await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, new Uint8Array(request.bytes));
  };
  const result = await exportMosaicDataset(target, records, readImage, writer, controller.signal, (current, total) => {
    events.push([current, total]); configure(controller, current);
  });
  await writeFile(path.join(directory, "report.json"), JSON.stringify(result.report, null, 2));
  return { ...result, events, directory };
}
const full = await execute("full", inputs);
assert.equal(full.report.total, 20); assert.equal(full.report.present, 7); assert.equal(full.report.none, 13);
assert.equal(full.report.unique, 17); assert.equal(full.report.merged, 3); assert.equal(full.report.duplicates.length, 3);
assert.equal(full.report.boxes, 7); assert.equal(full.report.boxesWithPart, 7); assert.equal(full.report.failures.length, 0);
assert.equal(full.dataset.data.manifest.images.length, 20);
assert.equal((await readdir(path.join(full.directory, "images"))).length, 17);
assert.deepEqual(full.events, inputs.map((_, index) => [index + 1, 20]));
const manifest = JSON.parse(await readFile(path.join(full.directory, "manifest.json"), "utf8"));
assert.equal(manifest.version, 1); assert.equal(manifest.kind, "llmchat-image-sample-set"); assert.equal(manifest.annotationsFile, "annotations.work.json");
const labels = JSON.parse(await readFile(path.join(full.directory, "annotations.work.json"), "utf8"));
for (const [index, input] of inputs.entries()) {
  const annotation = labels.samples[manifest.images[index].sha256].mosaic;
  assert.equal(annotation.state, input.checked && input.boxes.length ? "present" : "none", input.image.file);
  assert.deepEqual(annotation.boxes, annotation.state === "present" ? input.boxes.map(box => ({ box: [...box], part: box.part ?? "" })) : []);
}
const csv = csvRows(await readFile(path.join(full.directory, "review.csv"), "utf8"));
assert.equal(csv[0].join(","), "sample,box,image_path,scene,suggested_part,corrected_part");
assert.equal(csv.length, 7); // Six unique positive images; seven positive source records.
assert.ok(csv.slice(1).every(row => row[5] === "female_external" && row[1] === "[4,5,24,30]"));
assert.deepEqual([...sources].map(([id, value]) => [id, createHash("sha256").update(value).digest("hex")]), sourceHashes);
console.log("PASS 全量20条 / 有码7 / 无码13 / 唯一PNG17 / 合并3 / 部位框7/7 / 失败0；原始加密字节不变");
const failedRead = await execute("read-failure", inputs, async (image, signal) => { if (image.id === "image-7") throw Error("注入解密失败"); return read(image, signal); });
assert.equal(failedRead.report.processed, 20); assert.deepEqual(failedRead.report.failures, [{ path: inputs[7].image.file, error: "注入解密失败" }]);
const failedWrite = await execute("write-failure", inputs, read, () => {}, request => request.file.startsWith("images/") && request.file.includes(manifest.images[7].sha256));
assert.equal(failedWrite.report.processed, 20); assert.equal(failedWrite.report.failures.length, 1); assert.equal(failedWrite.report.failures[0].path, inputs[7].image.file);
console.log("PASS 单图解密失败、写盘失败各1条，均继续处理到20/20并保留具体路径与原因");
const conflict = await execute("conflict", [{ ...inputs[0], checked: false, boxes: [] }, { ...inputs[1], checked: true, boxes: [[1, 1, 10, 10]] }]);
assert.equal(conflict.report.failures.length, 1); assert.match(conflict.report.failures[0].error, /同内容图片/);
console.log("PASS 同SHA标注冲突显式报告，不覆盖已有标注");
const aborted = await execute("cancelled", inputs, read, (controller, current) => { if (current === 7) controller.abort(); });
assert.equal(aborted.report.processed, 7); assert.equal(aborted.report.cancelled, true); assert.equal(aborted.dataset.data.manifest.images.length, 7);
console.log("PASS 第7/20项取消，保留7条有效记录，未继续读取后续图片");
const parts = await execute("parts", [
  { ...inputs[6], checked: true, boxes: [[1, 2, 10, 20]] },
  { ...inputs[7], checked: true, boxes: [Object.assign([2, 3, 11, 21], { part: "未知" })] },
]);
const partRows = csvRows(await readFile(path.join(parts.directory, "review.csv"), "utf8"));
assert.deepEqual(partRows.slice(1).map(row => row[5]), ["", "未知"]);
assert.equal(parts.report.boxesWithPart, 1);
console.log("PASS 缺失part留空、已有未知标签原样保存，未推断部位");
const workbench = await readFile(path.join(repo, "frontend/src/components/GameMosaicWorkbench.tsx"), "utf8");
assert.match(workbench, /return images\.map\(image =>/); assert.match(workbench, /applyMosaicDrafts\(latestRows\.current, mosaicDraftsOf\(gamePath\)\)/);
console.log("PASS 工作台接线使用全量images和当前草稿，不依赖筛选或分页");
const largeInputs = Array.from({ length: 1360 }, (_, index) => {
  const group = index < 6 ? Math.floor(index / 2) : index - 3;
  const checked = group % 2 === 0;
  const boxes = group % 3 === 0 ? [] : [Object.assign([4, 5, 24, 30], { part: checked ? "female_external" : "" })];
  const image = { id: "image-" + index, file: "img/pictures/sample_" + index + ".png_", name: "sample_" + index + ".png_",
    sourceHash: "original-" + group, width: 64, height: 48 };
  sources.set(image.id, encrypted(png(group)));
  return { image, checked, boxes };
});
const large = await execute("full-1360", largeInputs);
assert.equal(large.report.total, 1360); assert.equal(large.report.present, 453); assert.equal(large.report.none, 907);
assert.equal(large.report.unique, 1357); assert.equal(large.report.merged, 3); assert.equal(large.report.failures.length, 0);
assert.equal((await readdir(path.join(large.directory, "images"))).length, 1357);
assert.equal(large.dataset.data.manifest.images.length, 1360);
console.log("PASS 1360条规模导出 / 有码453 / 无码907 / 唯一PNG1357 / 合并3 / 部位框453/453 / 失败0");
await writeFile(path.join(output, "fixture-inputs.json"), JSON.stringify(largeInputs.map(input => ({ ...input,
  boxes: input.boxes.map(box => ({ box: [...box], part: box.part })), encrypted: sources.get(input.image.id).toString("base64") }))));
await writeFile(path.join(output, "latest-regression.json"), JSON.stringify({ run, report: large.report, samples: large.report.samples.filter(x => x.state === "present").slice(0, 3).concat(large.report.samples.filter(x => x.state === "none").slice(0, 3)) }, null, 2));
console.log("ALL PASS (7类) · 产物 " + large.directory);
