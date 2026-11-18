import JSZip from "jszip";
import type {UnityImage} from "./unityOffline";
export type ImageArchiveReplacement={image:UnityImage;blob:Blob};
type Entry={id:string;file:string;container:string;objectId:string;sourceHash:string;width:number;height:number;path:string};
export class ImageArchiveError extends Error {constructor(public issues:string[]){super("图片压缩包校验失败，尚未替换任何图片："+issues.join("；"));}}
const locator=(image:Pick<UnityImage,"file"|"container"|"objectId">)=>JSON.stringify([image.file.replaceAll("\\","/"),image.container,image.objectId]);
const prefixKey=(image:UnityImage)=>image.name.normalize("NFKC").toLocaleLowerCase();
export function sortGameImages(images:UnityImage[],selected?:ReadonlyMap<string,boolean>):UnityImage[]{
 return images.map(image=>({image,key:prefixKey(image),selected:selected?.get(image.id)??image.selected})).sort((a,b)=>Number(b.selected)-Number(a.selected)||(a.key<b.key?-1:a.key>b.key?1:locator(a.image).localeCompare(locator(b.image))||a.image.id.localeCompare(b.image.id))).map(row=>row.image);
}
export type GameImageExportProgress =
  | { stage: "reading"; completed: number; file: string }
  | { stage: "packing"; percent: number };

export type GameImageExportControl = {
  signal: AbortSignal;
  checkpoint: () => Promise<void>;
  onPauseChange: (listener: (paused: boolean) => void) => () => void;
};

const archiveChunkSize = 1024 * 1024;
const manifestPath = "llmchat-images.json";

