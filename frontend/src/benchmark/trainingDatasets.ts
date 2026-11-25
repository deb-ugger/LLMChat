import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { sha256Hex } from "../fileFingerprint";
import type { MosaicBox } from "../gameMosaic";
import { readFileBytes } from "../localDocFile";
import { loadAnnotatedSampleSet, type AnnotatedImage, type AnnotatedSampleSet, type SampleAnnotation,
  type SampleSetAnnotations, type SampleSetManifest } from "./imageSampleSet";

export type DatasetPurpose = "mosaic" | "text";
export type DatasetVerdict = "present" | "none" | "unmarked";
export const datasetPurposes: readonly DatasetPurpose[] = ["mosaic", "text"];
export const datasetPurposeLabels = { mosaic: "去码", text: "图片翻译" };
export const datasetVerdictLabels = {
  mosaic: { present: "有码", none: "无码", unmarked: "未标注" },
  text: { present: "有文字", none: "无文字", unmarked: "未标注" },
};
export const datasetParts = { male_external: "男", female_external: "女", other: "其他" };
export type DatasetPart = keyof typeof datasetParts;
type PartLabels = Record<string, DatasetPart>;
export type DatasetReference = {
  path: string; title: string; count: number; labeled: number; purposes: DatasetPurpose[]; workId?: string;
};
export type TrainingDataset = { reference: DatasetReference; data: AnnotatedSampleSet; parts: PartLabels };
export type TrainingDatasetWrite = { id: string; file: string; bytes: ArrayBuffer };
export type DatasetWriter = (write: TrainingDatasetWrite) => Promise<unknown>;

const workingDirectory = "training-datasets";
const annotationsFile = "annotations.work.json";
const catalogKey = "llmchat-training-datasets";
const manifestFile = "manifest.json";
const reviewFile = "review.csv";
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const rasterExtension = /\.(?:png|jpe?g|webp|bmp|gif|avif)$/i;
const pngHeader = [137, 80, 78, 71, 13, 10, 26, 10];
const encode = (value: string) => new TextEncoder().encode(value).buffer;
const jsonBytes = (value: unknown) => encode(JSON.stringify(value, null, 2) + "\n");
const decode = (bytes: ArrayBuffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const canonicalPath = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
const imageFile = (hash: string) => `images/${hash}.png`;
const fileIn = (path: string, name: string) => canonicalPath(path).replace(/[^/]+$/, name);

async function workingPath(id: string) {
  if (!uuid.test(id)) throw new Error("工作副本标识无效");
  return canonicalPath(await join(await appLocalDataDir(), workingDirectory, id));
}

// Only the main benchmark host calls the existing desktop write command.
export async function writeTrainingDatasetFile(request: unknown) {
  const value = request as Partial<TrainingDatasetWrite> | null;
  if (!value || typeof value.id !== "string" || typeof value.file !== "string" || !(value.bytes instanceof ArrayBuffer) ||
    (![manifestFile, annotationsFile, reviewFile].includes(value.file) && !/^images\/[0-9a-f]{64}\.png$/.test(value.file))) {
    throw new Error("无效的数据集写入请求");
  }
  const path = `${await workingPath(value.id)}/${value.file}`;
  await invoke<void>("write_file_bytes", { path, contents: Array.from(new Uint8Array(value.bytes)) });
}

export function readDatasetCatalog(): DatasetReference[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(catalogKey) ?? "[]");
    return Array.isArray(value) ? value.filter(item => item && typeof item.path === "string" && typeof item.title === "string" &&
      typeof item.count === "number" && typeof item.labeled === "number" && Array.isArray(item.purposes)) : [];
  } catch { return []; }
}

export function rememberDataset(reference: DatasetReference) {
  const items = readDatasetCatalog();
  const index = items.findIndex(item => item.path === reference.path);
  if (index < 0) items.unshift(reference);
  else items[index] = reference;
  localStorage.setItem(catalogKey, JSON.stringify(items));
  return items;
}

export function datasetVerdict(annotation: SampleAnnotation, purpose: DatasetPurpose): DatasetVerdict {
  const state = annotation[purpose]?.state;
  return state === "present" || state === "none" ? state : "unmarked";
}

function purposesOf(data: AnnotatedSampleSet) {
  const declared = Array.isArray(data.manifest.purposes) ? data.manifest.purposes : [];
  const purposes = datasetPurposes.filter(purpose => declared.includes(purpose) || data.images.some(image => image.annotation[purpose]));
  return purposes.length ? purposes : [...datasetPurposes];
}

function referenceFor(path: string, data: AnnotatedSampleSet, workId?: string): DatasetReference {
  return { path, workId, title: data.title, count: data.images.length, purposes: purposesOf(data),
    labeled: data.images.filter(({ annotation }) => datasetPurposes.some(purpose => datasetVerdict(annotation, purpose) !== "unmarked")).length };
}

function boxKey(hash: string, box: MosaicBox) {
  return `${hash}:${JSON.stringify(box)}`;
}

export function partFor(dataset: TrainingDataset, hash: string, box: MosaicBox) {
  return dataset.parts[boxKey(hash, box)];
}

