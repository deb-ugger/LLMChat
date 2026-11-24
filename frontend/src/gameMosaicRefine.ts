import { loadMosaicDetector, scanMosaic, matchesMosaicDetectorKey, mosaicVisibleBox, mosaicPresenceThreshold, mosaicRefineConcurrency, type MosaicBox, type MosaicScan, type MosaicSettings } from "./gameMosaic";
import type { UnityImage } from "./unityOffline";
import { mosaicInitialScreening, removeContainedMosaicBoxes, type MosaicInitialScreeningSnapshot, type MosaicScreeningSnapshot } from "./gameMosaicStatus";
import { measureGameAsync, measureGameWork, recordGameCacheHit } from "./gameModelPerformance";

export type MosaicReviewRequest = (model: string, prompt: string, image: string, signal: AbortSignal, lanes: number) => Promise<unknown>;
type StoredReview = { source: string; scan: MosaicScan };
type StoredProposal = { source: string; hash: string; scan: MosaicScan };
export type MosaicStoredResult = { source: string; refined?: string; refineError?: string; redrawError?: string; boxes: MosaicBox[];
  checked: boolean; manualChecked?: boolean; scanned?: boolean; detector?: string; reason?: string; review?: string;
  beforeRefine?: MosaicInitialScreeningSnapshot;
  manualBoxes?: boolean; saved?: boolean; refineQuickExcluded?: boolean; discardedHash?: string };
type ReviewCheckpoint = { key: string; images: Record<string, StoredReview>; proposals?: Record<string, StoredProposal> };
const checkpointPath = (root: string) => "llmchat-game-mosaic-refine:" + root;
const regionCheckpointPrefix = (root: string) => checkpointPath(root) + ":regions:";
const mosaicRowsStorageKey = (root: string) => "llmchat-game-mosaic:" + root;
const mosaicEditKey = (root: string) => "llmchat-game-mosaic-edits:" + root;

export function writeMosaicRowEdits<T extends MosaicStoredResult>(root: string, changes: Record<string, T>) {
  const edits = JSON.parse(localStorage.getItem(mosaicEditKey(root)) || "{}") || {};
  localStorage.setItem(mosaicEditKey(root), JSON.stringify(Object.assign(edits, changes)));
}

export function writeMosaicRows(root: string, rows: Record<string, MosaicStoredResult>) {
  localStorage.setItem(mosaicRowsStorageKey(root), JSON.stringify(rows));
  localStorage.removeItem(mosaicEditKey(root));
}

export function clearMosaicRows(root: string) {
  localStorage.removeItem(mosaicRowsStorageKey(root));
  localStorage.removeItem(mosaicEditKey(root));
}

export function readMosaicRows<T extends MosaicStoredResult = MosaicStoredResult>(root: string): Record<string, T> {
  const rows = JSON.parse(localStorage.getItem(mosaicRowsStorageKey(root)) || "{}") || {};
  const edits = localStorage.getItem(mosaicEditKey(root));
  return edits ? Object.assign(rows, JSON.parse(edits)) : rows;
}

export const mosaicErrorUpdateEvent = "llmchat-game-mosaic-error-update";
export type MosaicErrorUpdate = {
  image: Pick<UnityImage, "id" | "sourceHash">;
  change: Partial<Pick<MosaicStoredResult, "scanned" | "reason" | "refineError" | "redrawError">>;
};

export function mergeMosaicErrorUpdates(rows: Record<string, MosaicStoredResult>, updates: readonly MosaicErrorUpdate[]) {
  const next = { ...rows };
  for (const { image, change } of updates) {
    const stored = next[image.id];
    const row = stored?.source === image.sourceHash ? stored : { source: image.sourceHash, boxes: [], checked: true };
    next[image.id] = { ...row, ...change };
  }
  return next;
}

