import { ImageRecognitionCache } from "../imageRecognitionCache";
import type {
  InitializationSummary,
  OcrResultItem,
} from "@paddleocr/paddleocr-js";
import { API_BASE, api, type OcrMode } from "../api";
import { OcrRuntime } from "./runtime";
import { runtimeAssetBase } from "../runtimeAssets";

type ModelPair = {
  detName: string;
  detUrl: string;
  recName: string;
  recUrl: string;
};

function localAssetUrl(path: string): string {
  return new URL(path, runtimeAssetBase()).href;
}

function backendModelUrl(fileName: string): string {
  return `${API_BASE}/api/ocr/model-files/${encodeURIComponent(fileName)}`;
}

export { normalizeOcrMode, OCR_MODE_LABELS } from "./modes";

function modelPair(mode: OcrMode): ModelPair {
  const detName = mode === "fast" ? "PP-OCRv6_small_det" : "PP-OCRv6_medium_det";
  // Manga OCR replaces proposal text, so its Paddle stage uses the bundled recognizer.
  const recName = mode === "precise"
    ? "PP-OCRv6_medium_rec"
    : mode === "english" ? "en_PP-OCRv5_mobile_rec" : "PP-OCRv6_small_rec";
  const assetUrl = (name: string, bundled: boolean) => {
    const file = `${name}_onnx_infer.tar`;
    return bundled ? localAssetUrl(`./ocr/${file}`) : backendModelUrl(file);
  };
  return {
    detName,
    detUrl: assetUrl(detName, mode === "fast"),
    recName,
    recUrl: assetUrl(recName, mode === "fast" || mode === "manga"),
  };
}

export type PaddleOcrLine = {
  text: string;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type PaddleOcrRecognition = {
  profile?:string;
  detectedBoxes: number;
  lines: PaddleOcrLine[];
  image: { width: number; height: number };
  initialization: InitializationSummary | null;
  elapsedMs: number;
};

type PaddleOcrModule = typeof import("@paddleocr/paddleocr-js");
type PaddleOcrInstance = Awaited<
  ReturnType<PaddleOcrModule["PaddleOCR"]["create"]>
>;

function itemToLine(item: OcrResultItem, coordinateScale = 1): PaddleOcrLine | null {
  const text = item.text.trim().replace(/\s+/g, " ");
  if (!text || item.poly.length === 0) return null;
  const xs = item.poly.map((point) => point[0]);
  const ys = item.poly.map((point) => point[1]);
  const x0 = Math.min(...xs) / coordinateScale;
  const y0 = Math.min(...ys) / coordinateScale;
  const x1 = Math.max(...xs) / coordinateScale;
  const y1 = Math.max(...ys) / coordinateScale;
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) {
    return null;
  }
  return {
    text,
    confidence: Math.max(0, Math.min(100, item.score * 100)),
    x0,
    y0,
    x1,
    y1,
  };
}

/**
 * Small screenshots often contain labels whose glyphs are only 10-15 px high.
 * Upscaling before detection gives the detector enough pixels for subscripts and
 * diagram labels, while returned coordinates are converted back to source size.
 */
async function prepareRecognitionImage(
  image: Blob,
): Promise<{ image: Blob | ImageBitmap; scale: number }> {
  if (typeof createImageBitmap !== "function") return { image, scale: 1 };
  const bitmap = await createImageBitmap(image);
  try {
    const maxSide = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(2, 2400 / Math.max(1, maxSide));
    if (scale < 1.15) return { image, scale: 1 };

    const scaled=await createImageBitmap(bitmap,{resizeWidth:Math.max(1,Math.round(bitmap.width*scale)),resizeHeight:Math.max(1,Math.round(bitmap.height*scale)),resizeQuality:"high"});
    return {image:scaled,scale};
  } finally {
    bitmap.close();
  }
}

/**
 * Local PaddleOCR runner. Fast-mode archives ship with the app; precise and
 * English-enhanced archives are downloaded once by the backend and reused.
 */
const recognitionCache=new ImageRecognitionCache<PaddleOcrRecognition>();
export class LocalPaddleOcr {
  private queue:Array<{image:Blob;stage?: (text:string)=>void;maxSide:number;boxThresh:number;resolve:(value:PaddleOcrRecognition)=>void;reject:(error:unknown)=>void}>=[];
  private draining=false;
  private closed=false;
  isGpu=false;
  private runtime: OcrRuntime<PaddleOcrInstance>;

  constructor(private readonly mode: OcrMode = "fast", private readonly imageOptions: { upscale?: boolean; maxSide?: number; boxThresh?:number; backend?:"auto"|"wasm"|"webgpu"; onDevice?:(message:string,fallback:boolean)=>void } = {}) {
    this.runtime = new OcrRuntime(() => this.initialize(), (instance) => instance.dispose());
  }

