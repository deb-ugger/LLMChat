import { ImageRecognitionCache } from "./imageRecognitionCache";
import {applyImageTextRules} from "./imageTextRules";
import type { OcrMode } from "./api";
import type { UnityImage, UnityImageRegion, UnityProject, UnityProgress } from "./unityOffline";
import { LocalPaddleOcr, type PaddleOcrLine } from "./ocr/paddleOcr";
import { LocalMangaOcr } from "./ocr/mangaOcr";

async function png(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("无法生成图片译图");
  return blob;
}
export function mergeUnityOcrLines(lines: PaddleOcrLine[]): PaddleOcrLine[] {
  const blocks: { box: PaddleOcrLine; tail: PaddleOcrLine }[] = [];
  const token = (text: string) => /^[\d\s.,%+\-/:０-９]+$/u.test(text);
  for (const line of [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
    const height = Math.max(1, line.y1 - line.y0); let match = -1, distance = Infinity;
    if (!token(line.text)) blocks.forEach(({ box, tail }, index) => {
      if (token(tail.text) || [...box.text.trim()].length <= 3) return;
      const previousHeight = Math.max(1, tail.y1 - tail.y0), ratio = height / previousHeight, gap = line.y0 - tail.y1;
      const overlap = Math.min(line.x1, tail.x1) - Math.max(line.x0, tail.x0), width = Math.max(1, Math.min(line.x1 - line.x0, tail.x1 - tail.x0));
      const aligned = Math.min(Math.abs(line.x0 - tail.x0), Math.abs((line.x0 + line.x1 - tail.x0 - tail.x1) / 2)) <= Math.max(height, previousHeight) * .7;
      if (ratio < .65 || ratio > 1.5 || gap < -Math.min(height, previousHeight) * .15 || gap > Math.max(height, previousHeight) * .65 || overlap / width < .7 || !aligned) return;
      if (gap < distance) { distance = gap; match = index; }
    });
    if (match < 0) { blocks.push({ box: { ...line }, tail: line }); continue; }
    const block = blocks[match], cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
    const separator = cjk.test([...block.box.text.trim()].at(-1) || "") && cjk.test([...line.text.trim()][0] || "") ? "" : " ";
    block.box = { text: block.box.text.trim() + separator + line.text.trim(), confidence: Math.min(block.box.confidence, line.confidence), x0: Math.min(block.box.x0, line.x0), y0: Math.min(block.box.y0, line.y0), x1: Math.max(block.box.x1, line.x1), y1: Math.max(block.box.y1, line.y1) }; block.tail = line;
  }
  return blocks.map(block => block.box);
}

export async function maskUnityImageRegions(source: Blob, translated: Blob, regions: UnityImageRegion[]): Promise<Blob> {
  const original = await createImageBitmap(source); let rendered: ImageBitmap | undefined;
  try {
    rendered = await createImageBitmap(translated);
    const canvas = document.createElement("canvas"); canvas.width = original.width; canvas.height = original.height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("无法创建译图预览");
    context.drawImage(rendered, 0, 0);
    for (const region of regions.filter(region => !region.selected)) {
      const x = Math.max(0, Math.floor(region.x0)), y = Math.max(0, Math.floor(region.y0));
      const width = Math.min(canvas.width - x, Math.ceil(region.x1) - x), height = Math.min(canvas.height - y, Math.ceil(region.y1) - y);
      if (width <= 0 || height <= 0) continue;
      context.clearRect(x, y, width, height); context.drawImage(original, x, y, width, height, x, y, width, height);
    }
    return await png(canvas);
  } finally { original.close(); rendered?.close(); }
}
const mangaCache=new ImageRecognitionCache<PaddleOcrLine[]>();
export function createUnityImageOcr(mode: OcrMode,backend:"auto"|"wasm"|"webgpu"="auto",onDevice?:(message:string,fallback:boolean)=>void) {
  const paddle = new LocalPaddleOcr(mode, mode === "fast" ? { upscale: false, maxSide: 1280,backend,onDevice } : {backend,onDevice}), manga = mode === "manga" ? new LocalMangaOcr(onDevice) : null;
  return {
    prepare:()=>paddle.prepare(),
    get isGpu(){return paddle.isGpu;},
    async recognize(blob: Blob, stage: (value: string) => void): Promise<PaddleOcrLine[]> {
      const result = await paddle.recognize(blob, stage);
      if (!manga) return mergeUnityOcrLines(result.lines);
      if (!result.lines.length) return [];
      return mangaCache.run(blob,"manga-ocr-v1",async()=>{
      const bitmap = await createImageBitmap(blob);
      try {
        const lines: PaddleOcrLine[] = [];
        for (const box of result.lines) {
          const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.ceil(box.x1 - box.x0)); canvas.height = Math.max(1, Math.ceil(box.y1 - box.y0));
          const context = canvas.getContext("2d"); if (!context) throw new Error("无法裁剪图片文字区域");
          context.drawImage(bitmap, box.x0, box.y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
          stage(`日文增强识别 ${lines.length + 1} / ${result.lines.length}`);
          lines.push({ ...box, text: await manga.recognize(await createImageBitmap(canvas)) });
        }
        return mergeUnityOcrLines(lines);
      } finally { bitmap.close(); }
      });
    },
    async dispose() { await Promise.all([paddle.dispose(), manga?.dispose()]); },
  };
}

export class UnityImageLayoutError extends Error {
  constructor(public readonly failures: { index: number; message: string }[]) {
    super(failures.map(failure => `区域 ${failure.index + 1}：${failure.message}`).join("；"));
  }
}
/** Pure-color replacement is explicit; never claim it reconstructs a complex background. */
export async function renderUnityImage(source: Blob, regions: UnityImageRegion[]): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("无法创建图片画布");
    context.drawImage(bitmap, 0, 0);
    const failures: { index: number; message: string }[] = [];
    const selected = regions.map((region, index) => ({ region, index })).filter(item => item.region.selected);
    const boxes = selected.flatMap(({ region, index }) => {
      const x = Math.max(0, Math.floor(region.x0)), y = Math.max(0, Math.floor(region.y0));
      const width = Math.min(canvas.width - x, Math.ceil(region.x1) - x), height = Math.min(canvas.height - y, Math.ceil(region.y1) - y);
      if (width <= 0 || height <= 0) { failures.push({ index, message: "文字区域超出图片或尺寸无效，请调整区域位置" }); return []; }
      if (!region.translation.trim()) { failures.push({ index, message: "译文为空，请先翻译图片或填写该区域译文" }); return []; }
      const samples:number[][]=[[],[],[],[]];
      const edge=(left:number,top:number,w:number,h:number)=>{const pixels=context.getImageData(left,top,w,h).data;for(let i=0;i<pixels.length;i+=4)for(let c=0;c<4;c++)samples[c].push(pixels[i+c]);};
      edge(x,y,width,1);if(height>1)edge(x,y+height-1,width,1);
      if(height>2){edge(x,y+1,1,height-2);if(width>1)edge(x+width-1,y+1,1,height-2);}
      const color = samples.map(values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]);
      return [{ region, index, x, y, width, height, color }];
    });
    // Clear all original text before painting any translations, so overlapping boxes do not erase freshly painted text.
    for (const box of boxes) {
      context.clearRect(box.x, box.y, box.width, box.height);
      if (box.color[3] > 16) { context.fillStyle = `rgba(${box.color[0]},${box.color[1]},${box.color[2]},${box.color[3] / 255})`; context.fillRect(box.x, box.y, box.width, box.height); }
    }
    const segmenter=new Intl.Segmenter(undefined,{granularity:"grapheme"});
    for (const box of boxes) {
      const paragraphs=box.region.translation.split(/\r\n|\r|\n/).map(text=>[...segmenter.segment(text)].map(item=>item.segment));
      const wrap = (size: number) => {
        context.font = `${size}px "Microsoft YaHei", "Yu Gothic", sans-serif`;
        const lines: string[] = [];
        for (const paragraph of paragraphs) {
          let line = "";
          for (const char of paragraph) {
            if (line && context.measureText(line + char).width > box.width - 4) { lines.push(line); line = ""; }
            line += char;
          }
          lines.push(line);
        }
        return lines;
      };
      let size = Math.min(48, Math.max(7, box.height * .8)), lines = wrap(size);
      while (size > 7 && (lines.length * size * 1.2 > box.height - 2 || lines.some(line => context.measureText(line).width > box.width - 4))) { size -= .5; lines = wrap(size); }
      if (lines.length * size * 1.2 > box.height || lines.some(line => context.measureText(line).width > box.width)) { failures.push({ index: box.index, message: "译文无法放入原文字区域，请缩短译文、调整区域或替换译图" }); continue; }
      context.save(); context.beginPath(); context.rect(box.x, box.y, box.width, box.height); context.clip();
      context.fillStyle = box.color[3] <= 16 || box.color[0] * .299 + box.color[1] * .587 + box.color[2] * .114 > 128 ? "#151515" : "#ffffff";
      context.textAlign = "center"; context.textBaseline = "middle";
      lines.forEach((line, i) => context.fillText(line, box.x + box.width / 2, box.y + box.height / 2 + (i - (lines.length - 1) / 2) * size * 1.2));
      context.restore();
    }
    if (failures.length) throw new UnityImageLayoutError(failures);
    return png(canvas);
  } finally { bitmap.close(); }
}