export function persistMosaicErrorUpdates(root: string, updates: readonly MosaicErrorUpdate[]) {
  if (!updates.length) return;
  const rows = mergeMosaicErrorUpdates(readMosaicRows(root), updates);
  writeMosaicRows(root, rows);
  window.dispatchEvent(new CustomEvent(mosaicErrorUpdateEvent, { detail: { root, updates } }));
}

export function savedMosaicScan(row: MosaicStoredResult | undefined, detector: string) {
  if (row?.manualBoxes) return { boxes: row.boxes };
  if (!row || row.reason || row.refineError) return undefined;
  const initial = mosaicInitialScreening(row);
  if (initial.scanned && !initial.reason && matchesMosaicDetectorKey(initial.detector, detector))
    return { boxes: row.boxes, review: row.review, reviewBoxes: row.boxes };
}

export const mosaicReviewPolicy = "visual-review-v6";

export function mosaicReviewKey(settings: MosaicSettings, file?: File) {
  return JSON.stringify([mosaicReviewPolicy, settings.refineModel || "qwen3.5:latest", settings.refineGuardModel || "qwen3-vl:8b-instruct",
    file ? [file.name,file.size,file.lastModified] : "anime-640"]);
}

export function matchesMosaicReviewKey(recorded: string | undefined, key: string) {
  return recorded === key;
}

export function mosaicReviewSeed(initial?: MosaicScreeningSnapshot): MosaicScan | undefined {
  if (!initial?.scanned || initial.reason) return;
  const boxes = [...initial.boxes].sort(([x, y, r, b], [xx, yy, rr, bb]) => x - xx || y - yy || r - rr || b - bb);
  return initial.review
    ? { boxes: [], review: initial.review, reviewBoxes: boxes, signature: [] }
    : { boxes, signature: [] };
}

function readReviewCheckpoint(root: string, key: string): ReviewCheckpoint {
  const value = localStorage.getItem(checkpointPath(root));
  const saved = value ? JSON.parse(value) as ReviewCheckpoint : undefined;
  const checkpoint = saved?.key === key ? saved : { key, images: {} };
  // A checkpoint can be replaced when the review configuration changes.
  // Workbench results keep their original configuration and source identity.
  if (!root.startsWith("benchmark:")) {
    for (const [id, row] of Object.entries(readMosaicRows(root))) {
      if (!matchesMosaicReviewKey(row.refined, key) || row.refineError || row.manualBoxes || row.saved ||
          checkpoint.images[id]?.source === row.source) continue;
      checkpoint.images[id] = { source: row.source, scan: {
        boxes: row.review ? [] : row.boxes, ...(row.review && { review: row.review, reviewBoxes: row.boxes }),
        signature: [], quickExcluded: row.refineQuickExcluded,
      } };
    }
  }
  return checkpoint;
}
export function readMosaicReviews(root: string, key: string): Record<string, StoredReview> {
  return readReviewCheckpoint(root, key).images;
}
export function clearMosaicReviews(root: string, ids?: readonly string[]) {
  const path = checkpointPath(root);
  const prefix = regionCheckpointPrefix(root);
  if (!ids) {
    localStorage.removeItem(path);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) localStorage.removeItem(key);
    }
    return;
  }
  for (const id of ids) localStorage.removeItem(prefix + id);
  const saved = localStorage.getItem(path);
  if (!saved) return;
  const checkpoint = JSON.parse(saved) as ReviewCheckpoint;
  let changed = false;
  for (const id of ids) {
    if (!(id in checkpoint.images) && !checkpoint.proposals?.[id]) continue;
    delete checkpoint.images[id];
    delete checkpoint.proposals?.[id];
    changed = true;
  }
  if (changed) localStorage.setItem(path, JSON.stringify(checkpoint));
}

