export type TextRegion = {text:string;confidence:number;x0:number;y0:number;x1:number;y1:number;selected:boolean;manualSelected?:boolean;ocrConfirmed?:boolean;reviewReason?:string;translation?:string};
export const IMAGE_TEXT_RULE_VERSION = 2;
type ImageTextSize = { width: number; height: number; kind?: string };
export function usesUnityImageTextEvidence(size?: ImageTextSize) {
  return size?.kind === "texture" || size?.kind === "hidc";
}
export function imageTextReviewReason(region:TextRegion,size?:{width:number;height:number}):string|undefined {
  const text=region.text.trim();
  if(!text)return "未识别出文字";
  if(!/\p{L}/u.test(text))return "仅数字或符号，不自动翻译";
  if(size?.width&&size.height){
    const w=Math.max(0,region.x1-region.x0),h=Math.max(0,region.y1-region.y0),area=w*h/(size.width*size.height);
    const length=Array.from(text.replace(/\s/g,"")).length;
    if (/^[\p{Script=Hiragana}\p{Script=Katakana}][\p{P}\p{S}]*$/u.test(text) &&
      Math.max(w,h) <= Math.max(size.width,size.height)*.05) return "细小单个假名，可能是未读完整的文字";
    if((length<=2&&area>=.12)||(length<=5&&area>=.5))return "少量字符对应过大区域，疑似图案误检";
  }
  return undefined;
}
function unityTextEvidenceIssue(region: TextRegion, hasContext: boolean) {
  const letters = [...region.text.normalize("NFKC")].filter(char => /\p{L}/u.test(char)).join("");
  const count = [...letters].length;
  if (count < 2) return "孤立字符，需核对是否为图案误识";
  if (count <= 4 && /^(.{1,2})\1+$/iu.test(letters)) return "短重复字符，需核对是否为纹理误识";
  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(letters)) {
    if (region.confidence < (count === 2 ? 72 : 62)) return "短文字置信度不足，需复核";
  } else if (count <= 3) {
    if (!hasContext || region.confidence < 85) return "孤立短缩写或混合字符，需复核";
  } else if (region.confidence < 78) return "文字置信度不足，需复核";
  return undefined;
}

export function applyImageTextRules<T extends TextRegion>(regions: T[], threshold: number, size?: ImageTextSize): T[] {
  if (!usesUnityImageTextEvidence(size)) return regions.map(region => {
    const reviewReason = imageTextReviewReason(region, size);
    return { ...region, reviewReason, selected: region.selected && (region.manualSelected === true || region.confidence >= threshold && !reviewReason) };
  });
  const originalIssues = regions.map(region => imageTextReviewReason(region, size));
  const trusted = (region: TextRegion) => region.manualSelected === true || region.ocrConfirmed === true || !!region.translation?.trim();
  const anchors = regions.filter((region, index) => region.selected && (trusted(region) ||
    region.confidence >= threshold && !originalIssues[index] && !unityTextEvidenceIssue(region, false))).length;
  return regions.map((region, index) => {
    const reviewReason = region.ocrConfirmed ? undefined : originalIssues[index] || unityTextEvidenceIssue(region, anchors >= 2);
    return { ...region, reviewReason, selected: region.selected && (trusted(region) || region.confidence >= threshold && !reviewReason) };
  });
}
