import { blobSha256Hex } from "./fileFingerprint";

/** Exact image bytes plus processing profile; bounded and never caches failures. */
export class ImageRecognitionCache<T> {
  private values=new Map<string,Promise<T>>();
  async run(image:Blob,profile:string,work:()=>Promise<T>):Promise<T>{
    const key = profile + ":" + await blobSha256Hex(image);
    let result=this.values.get(key);
    if(result){this.values.delete(key);this.values.set(key,result);return structuredClone(await result);}
    result=work();this.values.set(key,result);
    if(this.values.size>256)this.values.delete(this.values.keys().next().value!);
    try{return structuredClone(await result);}catch(error){if(this.values.get(key)===result)this.values.delete(key);throw error;}
  }
}
