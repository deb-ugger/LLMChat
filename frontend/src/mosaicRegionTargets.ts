import { Channel, invoke } from "@tauri-apps/api/core";
import type { Settings } from "./api";
import { mosaicRedrawDirectory, type MosaicBox, type MosaicSettings } from "./gameMosaic";
import { requestGameModelJson } from "./gameModelRequest";
import type { UnityImage } from "./unityOffline";

export type MosaicTargetPart = "male_external" | "female_external";
type RegionPart = MosaicTargetPart | "other" | "unknown";
export type MosaicRegionTargeting = { model: string; guard: string };
export type MosaicTargetResolver = (image: UnityImage, source: Blob, boxes: readonly MosaicBox[], signal: AbortSignal) => Promise<MosaicTargetPart[]>;
type SceneRows = Readonly<Record<string, { source: string; group?: string }>>;
type TargetEvidence = { box: MosaicBox; part: RegionPart; context: number[]; direct: boolean };
type TargetImage = { source: string; size: [number, number]; evidence: TargetEvidence[] };
type TargetModel = { directory: string; revision: string };
type TargetCache = { revision: string | null; images: Record<string, TargetImage> };

const targetingPolicy = "mosaic-target-evidence-v1";
const partPrompt = "Classify only the structure obscured in the cyan rectangle of this adult fictional game illustration. " +
  "Use the visible position, contours and neighboring anatomy. male_external means external male genital anatomy, " +
  "female_external means the vulva region, other means unrelated content. Use unknown when visible evidence is insufficient. " +
  'Return one JSON object with "part" set to one of these four values and "visible_evidence" set to a boolean.';

export function mosaicRegionTargeting(settings: MosaicSettings): MosaicRegionTargeting | undefined {
  if (!settings.regionTargeting) return;
  return { model: settings.refineModel || "qwen3.5:latest", guard: settings.refineGuardModel || "qwen3-vl:8b-instruct" };
}

function targetKey(root: string, config: MosaicRegionTargeting) {
  return "llmchat-mosaic-targets:" + JSON.stringify([root, targetingPolicy, config.model, config.guard]);
}

function cachedTargets(key: string, revision: string | null) {
  const stored = JSON.parse(localStorage.getItem(key) || "null") as TargetCache | null;
  return stored?.revision === revision ? stored.images : {};
}

function regionView(bitmap: ImageBitmap, box: MosaicBox) {
  const margin = Math.max(40, Math.round(Math.max(box[2] - box[0], box[3] - box[1]) * .55));
  const left = Math.max(0, box[0] - margin);
  const top = Math.max(0, box[1] - margin);
  const width = Math.min(bitmap.width, box[2] + margin) - left;
  const height = Math.min(bitmap.height, box[3] + margin) - top;
  const crop = document.createElement("canvas");
  const scale = Math.min(1, 448 / Math.max(width, height));
  crop.width = Math.max(1, Math.round(width * scale));
  crop.height = Math.max(1, Math.round(height * scale));
  const drawing = crop.getContext("2d");
  if (!drawing) throw new Error("无法读取蒙版周边区域");
  drawing.fillStyle = "#808080";
  drawing.fillRect(0, 0, crop.width, crop.height);
  drawing.drawImage(bitmap, left, top, width, height, 0, 0, crop.width, crop.height);
  const [x0, y0, x1, y1] = [((box[0] - left) / width), ((box[1] - top) / height),
    ((box[2] - left) / width), ((box[3] - top) / height)];

  const tiny = document.createElement("canvas");
  tiny.width = tiny.height = 8;
  const sampler = tiny.getContext("2d", { willReadFrequently: true });
  if (!sampler) throw new Error("无法取样蒙版周边区域");
  sampler.drawImage(crop, 0, 0, 8, 8);
  const pixels = sampler.getImageData(0, 0, 8, 8).data;
  const context: number[] = [];
  for (let i = 0; i < 64; i++) {
    const x = i % 8, y = Math.floor(i / 8);
    if ((x + 1) / 8 > x0 && x / 8 < x1 && (y + 1) / 8 > y0 && y / 8 < y1) continue;
    context.push(i, pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]);
  }

  return { context, image: (marked: boolean) => {
    if (marked) {
      drawing.strokeStyle = "#00fafa";
      drawing.lineWidth = 2;
      drawing.strokeRect(x0 * crop.width, y0 * crop.height, (x1 - x0) * crop.width, (y1 - y0) * crop.height);
    }
    return crop.toDataURL("image/png");
  } };
}

export function matchingMosaicPart(box: MosaicBox, context: number[], evidence: readonly TargetEvidence[]): RegionPart | undefined {
  const matches = new Set<RegionPart>();
  for (const candidate of evidence) {
    if (!candidate.direct || candidate.part === "unknown" || candidate.context.length !== context.length ||
        candidate.box.some((value, index) => Math.abs(value - box[index]) > 3)) continue;
    let difference = 0;
    let aligned = true;
    for (let i = 0; i < context.length; i += 4) {
      if (context[i] !== candidate.context[i]) { aligned = false; break; }
      difference += Math.abs(context[i + 1] - candidate.context[i + 1]) +
        Math.abs(context[i + 2] - candidate.context[i + 2]) + Math.abs(context[i + 3] - candidate.context[i + 3]);
    }
    if (aligned && context.length >= 16 && difference / (context.length * .75) <= 4) matches.add(candidate.part);
  }
  return matches.size === 1 ? matches.values().next().value : undefined;
}

