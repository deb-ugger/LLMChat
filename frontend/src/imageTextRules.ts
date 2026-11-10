export type TextRegion = {text:string;confidence:number;x0:number;y0:number;x1:number;y1:number;selected:boolean;manualSelected?:boolean;reviewReason?:string};
export const IMAGE_TEXT_RULE_VERSION = 2;
export function imageTextReviewReason(region:TextRegion,size?:{width:number;height:number}):string|undefined {
  const text=region.text.trim();
  if(!text)return "未识别出文字";
  if(!/\p{L}/u.test(text))return "仅数字或符号，不自动翻译";
  if(size?.width&&size.height){
    const w=Math.max(0,region.x1-region.x0),h=Math.max(0,region.y1-region.y0),area=w*h/(size.width*size.height);
    const length=Array.from(text.replace(/\s/g,"")).length;
    if((length<=2&&area>=.12)||(length<=5&&area>=.5))return "少量字符对应过大区域，疑似图案误检";
  }
  return undefined;
}
export function applyImageTextRules<T extends TextRegion>(regions:T[],threshold:number,size?:{width:number;height:number}):T[]{
  return regions.map(region=>{const reviewReason=imageTextReviewReason(region,size);return {...region,reviewReason,selected:region.selected&&(region.manualSelected===true||region.confidence>=threshold&&!reviewReason)};});
}
