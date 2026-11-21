import { loadMosaicDetector, mosaicVisibleBox, mosaicPresenceThreshold, type MosaicBox, type MosaicScan, type MosaicSettings } from "./gameMosaic";
import type { UnityImage } from "./unityOffline";

export type MosaicReviewRequest = (model: string, prompt: string, image: string, signal: AbortSignal) => Promise<unknown>;
type StoredReview = { source: string; scan: MosaicScan };
type StoredProposal = { source: string; hash: string; scan: MosaicScan };
type ReviewCheckpoint = { key: string; images: Record<string, StoredReview>; proposals?: Record<string, StoredProposal> };
const checkpointPath = (root: string) => "llmchat-game-mosaic-refine:" + root;

export function mosaicReviewKey(settings: MosaicSettings, file?: File) {
  return JSON.stringify(["visual-review-v4", settings.refineModel || "qwen3.5:latest", settings.refineGuardModel || "qwen3-vl:8b-instruct",
    file ? [file.name,file.size,file.lastModified] : "anime-640"]);
}
function readReviewCheckpoint(root: string, key: string): ReviewCheckpoint {
  const value = localStorage.getItem(checkpointPath(root));
  if (value) {
    const saved = JSON.parse(value) as ReviewCheckpoint;
    if (saved.key === key) return saved;
  }
  return { key, images: {} };
}
export function readMosaicReviews(root: string, key: string): Record<string, StoredReview> {
  return readReviewCheckpoint(root, key).images;
}
export function clearMosaicReviews(root: string) {
  localStorage.removeItem(checkpointPath(root));
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
function png(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error("无法准备复筛区域")),"image/png"));
}

async function proposals(blob: Blob, detector: Awaited<ReturnType<typeof loadMosaicDetector>>, signal: AbortSignal): Promise<MosaicScan> {
  const result=await detector.scan(blob);
  const {canvas,pixels}=await imageCanvas(blob),bounds=foreground(pixels);
  if (!bounds) return result;
  const regions: MosaicBox[]=[];
  const area=(bounds[2]-bounds[0])*(bounds[3]-bounds[1]);
  if (area<canvas.width*canvas.height*.5) regions.push(expand(bounds,canvas.width,canvas.height));
  else if (!result.boxes.length && Math.max(canvas.width,canvas.height)>320) {
    const side=Math.min(Math.min(canvas.width,canvas.height),Math.ceil(Math.max(canvas.width,canvas.height)*.6));
    for (const x of new Set([0,canvas.width-side])) for (const y of new Set([0,canvas.height-side]))
      regions.push([x,y,x+side,y+side]);
  }
  let presenceScore=result.presenceScore || 0;
  const boxes=[...result.boxes],modelBoxes=[...(result.modelBoxes || [])],reviewBoxes=[...(result.reviewBoxes || [])];
  for (const [left,top,right,bottom] of regions) {
    signal.throwIfAborted();
    const crop=document.createElement("canvas");crop.width=right-left;crop.height=bottom-top;
    const context=crop.getContext("2d");
    if (!context) throw new Error("无法准备局部放大复筛");
    context.drawImage(canvas,left,top,crop.width,crop.height,0,0,crop.width,crop.height);
    const local=await detector.scan(await png(crop));
    presenceScore=Math.max(presenceScore,local.presenceScore || 0);
    const mapped=(values: MosaicBox[] = [])=>values.map(([x0,y0,x1,y1]):MosaicBox=>[left+x0,top+y0,left+x1,top+y1]);
    appendBoxes(boxes,mapped(local.boxes));appendBoxes(modelBoxes,mapped(local.modelBoxes));appendBoxes(reviewBoxes,mapped(local.reviewBoxes));
  }
  return {...result,boxes,modelBoxes,reviewBoxes,presenceScore,review:!boxes.length&&(reviewBoxes.length||presenceScore>=mosaicPresenceThreshold)?"候选区域需要视觉模型复筛确认":undefined};
}

