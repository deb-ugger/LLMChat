import { readFileBytes } from "../localDocFile";
import { sha256Hex } from "../fileFingerprint";
import { mosaicBoxCoverage, type MosaicTruth } from "./mosaicScoreInputs";
import { gameTextMatchesSource, gameTextNeedsNoTranslation } from "../gameDisplayText";
import type { ImageBenchmarkStep } from "../gameImageBenchmark";
import type { MosaicBox } from "../gameMosaic";
import type { MosaicBenchmarkStep } from "../gameMosaicBenchmark";
import type { UnityImage, UnityImageRegion, UnityProject } from "../unityOffline";

type SampleImage = { id: string; path: string; sha256: string; width: number; height: number; projectImageId?: string; projectSourceHash?: string; sourceHash?: string; scene?: string; sourceDirectory?: string; adopted?: boolean };
type Presence = "present" | "none" | "uncertain";
export type PresenceVerdict = Presence | "skip" | "failed";
type ExpectedText = { box: MosaicBox; text?: string; language?: string; keep?: boolean;
  translations?: Record<string, string>; drafts?: Record<string, string> };
export type LabeledMosaicBox = MosaicBox & { part?: string };
export type SampleAnnotation = {
  provenance?: string;
  adopted?: boolean;
  mosaic?: Omit<MosaicTruth, "boxes"> & { boxes?: LabeledMosaicBox[] };
  text?: { state: Presence; regions?: ExpectedText[]; initialBoxes?: MosaicBox[] };
};
export type SampleSetManifest = {
  version: number; kind: string; title: string; images: SampleImage[]; annotationsFile?: string;
  purposes?: ("mosaic" | "text")[];
};
export type SampleSetAnnotations = { version: number; samples: Record<string, SampleAnnotation> };
export type AnnotatedImage = UnityImage & { scene?: string; sourceDirectory?: string; adopted?: boolean; annotation: SampleAnnotation; projectImageId?: string; projectSourceHash?: string };
export type AnnotatedSampleSet = {
  title: string;
  manifest: SampleSetManifest;
  annotations: SampleSetAnnotations;
  images: AnnotatedImage[];
  project: UnityProject;
  read: (image: UnityImage, signal: AbortSignal) => Promise<Blob>;
};

const pngId = /^[0-9a-f]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

async function readJson<T>(path: string, readBytes: typeof readFileBytes): Promise<T> {
  return JSON.parse(decoder.decode(await readBytes(path))) as T;
}

export function sampleTextMatchesScope(image: AnnotatedImage, source: string, target: string, skipTarget: boolean) {
  const regions = image.annotation.text?.regions;
  return !regions?.length || regions.some(region => regionInScope(region,source,target,skipTarget));
}

function regionInScope(region: ExpectedText, source: string, target: string, skipTarget: boolean) {
  const text = region.text?.trim() || "";
  const language = region.language === "und" ? undefined : region.language;
  return !region.keep && (!text || (gameTextMatchesSource(text,source,language) && (!skipTarget || !gameTextNeedsNoTranslation(text,target))));
}

function validBox(box: MosaicBox, { width, height }: SampleImage) {
  return Array.isArray(box) && box.length === 4 && box.every(Number.isInteger) &&
    box[0] >= 0 && box[1] >= 0 && box[2] > box[0] && box[3] > box[1] && box[2] <= width && box[3] <= height;
}

