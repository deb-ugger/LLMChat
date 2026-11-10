import { readFileBytes } from "./localDocFile";
import { unityRun, type UnityImage, type UnityProject } from "./unityOffline";
export type ImagePreviewReader = (image: UnityImage, translated: boolean, thumbnail: boolean, signal: AbortSignal) => Promise<Blob>;

type Preview = { url: string; opaqueUrl: string; bytes: number };
type Item = { users: number; ready: Promise<Preview>; value?: Preview; controller: AbortController; started: boolean; run: () => void; cancel: () => void };
const cache = new Map<string, Item>(), queue: Item[] = [];
const limit = 64 * 1024 * 1024; let active = 0;
export const unityImagePreviewKey = (project: UnityProject, image: UnityImage, translated: boolean, thumbnail = false) => JSON.stringify([project.folder, translated ? image.renderedFile : image.sourceFile, translated ? image.renderedHash : image.sourceHash, translated, thumbnail]);
export const peekUnityImagePreview = (key: string) => cache.get(key)?.value;
function trim() {
 let bytes = [...cache.values()].reduce((sum, item) => sum + (item.value?.bytes || 0), 0);
 for (const [key, item] of cache) { if (bytes <= limit && cache.size <= 96) break; if (item.users || !item.value) continue; bytes -= item.value.bytes; URL.revokeObjectURL(item.value.url); if(item.value.opaqueUrl)URL.revokeObjectURL(item.value.opaqueUrl); cache.delete(key); }
}
function pump() { while(active < 2 && queue.length) { const item=queue.shift()!; item.started=true; active++; item.run(); } }
export function acquireUnityImagePreview(project: UnityProject, image: UnityImage, translated: boolean, thumbnail = false, reader?: ImagePreviewReader) {
 const key=unityImagePreviewKey(project,image,translated,thumbnail);let item=cache.get(key);
 if(item){cache.delete(key);cache.set(key,item);}else{
  let resolve!:(value:Preview)=>void,reject!:(reason:unknown)=>void;
  const entry={users:0,controller:new AbortController(),started:false,ready:new Promise<Preview>((yes,no)=>{resolve=yes;reject=no;})} as Item;
  entry.cancel=()=>reject(new DOMException("图片读取已取消","AbortError"));
  entry.run=()=>{void(async()=>{const signal=entry.controller.signal;try{
   signal.throwIfAborted();let blob:Blob,opaque:Blob|undefined;
   if(reader)blob=await reader(image,translated,thumbnail,signal);else if(translated)blob=new Blob([await readFileBytes(project.folder+"/"+image.renderedFile)],{type:"image/png"});else{
    const data=await unityRun<{data:string;opaque:string;fullyTransparent:boolean}>("preview-image",{path:project.folder,imageId:image.id,thumbnail,project:{folder:project.folder,images:[image]}},undefined,signal);
    signal.throwIfAborted();blob=await fetch("data:image/png;base64,"+data.data,{signal}).then(response=>response.blob());
    if(data.fullyTransparent)opaque=await fetch("data:image/png;base64,"+data.opaque,{signal}).then(response=>response.blob());
   }
   signal.throwIfAborted();const pixels=thumbnail?Math.min(image.width,256)*Math.min(image.height,256)*4:image.width*image.height*4;
   const value={url:URL.createObjectURL(blob),opaqueUrl:opaque?URL.createObjectURL(opaque):"",bytes:Math.max(blob.size,pixels)+(opaque?Math.max(opaque.size,pixels):0)};entry.value=value;resolve(value);trim();
  }catch(error){if(cache.get(key)===entry)cache.delete(key);reject(error);}finally{entry.run=()=>{};entry.cancel=()=>{};active--;pump();}})();};
  entry.users=1;cache.set(key,entry);queue.push(entry);pump();item=entry;
  let released=false;return{ready:item.ready,release:()=>{if(!released){released=true;release(key,entry);}}};
 }
 item.users++;let released=false;return{ready:item.ready,release(){if(!released){released=true;release(key,item!);}}};
}
function release(key:string,item:Item){item.users--;if(!item.users&&!item.value){item.controller.abort();if(!item.started){const index=queue.indexOf(item);if(index>=0)queue.splice(index,1);item.cancel();}if(cache.get(key)===item)cache.delete(key);}trim();}