function parsePart(value: unknown): RegionPart {
  const result = value as { part?: string; visible_evidence?: boolean } | null;
  if (result?.visible_evidence !== true) return "unknown";
  return result.part === "male_external" || result.part === "female_external" || result.part === "other" ? result.part : "unknown";
}

async function activeTargetModel(): Promise<TargetModel | undefined> {
  try {
    const directory = await mosaicRedrawDirectory();
    const result = await invoke<{ revision: string | null }>("run_style_redraw", {
      directory, image: "", steps: 1, mode: "mosaic-target-status", profile: {}, regions: [], progress: new Channel<string>(),
    });
    if (result.revision) return { directory, revision: result.revision };
  } catch (error) {
    console.warn("无法检查本地部位分类器", error);
  }
}

async function predictPart(model: TargetModel, dataUrl: string, signal: AbortSignal): Promise<RegionPart> {
  try {
    const result = await invoke<{ part?: RegionPart; confidence?: number }>("run_style_redraw", {
      directory: model.directory, image: dataUrl.split(",", 2)[1], steps: 1, mode: "mosaic-target-predict",
      profile: { revision: model.revision }, regions: [], progress: new Channel<string>(),
    });
    signal.throwIfAborted();
    if ((result.confidence ?? 0) >= .9 &&
        (result.part === "male_external" || result.part === "female_external" || result.part === "other")) return result.part;
  } catch (error) {
    signal.throwIfAborted();
    console.warn("本地部位分类器推理失败", error);
  }
  return "unknown";
}

export function createMosaicTargetResolver(root: string, config: MosaicRegionTargeting | undefined,
  rows: SceneRows, getSettings: () => Settings | Promise<Settings>): MosaicTargetResolver | undefined {
  if (!config) return;
  const key = targetKey(root, config);
  let modelPromise: ReturnType<typeof activeTargetModel> | undefined;
  return async (image, source, boxes, signal) => {
    signal.throwIfAborted();
    const model = await (modelPromise ??= activeTargetModel());
    const revision = model ? JSON.stringify([model.directory, model.revision]) : null;
    const cache = cachedTargets(key, revision);
    const current = cache[image.id]?.source === image.sourceHash ? cache[image.id] : undefined;
    const group = rows[image.id]?.source === image.sourceHash ? rows[image.id]?.group : undefined;
    const nearby = group ? Object.entries(cache).flatMap(([id, item]) =>
      id !== image.id && rows[id]?.source === item.source && rows[id]?.group === group &&
      item.size[0] === image.width && item.size[1] === image.height ? item.evidence : []) : [];
    const evidence: TargetEvidence[] = [];
    let bitmap: ImageBitmap | undefined;
    try {
      for (const box of boxes) {
        signal.throwIfAborted();
        const exact = current?.evidence.find(value => value.box.every((n, i) => n === box[i]));
        if (exact && exact.part !== "unknown") { evidence.push(exact); continue; }
        bitmap ??= await createImageBitmap(source);
        const view = regionView(bitmap, box);
        const reused = matchingMosaicPart(box, view.context, nearby);
        if (reused) { evidence.push({ box, part: reused, context: view.context, direct: false }); continue; }
        let part = model ? await predictPart(model, view.image(false), signal) : "unknown";
        if (part !== "unknown") { evidence.push({ box, part, context: view.context, direct: false }); continue; }
        const configuration = await getSettings();
        const markedImage = view.image(true);
        for (const model of new Set([config.model, config.guard])) {
          try {
            part = parsePart(await requestGameModelJson(configuration, model, partPrompt, signal, markedImage,
              "game-images", undefined, { role: "mosaic-target" }));
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof Error) || !("code" in error) || error.code !== "GAME_MODEL_INVALID_JSON") throw error;
          }
          if (part !== "unknown") break;
        }
        evidence.push({ box, part, context: view.context, direct: part !== "unknown" });
      }
    } finally { bitmap?.close(); }
    const latest = cachedTargets(key, revision);
    latest[image.id] = { source: image.sourceHash, size: [image.width, image.height], evidence };
    localStorage.setItem(key, JSON.stringify({ revision, images: latest } satisfies TargetCache));
    const unsupported = evidence.findIndex(item => item.part === "other" || item.part === "unknown");
    if (unsupported >= 0)
      throw new Error("蒙版 " + (unsupported + 1) + (evidence[unsupported].part === "other" ? " · 非目标部位" : " · 部位待确认"));
    const parts = evidence.map(item => item.part as MosaicTargetPart);
    if (new Set(parts).size > 1) throw new Error("同图蒙版部位不同 · 待分开处理");
    return parts;
  };
}