/** Explicit single-image translation always replaces selected translations. */
export async function translateCurrentUnityImage(image:UnityImage,signal:AbortSignal,translate:(text:string)=>Promise<string>,validate:(source:string,translation:string)=>string,threshold=50,concurrency=1):Promise<UnityImage>{
  const next={...image,regions:unityImageTranslationRegions(image.regions,threshold,image).map(region=>({...region})),completed:false,renderedFile:"",renderedHash:"",error:""};
  const cache=new Map<string,Promise<string>>();let failures=0;
  const selected=next.regions.filter(region=>region.selected);let cursor=0;
  const worker=async()=>{while(cursor<selected.length){const region=selected[cursor++];
    signal.throwIfAborted();region.translation="";region.error="";
    try{if(!region.text.trim())throw new Error("原文为空，请填写该区域原文");let request=cache.get(region.text);if(!request){request=translate(region.text);cache.set(region.text,request);}const value=await request;signal.throwIfAborted();if(!value.trim())throw new Error("翻译结果为空");const error=validate(region.text,value);if(error)throw new Error(error);region.translation=value;}
    catch(error){if(signal.aborted)throw error;region.error=error instanceof Error?error.message:String(error);failures++;}
  }};
  const results=await Promise.allSettled(Array.from({length:Math.min(selected.length,Math.max(1,concurrency))},worker));const failure=results.find((value):value is PromiseRejectedResult=>value.status==="rejected");if(failure)throw failure.reason;
  next.error=failures?`${failures} 个勾选区域翻译失败，请检查区域提示`:"";
  return next;
}
export type UnityImageServices = {
  concurrency?: number;
  translationConcurrency?:number;
  regionConcurrency?:number;
  reuseTranslations?: boolean;
  read: (image: UnityImage) => Promise<Blob>;
  recognize: (source: Blob, stage: (value: string) => void, worker?:number,image?:UnityImage) => Promise<PaddleOcrLine[]>;
  translate: (text: string) => Promise<string>;
  render: (source: Blob, regions: UnityImageRegion[]) => Promise<Blob>;
  write: (project: UnityProject, image: UnityImage, blob: Blob) => Promise<{ path: string; hash: string }>;
  persist: (project: UnityProject, image: UnityImage) => Promise<void>;
  validate: (source: string, translated: string) => string;
};
export function unityImageParticipates(image: UnityImage) {
  return !/字库图集、法线或光照纹理不参与图片文字翻译|仅支持单张二维纹理，不处理数组或立方体纹理/.test(image.error);
}
export function unityImageHasText(image: UnityImage) { return image.regions.some(region => !!region.text.trim()); }
export function unityImageResultGroup(image: UnityImage) {
  if(image.screening?.state==="candidate"&&!image.ocrCompleted)return "candidate";
  if(image.screening?.state==="failed")return "failed";
  if(image.screening?.state==="review")return "review";
  if(image.screening?.state==="not-needed")return "excluded";
  if(image.screening?.state==="no-text")return "empty";
  return unityImageHasText(image) ? "text" : image.error ? "failed" : image.ocrCompleted ? "empty" : "pending";
}
export function unityImageUsesRegionMask(image:UnityImage):boolean{return image.renderedKind==="generated"||!image.renderedKind&&image.regions.some(region=>!!region.translation.trim());}
export function unityImageTranslationRegions(regions: UnityImageRegion[], threshold: number, size?:{width:number;height:number}) {return applyImageTextRules(regions,threshold,size);}
export async function processUnityImages(project: UnityProject, signal: AbortSignal, services: UnityImageServices, progress: (value: UnityProgress & {etaMs?:number}) => void, confidenceThreshold = 50, mode: "all" | "recognize" | "translate" = "all") {
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 100) throw new Error("翻译置信度阈值必须在 0% 到 100% 之间");
  // This lane only changes images; retain the read-only text/resource collections.
  const next = { ...project, images: (project.images||[]).map(image=>image.selected&&(mode==="recognize"?!image.ocrCompleted:!image.completed)?structuredClone(image):image), imagesSkipped: false };
  const images = (next.images || []).filter(image => image.selected && unityImageParticipates(image) && (mode !== "translate" || image.ocrCompleted)), cache = new Map<string, string>();
  if (mode !== "recognize" && services.reuseTranslations !== false) {
    for (const entry of next.entries) if (entry.translation && !entry.error && !services.validate(entry.source, entry.translation)) cache.set(entry.source, entry.translation);
    for (const image of next.images) for (const region of image.regions) if (region.translation && !region.error && !services.validate(region.text, region.translation)) cache.set(region.text, region.translation);
  }
  const pendingTranslations=new Map<string,Promise<string>>();
  const translateText=(text:string)=>{const existing=cache.get(text);if(existing!==undefined)return Promise.resolve(existing);
    let pending=pendingTranslations.get(text);if(!pending){pending=services.translate(text).then(value=>{const error=services.validate(text,value);if(error)throw new Error(error);cache.set(text,value);return value;}).finally(()=>pendingTranslations.delete(text));pendingTranslations.set(text,pending);}return pending;
  };
  let completed = images.filter(image => mode === "recognize" ? image.ocrCompleted : image.completed).length;
  const samples=[{time:performance.now(),completed}];
  const report = (detail: string) => {if(completed!==samples[samples.length-1].completed){samples.push({time:performance.now(),completed});if(samples.length>64)samples.shift();}const first=samples[0],last=samples[samples.length-1],rate=(last.completed-first.completed)/(last.time-first.time);const etaMs=completed===images.length?0:samples.length>=3&&rate>0?(images.length-completed)/rate:undefined;progress({ completed, total: images.length, detail,etaMs });};
  const runImage=async(image:UnityImage,worker=0,prefetch?:Promise<{blob?:Blob;error?:unknown}>)=>{
    signal.throwIfAborted();
    if (mode === "recognize" ? image.ocrCompleted : image.completed) return;
    const publish = async () => services.persist(next, image);
    try {
      report(`读取图片：${image.name}`);
      let source:Blob|undefined;if(mode==="recognize"||!image.ocrCompleted)source=await(async()=>{if(!prefetch)return services.read(image);const value=await prefetch;if(value.error)throw value.error;return value.blob!;})();signal.throwIfAborted();
      if (!image.ocrCompleted) {
        const lines = await services.recognize(source!, stage => report(`${image.name} · ${stage}`),worker,image); signal.throwIfAborted();
        image.regions = lines.filter(line => line.text.trim()).map(line => ({ ...line, translation: "", error: "", selected: line.confidence >= confidenceThreshold }));
        image.regions=unityImageTranslationRegions(image.regions,confidenceThreshold,image);image.ocrCompleted = true; image.error = ""; if(image.screening){const candidate=image.regions.some(region=>region.selected);image.screening={...image.screening,state:candidate?"candidate":image.regions.length?"review":"no-text",reason:candidate?"正式识别完成":image.regions.length?"识别结果需复核":"未识别出文字"};}if(mode!=="recognize")await publish();
      }
      image.regions=unityImageTranslationRegions(image.regions,confidenceThreshold,image);
      if (!unityImageHasText(image)) image.selected = false;
      if (mode === "recognize") { image.completed = !unityImageHasText(image); image.error = ""; completed++; await publish(); report(`已识别图片：${image.name}`); return; }
      let regionNumber = 0;
      const selectedRegions = image.regions.filter(region=>region.selected);
      let regionCursor=0;
      const regionWorker=async()=>{while(regionCursor<selectedRegions.length){const region=selectedRegions[regionCursor++];
        signal.throwIfAborted(); regionNumber++;
        if (region.translation && !services.validate(region.text, region.translation)) { region.error = ""; continue; }
        report(`${image.name} · 翻译文字 ${regionNumber} / ${selectedRegions.length}`);
        try {
          const translation = await translateText(region.text); signal.throwIfAborted();
          const problem = services.validate(region.text, translation); if (problem) throw new Error(problem);
          region.translation = translation; region.error = ""; cache.set(region.text, translation);
        } catch (error) {
          if (signal.aborted) throw error;
          region.error = error instanceof Error ? error.message : String(error);
        }
      }};
      const regionResults=await Promise.allSettled(Array.from({length:Math.min(selectedRegions.length,Math.max(1,services.regionConcurrency||1))},regionWorker));
      const regionFailure=regionResults.find((value):value is PromiseRejectedResult=>value.status==="rejected");if(regionFailure)throw regionFailure.reason;

      const failedRegions = selectedRegions.filter(region => !!region.error);
      if (failedRegions.length) throw new Error(`${failedRegions.length} 个文字区域翻译失败，已保留成功译文和失败详情`);
      if (selectedRegions.length) {
        report(`${image.name} · 生成译图`);
        const result = await services.write(next, image, await services.render(source||await services.read(image), unityImageTranslationRegions(image.regions, confidenceThreshold,image))); signal.throwIfAborted();
        image.renderedFile = result.path; image.renderedHash = result.hash;image.renderedKind="generated";
      } else { image.renderedFile = ""; image.renderedHash = ""; }
      image.completed = true; image.error = ""; completed++; await publish();
      report(`已完成图片：${image.name}${image.regions.length ? selectedRegions.length ? "" : "（没有达到翻译阈值的区域）" : "（未识别出文字）"}`);
    } catch (error) {
      image.error = signal.aborted ? "" : error instanceof Error ? error.message : String(error);
      if (error instanceof UnityImageLayoutError) for (const failure of error.failures) image.regions[failure.index].error = failure.message;
      await publish();
      if (signal.aborted) throw error;
      completed++;
      report(`图片处理失败，已记录并继续：${image.name}`);
    }
  };
  // Model workers can run independently. Network translation stays serialized to respect provider limits.
  const limit=mode==="recognize"?Math.max(1,Math.min(8,services.concurrency||1)):Math.max(1,Math.min(4,services.translationConcurrency||1));let cursor=0,failure:unknown;
  const take=()=>{if(failure||signal.aborted||cursor>=images.length)return null;const image=images[cursor++];return {image,read:mode==="recognize"&&!image.ocrCompleted?services.read(image).then(blob=>({blob}),error=>({error})):undefined};};
  const workers=Array.from({length:limit},(_,worker)=>(async()=>{let item=take();while(!failure&&item){const current=item;item=take();try{await runImage(current.image,worker,current.read);}catch(error){failure=error;throw error;}}})());
  const results=await Promise.allSettled(workers);const rejected=results.find((result):result is PromiseRejectedResult=>result.status==="rejected");if(rejected)throw rejected.reason;
  signal.throwIfAborted();
  const failed = images.filter(image => mode === "recognize" ? !image.ocrCompleted : !image.completed);
  if (failed.length) { report(`已处理 ${images.length} 张图片，${failed.length} 张未完成，失败详情已保存`); throw new Error(`${failed.length} 张图片未完成，请检查图片结果后恢复，或跳过未完成的图片`); }
  report(images.length ? mode === "recognize" ? "图片识别结果已保存" : "图片翻译与译图已保存" : "当前没有选中的可处理图片");
  return next;
}