export function csvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && (character === "," || character === "\n")) {
      row.push(cell);
      cell = "";
      if (character === "\n") { rows.push(row); row = []; }
    } else if (quoted || character !== "\r") cell += character;
  }
  if (row.length || cell) rows.push([...row, cell]);
  return rows;
}

function readParts(text: string): PartLabels {
  const [header, ...rows] = csvRows(text);
  if (!header) return {};
  const [sampleIndex, boxIndex, partIndex] = ["sample", "box", "corrected_part"].map(column => header.indexOf(column));
  if (sampleIndex < 0 || boxIndex < 0 || partIndex < 0) throw new Error("review.csv 缺少样本、蒙版或人工确认列");
  const parts: PartLabels = {};
  for (const row of rows) {
    const part = row[partIndex]?.trim();
    if (!Object.hasOwn(datasetParts, part)) continue;
    const box: unknown = JSON.parse(row[boxIndex]);
    if (Array.isArray(box) && box.length === 4 && box.every(Number.isInteger)) {
      parts[boxKey(row[sampleIndex], box as MosaicBox)] = part as DatasetPart;
    }
  }
  return parts;
}

async function openParts(path: string) {
  try { return readParts(decode(await readFileBytes(fileIn(path, reviewFile)))); }
  catch (error) {
    if (/os error [23]\b/i.test(String(error))) return {};
    throw error;
  }
}

export async function openTrainingDataset(path: string, workId?: string): Promise<TrainingDataset> {
  path = canonicalPath(path);
  const ownId = workId && path === `${await workingPath(workId)}/${manifestFile}` ? workId : undefined;
  const data = await loadAnnotatedSampleSet(path, { includeUnannotated: true });
  const parts = await openParts(path);
  return { data, parts, reference: referenceFor(path, data, ownId) };
}

export function datasetManifestIn(directory: string) {
  return `${canonicalPath(directory)}/${manifestFile}`;
}

function sceneFamily(path: string) {
  const entry = canonicalPath(path);
  const name = entry.slice(entry.lastIndexOf("/") + 1);
  const stem = name.replace(/\.[^.]+$/, "");
  const family = stem.toLowerCase().replace(/(?:[_~-]?\d+)+$/, "").replace(/[_-]+$/, "");
  return entry.slice(0, entry.length - name.length) + (family || stem);
}