async function reviewImage(blob: Blob, proposed: MosaicScan, model: string, request: MosaicReviewRequest, signal: AbortSignal): Promise<MosaicScan> {
  const {canvas,pixels}=await imageCanvas(blob),bounds=foreground(pixels);
  if (!bounds) return {boxes:[],signature:proposed.signature};
  const regions: MosaicBox[]=[];
  appendBoxes(regions,proposed.modelBoxes || []);
  appendBoxes(regions,proposed.reviewBoxes || []);
  const confirmations: MosaicBox[]=[],uncertain: MosaicBox[]=[];
  const views: (MosaicBox | undefined)[]=regions.length?regions:[undefined];
  for (const candidate of views) {
    signal.throwIfAborted();
    const area=expand(candidate || bounds,canvas.width,canvas.height);
    const crop=document.createElement("canvas");crop.width=512;crop.height=512;
    const context=crop.getContext("2d");if (!context) throw new Error("无法准备视觉复筛图片");
    const scale=Math.min(512/(area[2]-area[0]),512/(area[3]-area[1]));
    const width=Math.round((area[2]-area[0])*scale),height=Math.round((area[3]-area[1])*scale);
    const left=Math.floor((512-width)/2),top=Math.floor((512-height)/2);
    context.fillStyle="#727272";context.fillRect(0,0,512,512);context.imageSmoothingEnabled=false;
    context.drawImage(canvas,area[0],area[1],area[2]-area[0],area[3]-area[1],left,top,width,height);
    const prompt=candidate
      ? '检查这张局部图是否有真正的像素化遮挡（马赛克）或黑白遮挡条。透明背景、普通色块、线稿和自然纹理不算。只判断候选区域，不要枚举小方格。只返回JSON {"pixelation":true或false,"confidence":0到1}，不要描述人物或场景。'
      : '检查图片是否有真正的像素化遮挡（马赛克）或黑白遮挡条。透明背景、普通色块、线稿和自然纹理不算。只返回JSON {"pixelation":true或false,"boxes":[[x0,y0,x1,y1]],"confidence":0到1}，坐标为0到1000归一化，最多返回3个整体区域框，不要枚举小方格，不要描述人物或场景。';
    const response=await request(model,prompt,crop.toDataURL("image/png"),signal) as Record<string,unknown>;
    if (typeof response?.pixelation!=="boolean" || typeof response.confidence!=="number" ||
        response.confidence<0 || response.confidence>1) throw new Error("复筛模型未返回有效的判断和置信度");
    if (!response.pixelation) {
      // A negative VLM result cannot silently discard conflicting learned detections.
      if (candidate && (proposed.modelBoxes || []).some(box=>intersect(box,candidate)>.2)) uncertain.push(candidate);
      continue;
    }
    const found: MosaicBox[]=[];
    if (candidate) found.push(candidate);
    else if (Array.isArray(response.boxes)) for (const value of response.boxes) {
      if (!Array.isArray(value) || value.length!==4 || !value.every(v=>typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=1000)) continue;
      const [x0,y0,x1,y1]=value as number[];
      const box:MosaicBox=[Math.max(0,Math.floor(area[0]+(x0*.512-left)/scale)),
        Math.max(0,Math.floor(area[1]+(y0*.512-top)/scale)),Math.min(canvas.width,Math.ceil(area[0]+(x1*.512-left)/scale)),
        Math.min(canvas.height,Math.ceil(area[1]+(y1*.512-top)/scale))];
      if (box[2]>box[0] && box[3]>box[1] && mosaicVisibleBox(pixels,box)) found.push(box);
    }
    if (!found.length) return {...proposed,boxes:[],review:"视觉模型判为疑似遮挡，但未给出有效区域，请人工检查"};
    appendBoxes(response.confidence>=.85?confirmations:uncertain,found);
  }
  if (uncertain.some(box=>!confirmations.some(confirmed=>intersect(box,confirmed)>.45)))
    return {boxes:confirmations,reviewBoxes:[...confirmations,...uncertain],signature:proposed.signature,review:"复筛结果存在分歧或置信度不足，请人工检查候选区域"};
  return {boxes:confirmations,signature:proposed.signature};
}