export async function loadAnnotatedSampleSet(path: string, options?: {
  includeUnannotated?: boolean; preserveDuplicates?: boolean; verifyContent?: boolean; readBytes?: typeof readFileBytes;
}): Promise<AnnotatedSampleSet> {
  const readBytes = options?.readBytes ?? readFileBytes;
  const absolute = path.replaceAll("\\", "/");
  const directory = absolute.slice(0, absolute.lastIndexOf("/") + 1);
  if (!directory) throw new Error("请选择样本集的 manifest.json");
  const manifest = await readJson<SampleSetManifest>(absolute, readBytes);
  if (manifest?.version !== 1 || manifest.kind !== "llmchat-image-sample-set" ||
      typeof manifest.title !== "string" || !Array.isArray(manifest.images))
    throw new Error("样本集清单格式不正确");

  const annotationsFile = manifest.annotationsFile ?? "annotations.json";
  if (typeof annotationsFile !== "string" || !/^annotations(?:\.[^/\\:*?"<>|]+)?\.json$/u.test(annotationsFile))
    throw new Error("样本集标注文件名无效");
  const annotations = await readJson<SampleSetAnnotations>(directory + annotationsFile, readBytes);
  if (annotations?.version !== 1 || !annotations.samples || typeof annotations.samples !== "object" || Array.isArray(annotations.samples))
    throw new Error("样本集标注文件格式不正确");

  const unique = new Set<string>();
  const images: AnnotatedImage[] = [];
  for (const [index, item] of manifest.images.entries()) {
    if (!item || !pngId.test(item.sha256) || typeof item.path !== "string" ||
        !Number.isSafeInteger(item.width) || item.width <= 0 || !Number.isSafeInteger(item.height) || item.height <= 0)
      throw new Error("样本集含无效图片索引");
    if (!options?.preserveDuplicates && unique.has(item.sha256)) continue;
    const id = unique.has(item.sha256) ? item.sha256 + "-" + index : item.sha256;
    unique.add(item.sha256);
    const saved = annotations.samples[item.sha256];
    if (!saved && !options?.includeUnannotated) continue;
    const annotation = saved || {};
    // Work annotations may attach a human label to a box; consumers keep the
    // original coordinate-array contract. Frozen v1 arrays remain unchanged.
    if (Array.isArray(annotation.mosaic?.boxes)) {
      annotation.mosaic.boxes = annotation.mosaic.boxes.map(value => {
        if (Array.isArray(value)) return value;
        const record = value as unknown as { box?: unknown; part?: unknown };
        if (!Array.isArray(record?.box)) return value;
        return Object.assign([...record.box] as MosaicBox, { part: typeof record.part === "string" ? record.part : undefined });
      });
    }
    const { mosaic, text } = annotation;
    const states = [mosaic?.state, text?.state].filter(state => state !== undefined);
    if (mosaic && (!states.includes(mosaic.state) || (mosaic.boxes !== undefined && !Array.isArray(mosaic.boxes)) ||
        (mosaic.partialBoxes !== undefined && typeof mosaic.partialBoxes !== "boolean") ||
        (mosaic.boxCoverage !== undefined && mosaic.boxCoverage !== "complete" && mosaic.boxCoverage !== "partial") ||
        (mosaic.state === "none" && !!mosaic.boxes?.length) ||
        (mosaic.boxCoverage === "complete" && (mosaic.partialBoxes === true || mosaic.state === "uncertain" ||
          (mosaic.state === "present" && !mosaic.boxes?.length)))))
      throw new Error("样本标注完整性与真值不一致：" + item.path);
    const boxes = [...(mosaic?.boxes ?? []), ...(text?.initialBoxes ?? []), ...(text?.regions ?? []).map(region => region.box)];
    if (states.some(state => state !== "present" && state !== "none" && state !== "uncertain") ||
        !boxes.every(box => validBox(box, item)))
      throw new Error("样本标注状态或坐标无效：" + item.path);

    const name = item.path.replaceAll("\\\\", "/").split("/").at(-1) || item.path;
    images.push({ id, sourceHash: item.sha256, projectImageId: item.projectImageId, projectSourceHash: item.projectSourceHash ?? item.sourceHash, name, file: item.path, width: item.width, height: item.height,
      kind: "PNG", sourceFile: item.sha256, container: "", objectId: "", renderedFile: "", renderedHash: "",
      selected: true, ocrCompleted: false, completed: false, error: "", regions: [], scene: item.scene, sourceDirectory: item.sourceDirectory, adopted: item.adopted ?? annotation.adopted, annotation });
  }
  const project: UnityProject = { version: 1, scanRevision: 5, root: directory, folder: directory, entries: [], fonts: [], warnings: [], hashes: {} };
  return {
    title: manifest.title, manifest, annotations, images, project, read: async (image, signal) => {
      signal.throwIfAborted();
      if (!pngId.test(image.sourceHash)) throw new Error("标注样本编号无效");
      const data = await readBytes(directory + "images/" + image.sourceHash + ".png");
      if (options?.verifyContent && await sha256Hex(data) !== image.sourceHash) throw new Error("样本内容与冻结哈希不一致：" + image.file);
      signal.throwIfAborted();
      return new Blob([data], { type: "image/png" });
    },
  };
}

export function annotatedMosaicSamples(set: AnnotatedSampleSet, step: MosaicBenchmarkStep) {
  return set.images.filter(({ annotation: { mosaic } }) => step === "mosaicRedraw"
    ? mosaic?.state === "present" && !!mosaic.boxes?.length
    : mosaic?.state === "present" || mosaic?.state === "none");
}

export function annotatedTextSamples(set: AnnotatedSampleSet, step: ImageBenchmarkStep, targets: readonly string[]) {
  return set.images.filter(({ annotation: { text } }) => {
    if (!text || text.state === "uncertain") return false;
    if (step === "filter") return true;
    if (step === "refine") return !!text.initialBoxes?.length;
    if (step === "recognize") return text.state === "none" || !!text.regions?.length;
    return text.state === "present" && !!text.regions?.length && text.regions.every(region => !!region.text?.trim()) &&
      (step === "imageTranslate" || (step === "review" || step === "render") && targets.every(target =>
        text.regions!.some(region => !(region.keep) && !!(step === "render" ? region.translations : region.drafts)?.[target]?.trim())));
  });
}

export function annotatedTextInput({ annotation, ...image }: AnnotatedImage, step: ImageBenchmarkStep, source: string, target: string, skipTarget: boolean): UnityImage {
  const text = annotation.text!;
  if (step === "refine") {
    const regions = text.initialBoxes!.map(([x0,y0,x1,y1]): UnityImageRegion =>
      ({ x0,y0,x1,y1,text:"",confidence:100,translation:"",selected:false,error:"" }));
    return { ...image, regions, screening: { version: 1, sourceHash: image.sourceHash, source, target, state: "review",
      boxes: regions.length, reason: "标注样本的初筛输入", reviewSelected: true } };
  }
  if (step !== "imageTranslate" && step !== "review" && step !== "render") return image;
  const regions = text.regions!.map((region): UnityImageRegion => {
    const { box: [x0,y0,x1,y1], text = "", translations, drafts } = region;
    const translation = (step === "render" ? translations : step === "review" ? drafts : undefined)?.[target]?.trim() || "";
    const selected = regionInScope(region,source,target,skipTarget) && (step === "imageTranslate" || !!translation);
    return { x0,y0,x1,y1,text,confidence:100,ocrConfirmed:true,manualSelected:true,selected,translation,translationTarget:target,
      error: step === "review" && selected ? "待复核的初译样本" : "" };
  });
  return { ...image, regions, ocrCompleted: true };
}

export function presenceScore(rows: Iterable<readonly [SampleAnnotation, PresenceVerdict]>, kind: "mosaic" | "text") {
  let matched = 0, falsePositive = 0, missed = 0, review = 0, skipped = 0;
  for (const [annotation, verdict] of rows) {
    const expected = annotation[kind]?.state;
    if (!expected || expected === "uncertain" || verdict === "failed") continue;
    if (verdict === "skip") { skipped++; continue; }
    if (verdict === "uncertain") { review++; continue; }
    if (expected === verdict) matched++;
    else if (verdict === "present") falsePositive++;
    else missed++;
  }
  return "判定相符 " + matched + " · 误报 " + falsePositive + " · 漏检 " + missed + " · 待复核 " + review +
    (skipped ? " · 按规则跳过 " + skipped : "");
}

export function compareBoxes(expected: readonly MosaicBox[], predicted: readonly MosaicBox[]) {
  const available = new Set(predicted.keys());
  const pairs: [number,number][] = [];
  expected.forEach((box, expectedIndex) => {
    let match: number | undefined, best = .5;
    for (const index of available) {
      const other = predicted[index];
      const overlap = Math.max(0, Math.min(box[2],other[2]) - Math.max(box[0],other[0])) *
        Math.max(0, Math.min(box[3],other[3]) - Math.max(box[1],other[1]));
      const area = (box[2]-box[0])*(box[3]-box[1]) + (other[2]-other[0])*(other[3]-other[1]);
      const iou = overlap / (area - overlap);
      if (iou >= best) { best = iou; match = index; }
    }
    if (match !== undefined) {
      pairs.push([expectedIndex,match]);
      available.delete(match);
    }
  });
  return pairs;
}

export function mosaicBoxScore(rows: Iterable<readonly [SampleAnnotation, MosaicBox[]]>) {
  let matched = 0, expectedCount = 0, extra = 0, fullSamples = 0;
  for (const [annotation, predicted] of rows) {
    const mosaic = annotation.mosaic;
    const expected = mosaic?.state === "none" ? [] : mosaic?.boxes;
    if (!expected || (mosaic?.state === "present" && !expected.length)) continue;
    const count = compareBoxes(expected,predicted).length;
    matched += count;
    expectedCount += expected.length;
    if (mosaic && mosaicBoxCoverage(mosaic) === "complete") {
      extra += predicted.length - count;
      fullSamples++;
    }
  }
  if (!expectedCount && !extra) return "";
  return "定位匹配 " + matched + "/" + expectedCount + " 框（IoU≥0.5）" +
    (fullSamples ? " · 多余框 " + extra + "（仅完整标注）" : "");
}

export function textBoxScore(rows: Iterable<readonly [SampleAnnotation, UnityImageRegion[]]>, source: string, target: string, skipTarget: boolean) {
  let matched = 0, expectedCount = 0, correctText = 0, matchedWithText = 0;
  const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");
  for (const [annotation, observed] of rows) {
    const expected = annotation.text?.regions?.filter(region => regionInScope(region,source,target,skipTarget));
    if (!expected?.length) continue;
    const pairs = compareBoxes(expected.map(region => region.box), observed.map(region => [region.x0,region.y0,region.x1,region.y1]));
    matched += pairs.length;
    expectedCount += expected.length;
    for (const [left,right] of pairs) {
      const text = expected[left].text?.trim();
      if (!text) continue;
      matchedWithText++;
      if (normalize(text) === normalize(observed[right].text)) correctText++;
    }
  }
  return expectedCount ? "文字框匹配 " + matched + "/" + expectedCount + "（IoU≥0.5）" +
    (matchedWithText ? " · 已匹配框原文一致 " + correctText + "/" + matchedWithText : "") : "";
}
