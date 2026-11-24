import { scanMosaicPixels, sceneSignature } from "./gameMosaicGrid";
import { normalizeMosaicScreening, mosaicZoomRegions, mosaicPresenceProbes, mosaicPresenceProbeEvidence, usesMosaicPresenceProbes, mergeMosaicDetections, mosaicBoxOverlap as overlap,
  type MosaicScreening, type MosaicDetection } from "./gameMosaicScreening";
import { validateMosaicLocalModels, evaCensorIndexes, evaPixels, mrcnnPixels, mrcnnAnchors, mrcnnMetadata, mrcnnDetections, mrcnnResize } from "./gameMosaicCandidateInputs";
import type { MosaicBox, MosaicScan, MosaicDevice } from "./gameMosaic";
export type MosaicDetectorInit = {
  bytes: ArrayBuffer; presenceBytes: ArrayBuffer; labelsBytes?: ArrayBuffer;
  wasmPaths: { mjs: string; wasm: string }; initialScreening?: boolean; screening?: Partial<MosaicScreening>;
};
type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type MosaicDetectorHooks = {
  signal?: AbortSignal; onDevice?: (device: MosaicDevice) => void;
  onInference?: (running: boolean, durationMs?: number) => void; onCacheHit?: () => void;
  createCanvas?: () => Canvas;
};
const threshold = 0.25;
export const mosaicPresenceThreshold = 0.47;

function screeningBounds(image: ImageData): MosaicBox {
  const { width, height, data } = image;
  const full: MosaicBox = [0, 0, width, height];
  if (data[3] >= 64 && data[data.length - 1] >= 64) return full;
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < height; y++) {
    let first = width, last = -1;
    for (let x = 0, i = (y * width) * 4 + 3; x < width; x++, i += 4) {
      if (data[i] >= 64) { first = Math.min(first, x); last = x; }
    }
    if (last < 0) continue;
    left = Math.min(left, first); right = Math.max(right, last + 1);
    top = Math.min(top, y); bottom = y + 1;
  }
  if (right <= left || (right - left) * (bottom - top) >= width * height / 2) return full;
  const margin = Math.max(12, Math.ceil(Math.max(right - left, bottom - top) * 0.05));
  return [Math.max(0, left - margin), Math.max(0, top - margin), Math.min(width, right + margin), Math.min(height, bottom + margin)];
}

// Detection runs on RGB, so validate predictions against the original alpha channel.
export function mosaicVisibleBox(image: ImageData, box: MosaicBox) {
  const [left, top, right, bottom] = box;
  const area = (right - left) * (bottom - top);
  let visible = 0, minX = right, minY = bottom, maxX = left, maxY = top;
  const minimum = [255, 255, 255], maximum = [0, 0, 0];
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset + 3] < 64) continue;
      visible++;
      minX = Math.min(minX,x); minY = Math.min(minY,y); maxX = Math.max(maxX,x+1); maxY = Math.max(maxY,y+1);
      for (let channel = 0; channel < 3; channel++) {
        const value = image.data[offset + channel];
        minimum[channel] = Math.min(minimum[channel], value);
        maximum[channel] = Math.max(maximum[channel], value);
      }
    }
  }
  // Thin sprites can occupy little of their tight box. Reject boxes that extend far beyond their visible content.
  return visible > 0 && (maxX-minX)*(maxY-minY) >= area / 2 && maximum.some((value, channel) => value - minimum[channel] >= 12);
}

