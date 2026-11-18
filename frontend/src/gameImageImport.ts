import {readFileBytes} from "./localDocFile";
import { unityRun } from "./unityOffline";
import type {UnityImage} from "./unityOffline";
export type GameImportSource=string|File;
export const importSourceName=(source:GameImportSource)=>typeof source==="string"?source.split(/[\\/]/).at(-1)||source:source.name;
export async function webImageFile(url: string): Promise<File> {
 if (/^https?:\/\//i.test(url)) {
  const result = await unityRun<{ data: string; mime: string }>("download-image", { url });
  const blob = await fetch(`data:${result.mime};base64,${result.data}`).then(response => response.blob());
  return new File([blob], "web-image.png", { type: blob.type });
 }
 if (!/^data:image\//i.test(url)) throw new Error("网页图片地址无法读取，请从网页原图拖入；临时 blob 地址只能在原网页中使用");
 if (url.length > 48 * 1024 * 1024) throw new Error("网页图片超过 32 MiB，无法导入");
 const blob = await fetch(url).then(response => response.blob());
 return new File([blob], "web-image.png", { type: blob.type });
}
export async function imageImportPng(source:GameImportSource,image:UnityImage):Promise<Blob>{
 if (typeof source !== "string" && source.size > 32 * 1024 * 1024) throw new Error("图片文件超过 32 MiB，无法导入");
 const bytes=typeof source==="string"?await readFileBytes(source):await source.arrayBuffer();
 if (!bytes.byteLength || bytes.byteLength > 32 * 1024 * 1024) throw new Error("图片为空或超过 32 MiB，无法导入");
 const signature = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
 const pngHeader = [137,80,78,71,13,10,26,10];
 const pngFile = signature.length >= 8 && pngHeader.every((value,index) => signature[index] === value);
 const jpeg = signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
 const bmp = signature[0] === 66 && signature[1] === 77;
 const webp = String.fromCharCode(...signature.slice(0,4)) === "RIFF" && String.fromCharCode(...signature.slice(8,12)) === "WEBP";
 if (!pngFile && !jpeg && !bmp && !webp) throw new Error("图片实际格式不支持，仅接受 PNG、JPG、WebP 或 BMP 静态图片");
 const blob=new Blob([bytes], { type: pngFile ? "image/png" : "" });let bitmap:ImageBitmap;
 try{bitmap=await createImageBitmap(blob);}catch{throw new Error(`无法解码图片 ${importSourceName(source)}，请使用 PNG、JPG、WebP 或 BMP 静态图片`);}
 try{
  if (bitmap.width * bitmap.height > 64 * 1024 * 1024) throw new Error("图片超过 6400 万像素，无法导入");
  if(bitmap.width!==image.width||bitmap.height!==image.height)throw new Error(`图片 ${importSourceName(source)} 尺寸为 ${bitmap.width}×${bitmap.height}，当前图片需要 ${image.width}×${image.height}`);
  if(pngFile)return blob;
  const canvas=document.createElement("canvas");canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext("2d")!.drawImage(bitmap,0,0);
  return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error("图片转换为 PNG 失败")),"image/png"));
 }finally{bitmap.close();}
}