function intersect(a: MosaicBox, b: MosaicBox) {
  const intersection = Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0])) *
    Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
  return intersection / Math.max(1,(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection);
}
function appendBoxes(destination: MosaicBox[], boxes: MosaicBox[]) {
  for (const box of boxes) if (!destination.some(former=>intersect(former,box)>.45)) destination.push(box);
}
function foreground(image: ImageData): MosaicBox | undefined {
  let left=image.width,top=image.height,right=0,bottom=0;
  for (let y=0;y<image.height;y++) for (let x=0;x<image.width;x++) {
    if (image.data[(y*image.width+x)*4+3]<64) continue;
    left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);
  }
  return right>left && bottom>top ? [left,top,right,bottom] : undefined;
}
function expand(box: MosaicBox, width: number, height: number) : MosaicBox {
  const margin=Math.max(12,Math.round(Math.max(box[2]-box[0],box[3]-box[1])*.3));
  return [Math.max(0,box[0]-margin),Math.max(0,box[1]-margin),Math.min(width,box[2]+margin),Math.min(height,box[3]+margin)];
}
async function imageCanvas(blob: Blob) {
  const bitmap=await createImageBitmap(blob),canvas=document.createElement("canvas");
  canvas.width=bitmap.width;canvas.height=bitmap.height;
  const context=canvas.getContext("2d",{willReadFrequently:true});
  if (!context) {bitmap.close();throw new Error("无法读取复筛图片");}
  try {context.drawImage(bitmap,0,0);} finally {bitmap.close();}
  return {canvas,pixels:context.getImageData(0,0,canvas.width,canvas.height)};
}
const reviewSize = 512;
const reviewConfidence = 0.85;
type RegionReview = { pixelation: boolean; confidence: number; boxes: MosaicBox[] };
type PartialReview = { key: string; source: string; regions: Record<string, RegionReview> };

async function sha256(bytes: BufferSource) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function parseRegionReview(value: unknown): RegionReview {
  const result = value as Partial<RegionReview> | null;
  if (typeof result?.pixelation !== "boolean" || typeof result.confidence !== "number" ||
      // Some constrained decoders emit 1.000000000000001 for the upper boundary.
      !Number.isFinite(result.confidence) || result.confidence < -1e-12 || result.confidence > 1 + 1e-12 ||
      !Array.isArray(result.boxes) || result.boxes.length > 3 || !result.boxes.every(box =>
        Array.isArray(box) && box.length === 4 && box.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1000)))
    throw new Error("复筛模型未返回有效的判断、置信度和坐标数组");
  return { pixelation: result.pixelation, confidence: Math.max(0, Math.min(1, result.confidence)), boxes: result.boxes };
}

function localizedReviewBoxes(values: MosaicBox[], area: MosaicBox, content: MosaicBox, pixels: ImageData, candidate?: MosaicBox): MosaicBox[] {
  const [left, top, right, bottom] = content;
  const scaleX = (area[2] - area[0]) / (right - left);
  const scaleY = (area[3] - area[1]) / (bottom - top);
  const boxes: MosaicBox[] = [];
  for (const value of values) {
    const [x0, y0, x1, y1] = value.map(v => v * reviewSize / 1000);
    const box: MosaicBox = [
      Math.max(area[0], Math.floor(area[0] + (x0 - left) * scaleX)),
      Math.max(area[1], Math.floor(area[1] + (y0 - top) * scaleY)),
      Math.min(area[2], Math.ceil(area[0] + (x1 - left) * scaleX)),
      Math.min(area[3], Math.ceil(area[1] + (y1 - top) * scaleY)),
    ];
    if (x1 <= x0 || y1 <= y0 || box[2] <= box[0] || box[3] <= box[1]) continue;
    if (candidate) {
      const centerX = (box[0] + box[2]) / 2;
      const centerY = (box[1] + box[3]) / 2;
      if (centerX < candidate[0] || centerX >= candidate[2] || centerY < candidate[1] || centerY >= candidate[3]) continue;
    }
    if (mosaicVisibleBox(pixels, box)) boxes.push(box);
  }
  return boxes;
}