export function mosaicBoxes(values: Float32Array, dims: readonly number[], classes: number,
  geometry: { left: number; top: number; scaleX: number; scaleY: number; width: number; height: number }, validBox: (box: MosaicBox, score: number) => boolean = () => true, minimumScore = threshold) {
  if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== 4 + classes + 32 || dims[2] <= 0)
    throw new Error("检测模型需使用原始 YOLO11 分割输出（关闭 NMS 导出）");
  const { left, top, scaleX, scaleY, width, height } = geometry;
  const count = dims[2];
  const candidates: { box: MosaicBox; score: number }[] = [];
  for (let index = 0; index < count; index++) {
    let score = 0;
    for (let c = 0; c < classes; c++) score = Math.max(score, values[(4 + c) * count + index]);
    if (score < minimumScore) continue;
    const x = values[index], y = values[count + index], w = values[count * 2 + index], h = values[count * 3 + index];
    const box: MosaicBox = [
      Math.max(0, Math.floor((x - w / 2 - left) / scaleX)), Math.max(0, Math.floor((y - h / 2 - top) / scaleY)),
      Math.min(width, Math.ceil((x + w / 2 - left) / scaleX)), Math.min(height, Math.ceil((y + h / 2 - top) / scaleY)),
    ];
    if (box[2] > box[0] && box[3] > box[1]) candidates.push({ box, score });
  }
  const boxes: MosaicBox[] = [];
  for (const { box, score } of candidates.sort((a, b) => b.score - a.score)) {
    if (!boxes.some(previous => overlap(previous, box) > 0.45) && validBox(box, score)) boxes.push(box);
  }
  return boxes;
}



