import {readFileBytes} from "./localDocFile";
import type {UnityImage} from "./unityOffline";
export type GameImportSource=string|File;
export const importSourceName=(source:GameImportSource)=>typeof source==="string"?source.split(/[\\/]/).at(-1)||source:source.name;
export async function imageImportPng(source:GameImportSource,image:UnityImage):Promise<Blob>{
 const bytes=typeof source==="string"?await readFileBytes(source):await source.arrayBuffer();
 const blob=new Blob([bytes]);let bitmap:ImageBitmap;
 try{bitmap=await createImageBitmap(blob);}catch{throw new Error(`无法解码图片 ${importSourceName(source)}，请使用 PNG、JPG、WebP 或 BMP 静态图片`);}
 try{
  if(bitmap.width!==image.width||bitmap.height!==image.height)throw new Error(`图片 ${importSourceName(source)} 尺寸为 ${bitmap.width}×${bitmap.height}，当前图片需要 ${image.width}×${image.height}`);
  const header=new Uint8Array(bytes,0,Math.min(8,bytes.byteLength));
  if(header.length===8&&header.every((value,index)=>value===[137,80,78,71,13,10,26,10][index]))return new Blob([bytes],{type:"image/png"});
  const canvas=document.createElement("canvas");canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext("2d")!.drawImage(bitmap,0,0);
  return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error("图片转换为 PNG 失败")),"image/png"));
 }finally{bitmap.close();}
}