function mosaicReviewView(canvas: HTMLCanvasElement, area: MosaicBox) {
  const crop = document.createElement("canvas");
  crop.width = reviewSize;
  crop.height = reviewSize;
  const context = crop.getContext("2d");
  if (!context) throw new Error("无法准备视觉复筛图片");
  const areaWidth = area[2] - area[0], areaHeight = area[3] - area[1];
  const scale = Math.min(reviewSize / areaWidth, reviewSize / areaHeight);
  const width = Math.max(1, Math.round(areaWidth * scale)), height = Math.max(1, Math.round(areaHeight * scale));
  const left = Math.floor((reviewSize - width) / 2), top = Math.floor((reviewSize - height) / 2);
  context.fillStyle = "#727272";
  context.fillRect(0, 0, reviewSize, reviewSize);
  context.imageSmoothingEnabled = false;
  context.drawImage(canvas, area[0], area[1], areaWidth, areaHeight, left, top, width, height);
  const content: MosaicBox = [left, top, left + width, top + height];
  const normalize = (box: MosaicBox) => box.map((coordinate, i) => Math.round(
    (i % 2 ? top + (coordinate - area[1]) * height / areaHeight : left + (coordinate - area[0]) * width / areaWidth) * 1000 / reviewSize
  ));
  return { crop, content, normalize };
}