export async function createMosaicDetectorRuntime(options: MosaicDetectorInit & MosaicDetectorHooks) {
  const ort = await import("onnxruntime-web/webgpu");
  ort.env.wasm.wasmPaths = options.wasmPaths;
  ort.env.wasm.numThreads = 1;
  const { signal, onDevice, bytes, presenceBytes, labelsBytes } = options;
  const screening = normalizeMosaicScreening(options.screening);
  const presenceThreshold = options.initialScreening ? screening.presenceThreshold : mosaicPresenceThreshold;
  const boxThreshold = options.initialScreening ? screening.boxThreshold : threshold;
  const localModels = options.initialScreening ? screening.localModels : undefined;
  validateMosaicLocalModels(localModels);
  const evaLabels = labelsBytes ? evaCensorIndexes(new TextDecoder().decode(labelsBytes)) : undefined;
  const anchors = localModels?.mrcnn ? mrcnnAnchors() : undefined;
  const canvasElement = () => options.createCanvas?.() ?? new OffscreenCanvas(1, 1);
  const create = (provider: "webgpu" | "wasm") => ort.InferenceSession.create(bytes, { executionProviders: [provider] });
  const createPresence = (provider: "webgpu" | "wasm") => ort.InferenceSession.create(presenceBytes, { executionProviders: [provider] });
  let session: Awaited<ReturnType<typeof create>> | undefined;
  let presenceSession: Awaited<ReturnType<typeof createPresence>> | undefined;
  let device: MosaicDevice = { kind: "gpu" };

  const release = async () => {
    const former = session,formerPresence=presenceSession;
    session = undefined;presenceSession=undefined;
    await former?.release();
    await formerPresence?.release();
  };
  const openCpu = async (reason: string) => {
    signal?.throwIfAborted();
    const cpu = await create("wasm");
    try { presenceSession=await createPresence("wasm"); }
    catch(cause){await cpu.release();throw cause;}
    device = { kind: "cpu", reason };
    return cpu;
  };

  signal?.throwIfAborted();
  const gpu = (globalThis.navigator as (Navigator & { gpu?: unknown }) | undefined)?.gpu;
  if (gpu) {
    try {
      session = await create("webgpu");
      presenceSession=await createPresence("webgpu");
    } catch (cause) {
      await release();
      session = await openCpu("WebGPU 启动失败：" + (cause instanceof Error ? cause.message : String(cause)));
    }
  } else {
    session = await openCpu("当前运行环境不支持 WebGPU");
  }
  if (signal?.aborted) {
    await release();
    signal.throwIfAborted();
  }
  const input = session.inputMetadata[0];
  const output = session.outputMetadata.find(item => item.isTensor && item.shape.length === 3);
  const shape = input?.isTensor ? input.shape : [];
  const size = localModels?.mrcnn ? 1024 : shape[2];
  const channels = localModels?.mrcnn ? 38 : output?.isTensor ? output.shape[1] : undefined;
  if (localModels?.mrcnn && (shape.join(",") !== "1,1024,1024,3" || session.inputNames.length !== 3 ||
      !output?.isTensor || output.shape[2] !== 6)) {
    await release(); throw new Error("请选择 hent-AI 三输入 Mask R-CNN ONNX 模型");
  }
  if ((!localModels?.mrcnn && (shape.length !== 4 || shape[0] !== 1 || shape[1] !== 3 || typeof size !== "number" ||
      size < 256 || size > 1024 || size !== shape[3])) || typeof size !== "number" || typeof channels !== "number" || ![37, 38].includes(channels) || !output) {
    await release();
    throw new Error("请选择固定方形输入、未内置 NMS 的 YOLO11 分割 ONNX");
  }
  const canvas = canvasElement();
  canvas.width = size; canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true }) as Context2D | null;
  if (!context) { await release(); throw new Error("无法读取检测模型输入像素"); }
  onDevice?.(device);
  const outputName = output.name;
  async function runMeasured<T>(work: () => Promise<T>): Promise<T> {
    options.onInference?.(true);
    const started = performance.now();
    try { return await work(); } finally { options.onInference?.(false, performance.now() - started); }
  }
  type Feeds = Record<string, InstanceType<typeof ort.Tensor>>;
  const runSession = (active: NonNullable<typeof session>, feeds: Feeds, output: string) =>
    runMeasured(() => active.run(feeds, [output]));
  const runInference = async (feeds: Feeds) => {
    signal?.throwIfAborted();
    if (!session) throw new Error("检测会话已关闭");
    try {
      return await runSession(session, feeds, outputName);
    } catch (cause) {
      if (device.kind === "cpu") throw cause;
      signal?.throwIfAborted();
      await release();
      session = await openCpu("WebGPU 推理失败：" + (cause instanceof Error ? cause.message : String(cause)));
      signal?.throwIfAborted();
      onDevice?.(device);
      return runSession(session, feeds, outputName);
    }
  };
  let inferenceQueue: Promise<unknown> = Promise.resolve();
  const infer = (feeds: Feeds) => {
    const pending = inferenceQueue.then(() => runInference(feeds));
    inferenceQueue = pending.catch(() => {});
    return pending;
  };
  const runPresence=async(feeds:InstanceType<typeof ort.Tensor>)=>{
    signal?.throwIfAborted();
    if(!presenceSession)throw new Error("分类检测会话已关闭");
    try {return await runSession(presenceSession, { [presenceSession.inputNames[0]]: feeds }, presenceSession.outputNames[0]);}
    catch(cause){
      if(device.kind==="cpu")throw cause;
      signal?.throwIfAborted();await release();
      session=await openCpu("WebGPU 分类推理失败："+String(cause));
      signal?.throwIfAborted();onDevice?.(device);
      return runSession(presenceSession!, { [presenceSession!.inputNames[0]]: feeds }, presenceSession!.outputNames[0]);
    }
  };
  const classify=async(original:Canvas, [x, y, right, bottom]: MosaicBox)=>{
    const resolution = evaLabels ? 448 : 384;
    const canvas=canvasElement();canvas.width=resolution;canvas.height=resolution;
    const ctx=canvas.getContext("2d",{willReadFrequently:true}) as Context2D | null;
    if(!ctx)throw new Error("无法读取分类模型输入");
    ctx.fillStyle="#ffffff";ctx.fillRect(0,0,resolution,resolution);
    if (evaLabels) {
      const scale = Math.min(resolution / (right - x), resolution / (bottom - y));
      const w = Math.round((right - x) * scale), h = Math.round((bottom - y) * scale);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(original,x,y,right-x,bottom-y,Math.floor((resolution-w)/2),Math.floor((resolution-h)/2),w,h);
    } else ctx.drawImage(original,x,y,right-x,bottom-y,0,0,384,384);
    const pixels=ctx.getImageData(0,0,resolution,resolution).data,plane=resolution*resolution,values=evaLabels ? evaPixels(pixels) : new Float32Array(plane*3);
    for(let i=0;!evaLabels&&i<plane;i++){
      values[i]=(pixels[i*4]/255-.5)*2;values[i+plane]=(pixels[i*4+1]/255-.5)*2;values[i+plane*2]=(pixels[i*4+2]/255-.5)*2;
    }
    const feeds=new ort.Tensor("float32",values,evaLabels ? [1,448,448,3] : [1,3,384,384]);
    let tensors:Awaited<ReturnType<typeof runPresence>>|undefined;
    try {
      const pending=inferenceQueue.then(()=>runPresence(feeds));inferenceQueue=pending.catch(()=>{});
      tensors=await pending;
      const result=Object.values(tensors)[0].data;
      if (!(result instanceof Float32Array) || result.length !== (evaLabels?.count ?? 4)) throw new Error("分类模型输出格式无效");
      const score = evaLabels ? Math.max(...evaLabels.indexes.map(index => result[index])) : result[0];
      if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error("分类模型置信度无效");
      return score;
    }finally{feeds.dispose();for(const tensor of Object.values(tensors||{}))tensor.dispose();}
  };
  const scanImage = async (blob: Blob): Promise<MosaicScan> => {
    const source = await createImageBitmap(blob);
    const original = canvasElement();
    original.width = source.width; original.height = source.height;
    const originalContext = original.getContext("2d", { willReadFrequently: true }) as Context2D | null;
    if (!originalContext) { source.close(); throw new Error("无法读取图片像素"); }
    let full: ImageData;
    try {
      originalContext.drawImage(source, 0, 0);
      full = originalContext.getImageData(0, 0, original.width, original.height);
    } finally { source.close(); }
    const signature = sceneSignature(full.data, full.width, full.height);
    let hasVisiblePixel=false,varied=false;
    const minimum=[255,255,255],maximum=[0,0,0];
    for(let i=0;i<full.data.length;i+=4){
      if(full.data[i+3]<64)continue;
      hasVisiblePixel=true;
      for(let channel=0;channel<3;channel++){
        minimum[channel]=Math.min(minimum[channel],full.data[i+channel]);
        maximum[channel]=Math.max(maximum[channel],full.data[i+channel]);
      }
      if(maximum.some((value,channel)=>value-minimum[channel]>=1)){varied=true;break;}
    }
    if(!hasVisiblePixel || !varied)return {signature,boxes:[]};
    const bounds: MosaicBox = options.initialScreening ? screeningBounds(full) : [0, 0, full.width, full.height];
    const [x, y, right, bottom] = bounds;
    const viewWidth = right - x, viewHeight = bottom - y;
    const detect = async ([x, y, right, bottom]: MosaicBox): Promise<MosaicDetection[]> => {
      signal?.throwIfAborted();
      const viewWidth = right - x, viewHeight = bottom - y;
      const layout = localModels?.mrcnn ? mrcnnResize(viewWidth, viewHeight) : undefined;
      const scale = layout?.scale ?? Math.min(size / viewWidth, size / viewHeight);
      const width = layout?.width ?? Math.max(1, Math.round(scale * viewWidth)), height = layout?.height ?? Math.max(1, Math.round(scale * viewHeight));
      const left = layout?.left ?? Math.floor((size - width) / 2), top = layout?.top ?? Math.floor((size - height) / 2);
      context.fillStyle = localModels?.mrcnn ? "#000000" : "#727272";
      context.fillRect(0, 0, size, size);
      context.drawImage(original, x, y, viewWidth, viewHeight, left, top, width, height);
      const { data } = context.getImageData(0, 0, size, size);
      const plane = size * size;
      const values = localModels?.mrcnn ? mrcnnPixels(data) : new Float32Array(3 * plane);
      for (let index = 0; !localModels?.mrcnn && index < plane; index++) {
        values[index] = data[4 * index] / 255;
        values[index + plane] = data[4 * index + 1] / 255;
        values[index + 2 * plane] = data[4 * index + 2] / 255;
      }
      const feeds = new ort.Tensor("float32", values, localModels?.mrcnn ? [1, size, size, 3] : [1, 3, size, size]);
      const geometry = { bounds: [x, y, right, bottom] as MosaicBox, left, top, width, height, scale };
      const meta = anchors ? new ort.Tensor("float32", mrcnnMetadata(geometry), [1, 15]) : undefined;
      const anchorTensor = anchors ? new ort.Tensor("float32", anchors, [1, 261888, 4]) : undefined;
      let tensors: Awaited<ReturnType<typeof infer>> | undefined;
      try {
        tensors = await infer(meta && anchorTensor ? {
          "input_image:0": feeds, "input_image_meta:0": meta, "input_anchors:0": anchorTensor,
        } : { [session!.inputNames[0]]: feeds });
        const result = tensors[outputName], data = result.data;
        if (!(data instanceof Float32Array)) throw new Error("请选择输出为 FP32 的检测 ONNX");
        if (localModels?.mrcnn)
          return mrcnnDetections(data, result.dims, geometry).filter(item => mosaicVisibleBox(full, item.box));
        const yoloGeometry = { left, top, scaleX: width / viewWidth, scaleY: height / viewHeight, width: viewWidth, height: viewHeight };
        const detections: MosaicDetection[] = [];
        mosaicBoxes(data, result.dims, channels - 36, yoloGeometry, (relative, score) => {
          const box: MosaicBox = [relative[0] + x, relative[1] + y, relative[2] + x, relative[3] + y];
          if (!mosaicVisibleBox(full, box)) return false;
          detections.push({ box, score });
          return true;
        }, 0.05);
        return detections;
      } finally {
        feeds.dispose(); meta?.dispose(); anchorTensor?.dispose();
        for (const value of Object.values(tensors || {})) value.dispose();
      }
    };
    const presenceScore = await classify(original, bounds);
    let detections = await detect(bounds);
    if (options.initialScreening) {
      const regions = mosaicZoomRegions(bounds, detections, presenceScore, screening);
      for (const region of regions) detections = mergeMosaicDetections(detections, await detect(region));
    }
    const candidates = detections.map(item => item.box);
    const boxes = detections.filter(item => item.score >= boxThreshold).map(item => item.box);
    const probes = options.initialScreening && usesMosaicPresenceProbes(screening) && !boxes.length
      ? mosaicPresenceProbes(bounds, presenceScore, presenceThreshold, candidates.length > 0) : [];
    const scores: number[] = [];
    for (const probe of probes) scores.push(await classify(original, probe));
    const localEvidence = mosaicPresenceProbeEvidence(scores, presenceScore, presenceThreshold, candidates.length > 0);
    const onOriginal = ([x0, y0, x1, y1]: MosaicBox): MosaicBox => [x0 + x, y0 + y, x1 + x, y1 + y];
    const classifierPositive = presenceScore >= presenceThreshold;
    let reviewBoxes = candidates;
    if (!options.initialScreening || (!boxes.length && (candidates.length || classifierPositive))) {
      const view = viewWidth === full.width && viewHeight === full.height ? full : originalContext.getImageData(x, y, viewWidth, viewHeight);
      const grid = scanMosaicPixels(view.data, viewWidth, viewHeight, signature).boxes.map(onOriginal);
      if (options.initialScreening && !classifierPositive) {
        reviewBoxes = candidates.filter(box => grid.some(tile => overlap(tile, box) > 0.2));
      } else {
        reviewBoxes = [...candidates];
        for (const box of grid)
          if (!reviewBoxes.some(previous => overlap(previous, box) > 0.2)) reviewBoxes.push(box);
      }
    }
    return { signature, boxes, modelBoxes: candidates, reviewBoxes, presenceScore, presenceThreshold, localClear: localEvidence.clear,
      review: boxes.length && !classifierPositive ? "图片分类与区域定位模型存在分歧，请复核"
        : !boxes.length && localEvidence.positive ? "局部补查提示疑似遮挡，请复筛"
        : !boxes.length && (reviewBoxes.length || classifierPositive)
          ? reviewBoxes.length ? "候选区域需要视觉模型复筛确认" : "图片分类提示疑似遮挡，定位模型尚未给出区域"
          : undefined };
  };
  const cache = new Map<string, Promise<MosaicScan>>();
  let reused = 0;
  return {
    release: async () => { cache.clear(); await release(); },
    get reused() { return reused; },
    scan: async (blob: Blob): Promise<MosaicScan> => {
      signal?.throwIfAborted();
      const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      signal?.throwIfAborted();
      const key = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2,"0")).join("");
      const existing = cache.get(key);
      if (existing) {
        const result = await existing;
        reused++;
        options.onCacheHit?.();
        return result;
      }
      const pending = scanImage(blob).catch(cause => { cache.delete(key); throw cause; });
      cache.set(key, pending);
      if (cache.size > 64) cache.delete(cache.keys().next().value!);
      return pending;
    },
  };
}