export async function refineMosaicBatch(images: readonly UnityImage[], options: {
  root: string; settings: MosaicSettings; signal: AbortSignal; modelFile?: File;
  read: (image:UnityImage,signal:AbortSignal)=>Promise<Blob>;
  prepare?: (images:readonly UnityImage[],signal:AbortSignal)=>Promise<Record<string, string>>;
  request: MosaicReviewRequest; restart?: boolean;
  onResult?: (image:UnityImage,scan:MosaicScan)=>void; onError?: (image:UnityImage,error:string)=>void;
  onProgress?: (completed:number,detail:string)=>void;
  onPreparation?: (prepared: number, total: number) => void;
}) {
  const {signal,settings}=options,key=mosaicReviewKey(settings,options.modelFile);
  signal.throwIfAborted();
  const checkpoint = readReviewCheckpoint(options.root, key);
  const savedProposals = checkpoint.proposals ??= {};
  const saveCheckpoint = () => localStorage.setItem(checkpointPath(options.root), JSON.stringify(checkpoint));
  if (options.restart) {
    for (const image of images) {
      delete checkpoint.images[image.id];
      delete savedProposals[image.id];
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
  for (const image of images) {
    if (completedReview(image)) continue;
    const record = savedProposals[image.id];
    if (record?.source === image.sourceHash) prepared.set(image.id, record);
    else remaining.push(image);
  }
  let preparedThisRun = 0, unsaved = 0, failed = 0;
  const reportPreparation = () => {
    const count = images.length - remaining.length + preparedThisRun;
    options.onPreparation?.(count, images.length);
    options.onProgress?.(0, "候选区域准备 · " + count + "/" + images.length + " 张");
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
        prepareErrors = await options.prepare?.(batch, signal);
      } catch (cause) {
        signal.throwIfAborted();
        for (const image of batch) errors.set(image.id, String(cause));
      }
      for (const image of batch) {
        signal.throwIfAborted();
        try {
          const failure = errors.get(image.id) ?? prepareErrors?.[image.id];
          if (failure) throw new Error(failure);
          const blob = await options.read(image, signal);
          const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
          const hash = Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, "0")).join("");
          let scan = proposalCache.get(hash);
          if (!scan) {
            detector ??= await loadMosaicDetector(options.modelFile, { signal });
            scan = await proposals(blob, detector, signal);
            proposalCache.set(hash, scan);
            if (proposalCache.size > 64) proposalCache.delete(proposalCache.keys().next().value!);
          }
          const record = { source: image.sourceHash, hash, scan: { ...scan, signature: [] } };
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
  const verified=new Map<string,Promise<MosaicScan>>();
  let cursor=0,completed=0;
  const groups=new Map<string,UnityImage[]>();
  for(const image of images) {
    const learned=prepared.get(image.id)?.scan.modelBoxes?.length;
    const model=learned ? settings.refineModel || "qwen3.5:latest" : settings.refineGuardModel || "qwen3-vl:8b-instruct";
    const group=groups.get(model);
    if(group)group.push(image);else groups.set(model,[image]);
  }
  const lane=async(model:string,batch:UnityImage[])=>{
    while(cursor<batch.length) {
      signal.throwIfAborted();const image=batch[cursor++];
      try {
        const failure=errors.get(image.id);if(failure)throw new Error(failure);
        let scan=completedReview(image);
        if(!scan) {
          const { hash, scan: proposed } = prepared.get(image.id)!;
          const identity = JSON.stringify([model, hash]);
          let pending=verified.get(identity);
          if(!pending) {
            const hasCandidates=!!(proposed.boxes.length || proposed.modelBoxes?.length || proposed.reviewBoxes?.length || proposed.review);
            pending=!fullReview && !hasCandidates
              ? Promise.resolve({boxes:[],signature:proposed.signature,quickExcluded:true} as MosaicScan)
              : options.read(image,signal).then(blob=>reviewImage(blob,proposed,model,options.request,signal));
            verified.set(identity,pending);
            if(verified.size>128)verified.delete(verified.keys().next().value!);
            void pending.catch(() => { if (verified.get(identity) === pending) verified.delete(identity); });
          }
          scan=await pending;
          checkpoint.images[image.id] = { source: image.sourceHash, scan: { ...scan, signature: [] } };
          delete savedProposals[image.id];
          saveCheckpoint();
        }
        results.set(image.id,scan);options.onResult?.(image,scan);
        options.onProgress?.(++completed,model+" · "+image.name);
      } catch(cause) {
        if(signal.aborted)throw cause;
        failed++;options.onError?.(image,String(cause));
      }
    }
  };
  for(const [model,batch] of groups) {
    cursor=0;
    const lanes=Math.min(batch.length,Math.max(1,Math.min(2,settings.refineConcurrency ?? 1)));
    const settled=await Promise.allSettled(Array.from({length:lanes},()=>lane(model,batch)));
    for(const item of settled)if(item.status==="rejected")throw item.reason;
  }
  return {results,failed};
}