function reviewContents(path: string, images: AnnotatedImage[], parts: PartLabels) {
  const rows = [["sample", "box", "image_path", "scene", "suggested_part", "corrected_part"]];
  for (const image of images) {
    const { mosaic } = image.annotation;
    if (mosaic?.state !== "present") continue;
    for (const box of mosaic.boxes ?? []) {
      rows.push([image.sourceHash, JSON.stringify(box), fileIn(path, imageFile(image.sourceHash)), sceneFamily(image.file),
        "", parts[boxKey(image.sourceHash, box)] ?? ""]);
    }
  }
  return rows.map(row => row.map(cell => /[",\r\n]/.test(cell) ? '"' + cell.replaceAll('"', '""') + '"' : cell).join(",")).join("\n") + "\n";
}

async function createWorkDataset(title: string, manifest: SampleSetManifest, annotations: SampleSetAnnotations,
  parts: PartLabels, copyImages: (write: (file: string, bytes: ArrayBuffer) => Promise<unknown>) => Promise<void>, writer: DatasetWriter) {
  const id = crypto.randomUUID();
  const directory = await workingPath(id);
  const path = `${directory}/${manifestFile}`;
  const write = (file: string, bytes: ArrayBuffer) => writer({ id, file, bytes });
  await copyImages(write);
  const savedManifest = { ...manifest, title, annotationsFile, images: manifest.images.map(image => ({ ...image, id: image.sha256 })) };
  const manifestBytes = jsonBytes(savedManifest);
  const annotationBytes = jsonBytes(annotations);
  const data = await loadAnnotatedSampleSet(path, { includeUnannotated: true, readBytes: file => {
    if (file === path) return Promise.resolve(manifestBytes);
    if (file === `${directory}/${annotationsFile}`) return Promise.resolve(annotationBytes);
    return readFileBytes(file);
  } });
  await write(annotationsFile, annotationBytes);
  await write(reviewFile, encode(reviewContents(path, data.images, parts)));
  await write(manifestFile, manifestBytes);
  return { data, parts, reference: referenceFor(path, data, id) };
}

export function copyTrainingDataset(source: TrainingDataset, title: string, writer: DatasetWriter, signal: AbortSignal) {
  const { data, parts } = source;
  return createWorkDataset(title, { ...data.manifest, purposes: purposesOf(data) }, data.annotations, parts, async write => {
    for (const image of data.images) {
      const bytes = await (await data.read(image, signal)).arrayBuffer();
      if (await sha256Hex(bytes) !== image.sourceHash) throw new Error(`样本内容与清单哈希不一致：${image.file}`);
      signal.throwIfAborted();
      await write(imageFile(image.sourceHash), bytes);
    }
  }, writer);
}

async function importPng(file: File) {
  const image = await createImageBitmap(file);
  try {
    const original = await file.arrayBuffer();
    const prefix = new Uint8Array(original, 0, Math.min(8, original.byteLength));
    if (pngHeader.every((byte, index) => prefix[index] === byte)) {
      return { bytes: original, width: image.width, height: image.height };
    }
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error(`无法读取图片：${file.name}`);
    context.drawImage(image, 0, 0);
    const bytes = await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
    return { bytes, width: image.width, height: image.height };
  } finally { image.close(); }
}

export async function importTrainingDataset(files: File[], title: string, writer: DatasetWriter, signal: AbortSignal) {
  const selected = new Map(files.map(file => [file.webkitRelativePath.replace(/^[^/]+\//, ""), file]));
  if (selected.has(manifestFile)) {
    const path = `/selected/${manifestFile}`;
    const data = await loadAnnotatedSampleSet(path, { includeUnannotated: true, readBytes: file => {
      const item = selected.get(file.slice("/selected/".length));
      if (!item) throw new Error(`图片集缺少 ${file.slice("/selected/".length)}`);
      return item.arrayBuffer();
    } });
    const review = selected.get(reviewFile);
    const parts = review ? readParts(decode(await review.arrayBuffer())) : {};
    return copyTrainingDataset({ data, parts, reference: referenceFor(path, data) }, title || data.title, writer, signal);
  }
  const sources = [...selected].filter(([name]) => rasterExtension.test(name));
  if (!sources.length) throw new Error("所选目录没有支持的图片");
  const manifest: SampleSetManifest = { version: 1, kind: "llmchat-image-sample-set", title,
    purposes: [...datasetPurposes], images: [] };
  return createWorkDataset(title, manifest, { version: 1, samples: {} }, {}, async write => {
    const hashes = new Set<string>();
    for (const [name, file] of sources) {
      signal.throwIfAborted();
      const { bytes, width, height } = await importPng(file);
      const hash = await sha256Hex(bytes);
      if (!hashes.has(hash)) {
        await write(imageFile(hash), bytes);
        hashes.add(hash);
      }
      manifest.images.push({ id: hash, sha256: hash, path: name, width, height });
    }
  }, writer);
}

export function labelDatasetImages(dataset: TrainingDataset, hashes: ReadonlySet<string>, purpose: DatasetPurpose, verdict: DatasetVerdict) {
  const samples = { ...dataset.data.annotations.samples };
  for (const image of dataset.data.images) {
    if (!hashes.has(image.sourceHash)) continue;
    const annotation = { ...samples[image.sourceHash] };
    if (verdict === "unmarked") delete annotation[purpose];
    else if (purpose === "mosaic") {
      annotation.mosaic = verdict === "none" ? { state: "none", boxCoverage: "complete", boxes: [] }
        : { ...annotation.mosaic, state: "present", ...(annotation.mosaic?.state !== "present" && { boxCoverage: "partial" }) };
    } else annotation.text = verdict === "none" ? { state: "none" } : { ...annotation.text, state: "present" };
    if (annotation.mosaic || annotation.text) samples[image.sourceHash] = annotation;
    else delete samples[image.sourceHash];
  }
  return samples;
}

export async function saveDatasetLabels(dataset: TrainingDataset, samples: SampleSetAnnotations["samples"],
  parts: PartLabels, writer: DatasetWriter) {
  const { path, workId } = dataset.reference;
  if (!workId || path !== `${await workingPath(workId)}/${manifestFile}`) throw new Error("请先复制数据集到工作副本");
  const annotations = { version: 1, samples };
  const images = dataset.data.images.map(image => ({ ...image, annotation: samples[image.sourceHash] ?? {} }));
  const validParts: PartLabels = {};
  for (const image of images) {
    if (image.annotation.mosaic?.state !== "present") continue;
    for (const box of image.annotation.mosaic.boxes ?? []) {
      const key = boxKey(image.sourceHash, box);
      if (parts[key]) validParts[key] = parts[key];
    }
  }
  const previousCsv = reviewContents(path, dataset.data.images, dataset.parts);
  const nextCsv = reviewContents(path, images, validParts);
  if (nextCsv !== previousCsv) await writer({ id: workId, file: reviewFile, bytes: encode(nextCsv) });
  try {
    if (samples !== dataset.data.annotations.samples) await writer({ id: workId, file: annotationsFile, bytes: jsonBytes(annotations) });
  } catch (error) {
    if (nextCsv !== previousCsv) await writer({ id: workId, file: reviewFile, bytes: encode(previousCsv) });
    throw error;
  }
  const data = { ...dataset.data, annotations, images };
  return { data, parts: validParts, reference: referenceFor(path, data, workId) };
}

export function setDatasetPart(dataset: TrainingDataset, hash: string, box: MosaicBox, part: DatasetPart | "", writer: DatasetWriter) {
  const parts = { ...dataset.parts };
  const key = boxKey(hash, box);
  if (part) parts[key] = part;
  else delete parts[key];
  return saveDatasetLabels(dataset, dataset.data.annotations.samples, parts, writer);
}
