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
export async function exportGameImages(images:UnityImage[],read:(image:UnityImage)=>Promise<Blob>,progress:(text:string)=>void):Promise<Uint8Array>{
 const zip=new JSZip(),entries:Entry[]=[];
 for(const image of images){
  if(!image.sourceFile)throw new Error(`无法导出 ${image.name}：没有原图文件（${locator(image)}）`);
  const name=image.name.replace(/[\/:*?"<>|]/g,"_").replace(/\.[^.]*$/,"")||"image";
  const path=`images/${encodeURIComponent(image.id)}/${name}.png`;
  progress(`导出图片 ${entries.length+1}/${images.length}：${image.name}`);
  zip.file(path,await(await read(image)).arrayBuffer());
  entries.push({id:image.id,file:image.file,container:image.container,objectId:image.objectId,sourceHash:image.sourceHash,width:image.width,height:image.height,path});
 }
 zip.file("llmchat-images.json",JSON.stringify({format:"llmchat-images",version:1,images:entries},null,2));
 return zip.generateAsync({type:"uint8array",compression:"STORE",streamFiles:true});
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