  private async initialize(): Promise<PaddleOcrInstance> {
      const models = modelPair(this.mode);
      if(this.mode!=="fast")await api.ensureOcrMode(this.mode);
      const {PaddleOCR}=await import("@paddleocr/paddleocr-js");
      const create=(backend:"wasm"|"webgpu")=>PaddleOCR.create({
        worker:true,initialize:true,
        textDetectionModelName:models.detName,textDetectionModelAsset:{url:models.detUrl},
        textRecognitionModelName:models.recName,textRecognitionModelAsset:{url:models.recUrl},
        pipelineBatchSize:4,textDetectionBatchSize:4,textRecognitionBatchSize:backend==="webgpu"?16:8,
        textDetMaxSideLimit:this.imageOptions.maxSide??4000,textDetBoxThresh:this.imageOptions.boxThresh??.3,textRecScoreThresh:0,
        ortOptions:{backend,wasmPaths:localAssetUrl("./ort/"),numThreads:1,simd:true}
      });
      let reason="";
      if(this.imageOptions.backend!=="wasm"){
        try{
          const gpu=(navigator as Navigator & {gpu?:{requestAdapter:()=>Promise<unknown>}}).gpu;
          if(!gpu||!await gpu.requestAdapter())throw new Error("运行环境或显卡驱动不支持 WebGPU");
          const runner=await create("webgpu");
          this.isGpu=true;
          this.imageOptions.onDevice?.("OCR：GPU · WebGPU（文字识别批量 16）",false);
          return runner;
        }catch(error){
          reason=error instanceof Error?error.message:String(error);
          if(this.imageOptions.backend==="webgpu")throw error;
        }
      }
      const runner=await create("wasm");
      this.imageOptions.onDevice?.(reason?`OCR：已切换 CPU，GPU 不可用：${reason}`:"OCR：CPU",!!reason);
      return runner;
  }

  prepare(): Promise<void> { return this.runtime.run(async()=>{}); }

  recognize(image:Blob,onStage?:(stage:string)=>void,options:{maxSide?:number;boxThresh?:number}={}):Promise<PaddleOcrRecognition>{
    const maxSide=options.maxSide??this.imageOptions.maxSide??4000,boxThresh=options.boxThresh??this.imageOptions.boxThresh??.3;
    const profile=`${this.mode}:${maxSide}:${boxThresh}:${this.imageOptions.upscale!==false&&this.mode!=="manga"}`;
    return recognitionCache.run(image,profile,()=>{
      if(this.closed)return Promise.reject(new Error("识别已取消"));
      return new Promise<PaddleOcrRecognition>((resolve,reject)=>{this.queue.push({image,stage:onStage,maxSide,boxThresh,resolve,reject});if(!this.draining){this.draining=true;setTimeout(()=>void this.drain(),0);}});
    });
  }
  private async drain(){
    while(this.queue.length&&!this.closed){
      const first=this.queue[0],batch:typeof this.queue=[];
      let bytes=0;
      while(this.queue.length&&batch.length<4&&this.queue[0].maxSide===first.maxSide&&this.queue[0].boxThresh===first.boxThresh&&(batch.length===0||bytes+this.queue[0].image.size<=16*1024*1024)){const entry=this.queue.shift()!;batch.push(entry);bytes+=entry.image.size;}
      try{
        const values=await this.runtime.run(async(runner,signal)=>{
          const prepared:Array<{image:Blob|ImageBitmap;scale:number}>=[];
          try{
            for(const item of batch){signal.throwIfAborted();item.stage?.("正在预处理图片");prepared.push(this.mode==="manga"||this.imageOptions.upscale===false?{image:item.image,scale:1}:await prepareRecognitionImage(item.image));}
            signal.throwIfAborted();for(const item of batch)item.stage?.(`批量识别 ${batch.length} 张图片`);
            const results=await runner.predict(prepared.map(item=>item.image),{textDetMaxSideLimit:first.maxSide,textDetBoxThresh:first.boxThresh,textRecScoreThresh:0});
            if(results.length!==batch.length)throw new Error("OCR 批量结果数量不匹配");
            return results.map((result,index)=>({profile:`${this.mode}:${first.maxSide}:${first.boxThresh}:${this.imageOptions.upscale!==false&&this.mode!=="manga"}`,detectedBoxes:result.metrics.detectedBoxes,lines:result.items.map(item=>itemToLine(item,prepared[index].scale)).filter((line):line is PaddleOcrLine=>line!==null),image:{width:result.image.width/prepared[index].scale,height:result.image.height/prepared[index].scale},initialization:runner.getInitializationSummary(),elapsedMs:result.metrics.totalMs}));
          }finally{prepared.forEach((item,index)=>{if(item.image!==batch[index].image)(item.image as ImageBitmap).close();});}
        });
        batch.forEach((item,index)=>item.resolve(values[index]));
      }catch(error){batch.forEach(item=>item.reject(error));}
    }
    this.draining=false;
  }

  dispose(): Promise<void> {
    this.closed=true;for(const item of this.queue.splice(0))item.reject(new Error("识别已取消"));
    return this.runtime.dispose();
  }
}