async function reviewImage(blob: Blob, proposed: MosaicScan, signal: AbortSignal,
  request: (prompt: string, image: string, position: number, total: number, local: boolean) => Promise<RegionReview>): Promise<MosaicScan> {
  const {canvas,pixels}=await imageCanvas(blob),bounds=foreground(pixels);
  if (!bounds) return {boxes:[],signature:proposed.signature};
  const regions: MosaicBox[]=[];
  appendBoxes(regions, proposed.boxes);
  appendBoxes(regions, proposed.modelBoxes || []);
  appendBoxes(regions, proposed.reviewBoxes || []);
  const confirmations: MosaicBox[]=[],uncertain: MosaicBox[]=[];
  const classifierPositive = (proposed.presenceScore ?? 0) >= (proposed.presenceThreshold ?? mosaicPresenceThreshold);
  let unlocalizedReview: string | undefined;
  let firstFailure: Error | undefined;
  const views: (MosaicBox | undefined)[]=regions.length?regions:[undefined];
  for (const [index, candidate] of views.entries()) {
    signal.throwIfAborted();
    const area=expand(candidate || bounds,canvas.width,canvas.height);
    const { crop, content, normalize } = mosaicReviewView(canvas, area);
    const region = candidate && normalize(candidate);
    const prompt = (region ? `只判断所给候选框 [${region.join(",")}] 内是否有遮挡，框外像素只供参考。` : "检查图中是否有遮挡。") +
      '识别人为叠加的成片马赛克或不透明遮挡条。自然纹理、轮廓线、高光、透明背景和灰色填充不是遮挡。' +
      '只返回 JSON {"pixelation":true或false,"boxes":[[x0,y0,x1,y1]],"confidence":0到1}。坐标按整张输入图（含填充）归一化到0到1000。' +
      '有遮挡时最多返回3个贴合遮挡的框，无法准确定位或没有遮挡时 boxes 为 []。';
    let response: RegionReview;
    try {
      response = await request(prompt, crop.toDataURL("image/png"), index + 1, views.length, !!candidate);
    } catch (cause) {
      signal.throwIfAborted();
      firstFailure ??= new Error(`候选区域 ${index + 1}/${views.length} · ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }

    const confident = response.confidence >= reviewConfidence;
    if (!response.pixelation) {
      // Keep conflicting negatives when both the detector and image classifier support a candidate.
      if (candidate && (!confident || (classifierPositive && proposed.boxes.some(box => intersect(box, candidate) > .45)))) {
        uncertain.push(candidate);
      } else if (!candidate && !confident && classifierPositive) {
        unlocalizedReview = "初筛提示疑似遮挡，复筛否定的置信度不足";
      }
      continue;
    }
    const boxes = localizedReviewBoxes(response.boxes, area, content, pixels, candidate);
    if (!boxes.length) {
      if (candidate) uncertain.push(candidate);
      else unlocalizedReview = "视觉模型判为疑似遮挡，但未给出有效区域，请人工检查";
      continue;
    }
    appendBoxes(confident ? confirmations : uncertain, boxes);
  }
  if (firstFailure) throw firstFailure;
  if (unlocalizedReview || uncertain.some(box => !confirmations.some(confirmed => intersect(box, confirmed) > .45)))
    return {boxes:removeContainedMosaicBoxes(confirmations),reviewBoxes:removeContainedMosaicBoxes([...confirmations,...uncertain]),signature:proposed.signature,
      review:unlocalizedReview || "复筛结果存在分歧、置信度不足或定位无效，请人工检查候选区域"};
  return {boxes:removeContainedMosaicBoxes(confirmations),signature:proposed.signature};
}

export async function reviewMosaicScreen(source: Blob, initial: MosaicScan, signal: AbortSignal,
  request: (prompt: string, image: string) => Promise<unknown>) {
  const visual = await reviewImage(source, initial, signal, async (prompt, image) => parseRegionReview(await request(prompt, image)));
  return visual.boxes.length || visual.review ? visual : initial;
}

async function reviewMosaicCandidates(blob: Blob, proposed: MosaicScan, signal: AbortSignal,
  request: (prompt: string, image: string, detail: string) => Promise<RegionReview>): Promise<MosaicScan> {
  const { canvas, pixels } = await imageCanvas(blob);
  const bounds = foreground(pixels);
  const signature = proposed.signature;
  if (!bounds) return { boxes: [], signature };

  // Only an initial positive with a localized detector box supplies independent confirmation.
  const strong = proposed.review ? [] : removeContainedMosaicBoxes(proposed.boxes);
  const regions: MosaicBox[] = [];
  appendBoxes(regions, strong);
  appendBoxes(regions, proposed.boxes);
  appendBoxes(regions, proposed.reviewBoxes ?? []);
  const focus = regions.slice(0, 3);
  const deferred = regions.slice(focus.length);
  const areaSize = ([x, y, right, bottom]: MosaicBox) => (right - x) * (bottom - y);
  const enclosing = (boxes: MosaicBox[]): MosaicBox => boxes.reduce(([x, y, right, bottom], box) => [
    Math.min(x, box[0]), Math.min(y, box[1]), Math.max(right, box[2]), Math.max(bottom, box[3]),
  ], boxes[0]);
  const area = expand(focus.length ? enclosing(focus) : bounds, pixels.width, pixels.height);
  const inspect = async (view: MosaicBox, candidates: MosaicBox[], detail: string) => {
    signal.throwIfAborted();
    const { crop, content, normalize } = mosaicReviewView(canvas, view);
    const instruction = candidates.length
      ? "逐一核对以下候选区域，框外仅供参考：" + JSON.stringify(candidates.map(normalize)) + "。"
      : "检查图中是否有遮挡。";
    const prompt = instruction + "只报告有直接像素证据的人为马赛克或不透明遮挡条。自然纹理、轮廓线、高光和透明背景都不算遮挡。" +
      '只返回 JSON {"pixelation":true或false,"boxes":[[x0,y0,x1,y1]],"confidence":0到1}。' +
      "最多返回3个贴合遮挡的框，坐标按整张输入（含填充）归一化为0到1000。无法定位时返回空框。";
    const response = await request(prompt, crop.toDataURL("image/png"), detail);
    const boxes = response.pixelation ? localizedReviewBoxes(response.boxes, view, content, pixels) : [];
    return { response, boxes };
  };

  const confirmed: MosaicBox[] = [];
  const uncertain: MosaicBox[] = [...deferred];
  const supports = (a: MosaicBox, b: MosaicBox) => intersect(a, b) >= .5;
  const hasConfirmation = (box: MosaicBox) => confirmed.some(other => supports(other, box));
  const record = ({ response, boxes }: Awaited<ReturnType<typeof inspect>>, candidates: MosaicBox[]) => {
    for (const box of boxes) {
      const supported = strong.some(candidate => candidates.includes(candidate) && supports(candidate, box));
      appendBoxes(response.confidence >= reviewConfidence && supported ? confirmed : uncertain, [box]);
    }
  };

  const first = await inspect(area, focus, focus.length ? "合并复核 · " + focus.length + " 个候选" : "整图复核");
  record(first, focus);

  // A closer crop can resolve a strong box lost in a wide, multi-candidate view.
  const retry = first.response.pixelation && focus.find(box => strong.includes(box) && !hasConfirmation(box));
  if (retry) {
    const closer = expand(retry, pixels.width, pixels.height);
    if (areaSize(closer) < areaSize(area) * .7) {
      const second = await inspect(closer, [retry], "局部补定位");
      record(second, [retry]);
      if (hasConfirmation(retry)) {
        const weak = uncertain.filter(box => !supports(box, retry));
        uncertain.splice(0, uncertain.length, ...weak);
      }
    }
  }

  const missingLocation = first.response.pixelation && !first.boxes.length && !confirmed.length;
  for (const box of focus) {
    if (strong.includes(box) || first.response.pixelation || first.response.confidence < reviewConfidence) {
      if (!hasConfirmation(box)) appendBoxes(uncertain, [box]);
    }
  }
  const review = missingLocation || uncertain.some(box => !hasConfirmation(box)) ||
    (!focus.length && !!proposed.review && first.response.confidence < reviewConfidence);
  const boxes = removeContainedMosaicBoxes(confirmed);
  return review ? { boxes, signature, reviewBoxes: removeContainedMosaicBoxes([...confirmed, ...uncertain]),
    review: "复筛证据不足或候选区域存在分歧，请人工复核" } : { boxes, signature };
}

export async function refineMosaicBatch(images: readonly UnityImage[], options: {
  root: string; settings: MosaicSettings; signal: AbortSignal; modelFile?: File;
  read: (image:UnityImage,signal:AbortSignal)=>Promise<Blob>;
  prepare?: (images:readonly UnityImage[],signal:AbortSignal)=>Promise<Record<string, string>>;
  request: MosaicReviewRequest; restart?: boolean; timingScope?: string;
  prepareRequest?: (model: string, lanes: number) => Promise<void>;
  initialScreening?: (image: UnityImage) => MosaicScreeningSnapshot | undefined;
  onResult?: (image:UnityImage,scan:MosaicScan)=>void; onError?: (image:UnityImage,error:string)=>void;
  onProgress?: (completed:number,detail:string)=>void;
  onPreparation?: (prepared: number, total: number) => void;
}) {
  const {signal,settings}=options,key=mosaicReviewKey(settings,options.modelFile);
  signal.throwIfAborted();
  const checkpoint = readReviewCheckpoint(options.root, key);
  const savedProposals = checkpoint.proposals ??= {};
  const regionPrefix = regionCheckpointPrefix(options.root);
  const partialKey = key;
  const saveCheckpoint = () => measureGameWork(options.timingScope, "saveMs", () =>
    localStorage.setItem(checkpointPath(options.root), JSON.stringify(checkpoint)));
  if (options.restart) {
    for (const image of images) {
      delete checkpoint.images[image.id];
      delete savedProposals[image.id];
      localStorage.removeItem(regionPrefix + image.id);
    }
    saveCheckpoint();
  }
  const fullReview = settings.refineScope === "all" || settings.refineScope === "selected";
  const completedReview = (image: UnityImage) => {
    const record = checkpoint.images[image.id];
    return record?.source === image.sourceHash && (!fullReview || !record.scan.quickExcluded) ? record.scan : undefined;
  };
  const results = new Map<string, MosaicScan>(), prepared = new Map<string, StoredProposal>();
  const proposalCache = new Map<string, MosaicScan>();
  const errors = new Map<string, string>();
  const remaining: UnityImage[] = [];
  const projectRows = options.initialScreening ? undefined : readMosaicRows(options.root);
  const initialScreening = options.initialScreening ?? ((image: UnityImage) => {
    const row = projectRows?.[image.id];
    return row?.source === image.sourceHash ? mosaicInitialScreening(row) : undefined;
  });
  for (const image of images) {
    const scan = completedReview(image);
    if (scan) {
      results.set(image.id, scan);
      options.onResult?.(image, scan);
      continue;
    }
    const record = savedProposals[image.id];
    if (record?.source === image.sourceHash) {
      prepared.set(image.id, record);
    } else {
      const scan = mosaicReviewSeed(initialScreening(image));
      if (scan && (!scan.review || scan.reviewBoxes?.length)) {
        prepared.set(image.id, { source: image.sourceHash, hash: image.sourceHash, scan });
        recordGameCacheHit(options.timingScope);
      } else {
        remaining.push(image);
      }
    }
  }
  let preparedThisRun = 0, unsaved = 0, failed = 0;
  const reportPreparation = () => {
    const count = images.length - remaining.length + preparedThisRun;
    options.onPreparation?.(count, images.length);
    options.onProgress?.(results.size, "候选区域准备 · " + count + "/" + images.length + " 张");
  };
  let detector: Awaited<ReturnType<typeof loadMosaicDetector>> | undefined;
  reportPreparation();
  try {
    const batchSize = 16;
    for (let offset = 0; offset < remaining.length; offset += batchSize) {
      signal.throwIfAborted();
      const batch = remaining.slice(offset, offset + batchSize);
      let prepareErrors: Record<string, string> | undefined;
      try {
        const prepare = options.prepare;
        if (prepare) prepareErrors = await measureGameAsync(options.timingScope, "processingMs", () => prepare(batch, signal));
      } catch (cause) {
        signal.throwIfAborted();
        for (const image of batch) errors.set(image.id, String(cause));
      }
      for (const image of batch) {
        signal.throwIfAborted();
        try {
          const failure = errors.get(image.id) ?? prepareErrors?.[image.id];
          if (failure) throw new Error(failure);
          const blob = await measureGameAsync(options.timingScope, "processingMs", () => options.read(image, signal));
          const hash = await sha256(await blob.arrayBuffer());
          let scan = proposalCache.get(hash);
          if (!scan) {
            if (settings.detector === "grid") {
              scan = await measureGameAsync(options.timingScope, "detectorMs", () => scanMosaic(blob));
            } else {
              detector ??= await loadMosaicDetector(options.modelFile, { signal, timingScope: options.timingScope,
                initialScreening: true, screening: settings.screening, maxConcurrency: 1 });
              scan = await detector.scan(blob);
            }
            proposalCache.set(hash, scan);
            if (proposalCache.size > 64) proposalCache.delete(proposalCache.keys().next().value!);
          }
          const seed = mosaicReviewSeed(initialScreening(image));
          const proposal = seed?.review
            ? { ...seed, reviewBoxes: scan.boxes.length ? scan.boxes : scan.reviewBoxes }
            : scan;
          const record = { source: image.sourceHash, hash, scan: { ...proposal, signature: [] } };
          savedProposals[image.id] = record;
          prepared.set(image.id, record);
          unsaved++;
          preparedThisRun++;
          reportPreparation();
        } catch (cause) {
          signal.throwIfAborted();
          errors.set(image.id, cause instanceof Error ? cause.message : String(cause));
        }
      }
      if (unsaved) { saveCheckpoint(); unsaved = 0; }
    }
  } finally {
    try { if (unsaved) saveCheckpoint(); }
    finally { await detector?.release(); }
  }
  const requests = new Map<string, Promise<RegionReview>>();
  const partialReviews = new Map<string, PartialReview>();
  for (const image of images) {
    const path = regionPrefix + image.id;
    const value = localStorage.getItem(path);
    if (!value) continue;
    const saved = JSON.parse(value) as PartialReview;
    if (results.has(image.id) || saved.key !== partialKey || saved.source !== image.sourceHash) {
      localStorage.removeItem(path);
      continue;
    }
    partialReviews.set(image.id, saved);
    for (const [id, response] of Object.entries(saved.regions)) requests.set(id, Promise.resolve(response));
  }
  let cursor=0;
  const groups=new Map<string,UnityImage[]>();
  for(const image of images) {
    if (results.has(image.id)) continue;
    const proposed = prepared.get(image.id)?.scan;
    const learned = !proposed?.review && proposed?.boxes.length;
    const model=learned ? settings.refineModel || "qwen3.5:latest" : settings.refineGuardModel || "qwen3-vl:8b-instruct";
    const group=groups.get(model);
    if(group)group.push(image);else groups.set(model,[image]);
  }
  const lane=async(model:string,batch:UnityImage[],lanes:number,prepareRequest:()=>Promise<void>)=>{
    while(cursor<batch.length) {
      signal.throwIfAborted();const image=batch[cursor++];
      try {
        const failure=errors.get(image.id);if(failure)throw new Error(failure);
        const { scan: proposed } = prepared.get(image.id)!;
        const hasCandidates = !!(proposed.boxes.length || proposed.modelBoxes?.length || proposed.reviewBoxes?.length || proposed.review);
        const scan = !fullReview && !hasCandidates
          ? { boxes: [], signature: proposed.signature, quickExcluded: true }
          : await reviewMosaicCandidates(await measureGameAsync(options.timingScope, "processingMs", () => options.read(image, signal)),
            proposed, signal, async (prompt, crop, detail) => {
              const id = await sha256(new TextEncoder().encode(JSON.stringify([model, prompt, crop])));
              signal.throwIfAborted();
              let pending = requests.get(id);
              const reused = !!pending;
              if (!pending) {
                options.onProgress?.(results.size, model + " · " + image.name + " · " + detail + " · 等待模型返回");
                pending = prepareRequest().then(() => {
                  signal.throwIfAborted();
                  return options.request(model, prompt, crop, signal, lanes);
                }).then(parseRegionReview);
                requests.set(id, pending);
              }
              const response = await pending;
              if (reused) recordGameCacheHit(options.timingScope);
              const partial = partialReviews.get(image.id) ?? { key: partialKey, source: image.sourceHash, regions: {} };
              if (!partial.regions[id]) {
                partial.regions[id] = response;
                measureGameWork(options.timingScope, "saveMs", () =>
                  localStorage.setItem(regionPrefix + image.id, JSON.stringify(partial)));
                partialReviews.set(image.id, partial);
              }
              return response;
            });
        checkpoint.images[image.id] = { source: image.sourceHash, scan: { ...scan, signature: [] } };
        delete savedProposals[image.id];
        saveCheckpoint();
        if (partialReviews.delete(image.id)) localStorage.removeItem(regionPrefix + image.id);
        results.set(image.id,scan);options.onResult?.(image,scan);
        options.onProgress?.(results.size,model+" · "+image.name);
      } catch(cause) {
        if(signal.aborted)throw cause;
        failed++;
        options.onError?.(image, String(cause));
        options.onProgress?.(results.size, "复筛失败 · " + image.name);
      }
    }
  };
  for(const [model,batch] of groups) {
    cursor=0;
    const lanes = Math.min(batch.length, mosaicRefineConcurrency(settings.refineConcurrency));
    let ready: Promise<void> | undefined;
    const prepareRequest = () => ready ??= Promise.resolve().then(() => options.prepareRequest?.(model, lanes));
    const settled = await Promise.allSettled(Array.from({ length: lanes }, () => lane(model, batch, lanes, prepareRequest)));
    for(const item of settled)if(item.status==="rejected")throw item.reason;
  }
  return {results,failed};
}