export async function exportGameImages(
  images: readonly UnityImage[],
  read: (image: UnityImage, signal: AbortSignal) => Promise<Blob>,
  progress: (value: GameImageExportProgress) => void,
  control: GameImageExportControl,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<number> {
  if (images.length + 1 >= 0xffff) throw new Error("图片数量超过单个 ZIP 的上限，请按筛选范围分批下载");
  await control.checkpoint();
  const zip = new JSZip();
  const entries: Entry[] = [];
  const sources = new Map<string, { image: UnityImage; index: number; supply: (bytes: ArrayBuffer) => void }>();
  for (const [index, image] of images.entries()) {
    if (!image.sourceFile) throw new Error(`无法导出 ${image.name}：没有原图文件（${locator(image)}）`);
    const name = image.name.replace(/[\\/:*?"<>|]/g, "_").replace(/\.[^.]*$/, "") || "image";
    const path = `images/${encodeURIComponent(image.id)}/${name}.png`;
    if (sources.has(path)) throw new Error(`压缩包内图片路径重复：${path}`);
    const bytes = new Promise<ArrayBuffer>(supply => sources.set(path, { image, index, supply }));
    zip.file(path, bytes, { binary: true, createFolders: false });
    entries.push({ id: image.id, file: image.file, container: image.container, objectId: image.objectId,
      sourceHash: image.sourceHash, width: image.width, height: image.height, path });
  }
  zip.file(manifestPath, JSON.stringify({ format: "llmchat-images", version: 1, images: entries }, null, 2));
  const archive = zip.generateInternalStream({ type: "uint8array", compression: "STORE", streamFiles: true });
  // The ZIP worker owns each input after registration. Drop our ZIP entries so completed inputs can be collected.
  for (const path of sources.keys()) zip.remove(path);
  zip.remove(manifestPath);

  const { signal } = control;
  let resume = () => {};
  let stop = () => {};
  const chunks = new ReadableStream<Uint8Array>({
    start(output) {
      let ended = false;
      let paused = false;
      let lastPercent = -1;
      resume = () => {
        if (!ended && !paused && (output.desiredSize ?? 0) > 0) archive.resume();
      };
      stop = () => {
        ended = true;
        archive.pause();
        unsubscribe();
        signal.removeEventListener("abort", abort);
      };
      const fail = (error: unknown) => {
        if (ended) return;
        stop();
        output.error(error);
      };
      const abort = () => fail(signal.reason);
      const unsubscribe = control.onPauseChange(value => {
        paused = value;
        if (paused) archive.pause();
        else resume();
      });
      signal.addEventListener("abort", abort, { once: true });
      archive.on("data", (chunk, { currentFile, percent }) => {
        if (ended) return;
        output.enqueue(chunk);
        if ((output.desiredSize ?? 0) <= 0) archive.pause();

        // A streamed entry emits its local header before waiting for its image bytes.
        const source = currentFile ? sources.get(currentFile) : undefined;
        if (currentFile && source) {
          sources.delete(currentFile);
          void (async () => {
            await control.checkpoint();
            progress({ stage: "reading", completed: source.index, file: source.image.name });
            const bytes = await (await read(source.image, signal)).arrayBuffer();
            await control.checkpoint();
            if (!ended) source.supply(bytes);
          })().catch(fail);
        } else if (!sources.size && (currentFile === manifestPath || currentFile === null)) {
          const rounded = Math.floor(percent);
          if (rounded !== lastPercent) {
            lastPercent = rounded;
            progress({ stage: "packing", percent: rounded });
          }
        }
      }).on("error", fail).on("end", () => {
        if (ended) return;
        stop();
        output.close();
      });
    },
    pull() { resume(); },
    cancel() { stop(); },
  }, { highWaterMark: archiveChunkSize, size: chunk => chunk.byteLength });

  const reader = chunks.getReader();
  const buffer = new Uint8Array(archiveChunkSize);
  let buffered = 0;
  let written = 0;
  const flush = async () => {
    await control.checkpoint();
    await write(buffer.subarray(0, buffered));
    written += buffered;
    buffered = 0;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await control.checkpoint();
      if (written + buffered + value.byteLength >= 0xffffffff) {
        throw new Error("图片压缩包将超过 4 GiB，请按筛选范围分批下载");
      }
      for (let offset = 0; offset < value.byteLength;) {
        const length = Math.min(archiveChunkSize - buffered, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + length), buffered);
        buffered += length;
        offset += length;
        if (buffered === archiveChunkSize) await flush();
      }
    }
    if (buffered) await flush();
    return written;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function validateGameImageArchive(bytes:ArrayBuffer,images:UnityImage[],decode:(blob:Blob)=>Promise<{width:number;height:number;close:()=>void}>=createImageBitmap):Promise<{replacements:ImageArchiveReplacement[];ignored:number;missing:number}>{
 const zip=await JSZip.loadAsync(bytes,{checkCRC32:true,createFolders:false});
 const manifest=zip.file("llmchat-images.json");if(!manifest)throw new ImageArchiveError(["缺少 llmchat-images.json 定位清单，请使用本软件导出的压缩包，并保留清单和目录结构"]);
 let data;try{data=JSON.parse(await manifest.async("string"));}catch{throw new ImageArchiveError(["定位清单不是有效 JSON"]);}
 if(data?.format!=="llmchat-images"||data.version!==1||!Array.isArray(data.images))throw new ImageArchiveError(["定位清单格式或版本不受支持"]);
 const current=new Map(images.map(image=>[image.id,image])),seen=new Set<string>(),paths=new Set<string>(),issues:string[]=[],replacements:ImageArchiveReplacement[]=[];
 let ignored=0,missing=0;
 for(const row of data.images){
  const image=current.get(row?.id);if(!image){ignored++;continue;}
  const label=`${image.name}（资源 ${image.file}，容器 ${image.container||"无"}，对象 ${image.objectId}，编号 ${image.id}）`;
  if(seen.has(image.id)){issues.push(label+"：定位清单重复编号");continue;}seen.add(image.id);
  if(typeof row.path!=="string"||!row.path.startsWith("images/")||row.path.includes("\\")||row.path.split("/").some((part:string)=>part===".."||part===".")){issues.push(label+"：压缩包内部路径无效");continue;}
  if(paths.has(row.path)){issues.push(label+"：多个对象指向同一个压缩包文件 "+row.path);continue;}paths.add(row.path);
  if(row.file!==image.file||row.container!==image.container||row.objectId!==image.objectId){issues.push(label+"：资源路径、容器或对象编号不匹配，拒绝按同名文件替换");continue;}
  if(row.sourceHash!==image.sourceHash){issues.push(label+"：原资源版本不匹配，请从当前工程重新导出");continue;}
  if(row.width!==image.width||row.height!==image.height){issues.push(label+"：清单尺寸与当前图片不匹配");continue;}
  const entry=zip.file(row.path);if(!entry){missing++;continue;}
  try{
   const content=await entry.async("uint8array"),head=new Uint8Array(content.buffer,content.byteOffset,Math.min(8,content.byteLength));
   if(head.length!==8||head.some((value,index)=>value!==[137,80,78,71,13,10,26,10][index]))throw new Error("文件不是 PNG，禁止仅修改扩展名");
   if(content.byteLength<24)throw new Error("PNG 文件头不完整");
   const header=new DataView(content.buffer,content.byteOffset,content.byteLength);
   const width=header.getUint32(16),height=header.getUint32(20);
   if(width!==image.width||height!==image.height)throw new Error(`PNG 尺寸为 ${width}×${height}，必须为 ${image.width}×${image.height}`);
   const blob=new Blob([new Uint8Array(content)],{type:"image/png"}),bitmap=await decode(blob);
   try{if(bitmap.width!==image.width||bitmap.height!==image.height)throw new Error(`图片尺寸为 ${bitmap.width}×${bitmap.height}，必须为 ${image.width}×${image.height}`);}finally{bitmap.close();}
   replacements.push({image,blob});
  }catch(error){issues.push(label+"，文件 "+row.path+"："+(error instanceof Error?error.message:String(error)));}
 }
 if(issues.length)throw new ImageArchiveError(issues);
 return {replacements,ignored,missing};
}
