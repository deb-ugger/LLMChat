import {applyImageTextRules, IMAGE_TEXT_RULE_VERSION} from "./imageTextRules";
import type { PaddleOcrLine } from "./ocr/paddleOcr";
import type { UnityImage, UnityProject } from "./unityOffline";

export type ImageScreening = {
  rules?:number; strategy?: "staged"|"full"; model?: string; version: 1; sourceHash: string; source: string; target: string;
  state: "candidate" | "no-text" | "review" | "not-needed" | "failed";
  recognition?:{profile:string;lines:PaddleOcrLine[];detectedBoxes:number};
  boxes: number; reason: string;
};
type Options = { resume?:boolean; source:string;target:string;strategy?:"staged"|"full";concurrency?:number;model?:string };
type Recognition = { profile?:string;lines:PaddleOcrLine[];detectedBoxes:number };
const language=(value:string)=>value.trim().toLowerCase().replace(/_/g,"-");

export function classifyImageText(result:Recognition,options:Options):Pick<ImageScreening,"state"|"reason"> {
  const text=result.lines.map(line=>line.text.trim()).filter(Boolean).join(" ");
  if(!result.detectedBoxes&&!text)return {state:"no-text",reason:"未检测到文字区域"};
  if(!text)return {state:"review",reason:"检测到区域，但未识别出文字"};
  if(!/\p{L}/u.test(text))return {state:"not-needed",reason:"仅数字或符号"};
  const confident=result.lines.filter(line=>line.confidence>=50&&/\p{L}/u.test(line.text)).map(line=>line.text).join(" ");
  if(!confident)return {state:"review",reason:"文字置信度低于 50%"};
  const source=language(options.source),target=language(options.target),src=source.split("-")[0],dst=target.split("-")[0];
  if(src!=="auto"&&source===target)return {state:"not-needed",reason:"源语言与目标语言相同"};
  const kana=/[\u3040-\u30ff]/u.test(confident),hangul=/[\uac00-\ud7af]/u.test(confident),han=/\p{Script=Han}/u.test(confident),latin=/\p{Script=Latin}/u.test(confident);
  if((dst==="ja"&&kana&&/^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{N}\p{P}\p{S}\p{M}\s]+$/u.test(confident))||(dst==="ko"&&hangul&&/^[\p{Script=Hangul}\p{N}\p{P}\p{S}\p{M}\s]+$/u.test(confident)))return {state:"not-needed",reason:"文字已属于目标语言"};
  if(dst==="zh"&&han&&!kana&&!hangul&&!latin){
    if(src==="ja"||src==="ko")return {state:"candidate",reason:"按指定源语言识别的文字"};
    if(src==="zh"&&source!==target)return {state:"candidate",reason:"按指定中文变体转换"};
    return {state:"review",reason:"纯汉字无法可靠区分中文与日文"};
  }
  if(dst==="en"&&latin&&!han&&!kana&&!hangul){
    if(src!=="auto"&&src!=="en")return {state:"candidate",reason:"按指定源语言翻译"};
    return {state:"review",reason:"拉丁文字需确认是否已是目标语言"};
  }
  return {state:"candidate",reason:"检测到可翻译文字"};
}

export function coarseImageReason(image:UnityImage):string|null {
  if(image.selectionManual)return null;
  const file=image.file.replace(/\\/g,"/").toLowerCase();
  const group=file.match(/(?:^|\/)img\/(animations|characters|sv_actors|sv_enemies|tilesets)\//)?.[1];
  return group?`粗筛跳过 ${group} 素材，可手动改选或使用完整筛选`:null;
}
export class ScreeningModelError extends Error {}
export async function screenGameImages(project:UnityProject,signal:AbortSignal,options:Options,services:{
  read:(image:UnityImage)=>Promise<Blob>;
  recognize:(image:Blob,stage:(value:string)=>void,worker?:number)=>Promise<Recognition>;
  persist:(images:UnityImage[])=>Promise<void>;
},progress:(value:{completed:number;total:number;detail:string;etaMs?:number})=>void) {
  const images=(project.images||[]).filter(image=>image.sourceFile&&!image.completed),strategy=options.strategy||"full";
  const pending:UnityImage[]=[];let completed=0,writeQueue=Promise.resolve(),next=0,deepDone=0;
  const counts={candidate:0,"no-text":0,review:0,"not-needed":0,failed:0},work:UnityImage[]=[];
  const flush=()=>{if(pending.length){const rows=pending.splice(0);writeQueue=writeQueue.then(()=>services.persist(rows));}return writeQueue;};
  const policy=(image:UnityImage,state:ImageScreening["state"],reason:string,boxes=0):ImageScreening=>({version:1,rules:IMAGE_TEXT_RULE_VERSION,strategy,model:options.model||"fast",sourceHash:image.sourceHash,source:options.source,target:options.target,state,reason,boxes});
  const samples:Array<{time:number;done:number}>=[];
  const eta=()=>{if(deepDone===work.length)return 0;if(samples.length<3)return undefined;const first=samples[0],last=samples[samples.length-1],rate=(last.done-first.done)/(last.time-first.time);return rate>0?Math.max(0,(work.length-deepDone)/rate):undefined;};
  const report=(detail:string)=>progress({completed,total:images.length,detail,etaMs:eta()});
  // Cheap resource-type pass before any image decoding or model initialization.
  for(const image of images){signal.throwIfAborted();const old=image.screening;
    if(options.resume&&old?.sourceHash===image.sourceHash&&old.state!=="failed"){counts[old.state]++;completed++;continue;}
    if(old?.version===1&&old.rules===IMAGE_TEXT_RULE_VERSION&&old.sourceHash===image.sourceHash&&old.source===options.source&&old.target===options.target&&old.state!=="failed"&&(old.strategy||"full")===strategy&&(old.model||"fast")===(options.model||"fast")){counts[old.state]++;completed++;continue;}
    const reason=strategy==="staged"?coarseImageReason(image):null;
    if(reason){pending.push({...image,selected:false,screening:policy(image,"not-needed",reason)});counts["not-needed"]++;completed++;if(pending.length>=128)await flush();}
    else work.push(image);
  }
  report(`素材粗筛完成 · ${work.length} 张进入文字检测`);await flush();
  let failure:unknown;
  const take=()=>{if(failure||signal.aborted||next>=work.length)return null;const original=work[next++];return {original,read:original.ocrCompleted?null:services.read(original).then(blob=>({blob,error:undefined}),error=>({blob:undefined,error}))};};
  const worker=async(workerId:number)=>{let item=take();while(!failure&&item){signal.throwIfAborted();const {original,read}=item;item=take();let image:UnityImage={...original};report(`检测文字：${image.name}`);
    try {const reuse=image.ocrCompleted&&(!image.screening||image.selectionManual||(image.screening.sourceHash===image.sourceHash&&image.screening.source===options.source&&image.screening.target===options.target&&(image.screening.strategy||"full")===strategy&&(image.screening.model||"fast")===(options.model||"fast")));const result=reuse?{lines:image.regions,detectedBoxes:image.screening?.boxes??image.regions.length}:await services.recognize(await(async()=>{if(!read)return services.read(image);const value=await read;if(value.error)throw value.error;return value.blob!;})(),detail=>report(`${image.name} · ${detail}`),workerId);
      signal.throwIfAborted();const regions=applyImageTextRules(reuse?image.regions:result.lines.map(line=>({...line,translation:"",selected:line.confidence>=50,error:""})),50,image);let classification=classifyImageText(result,options);if(classification.state==="candidate"&&regions.every(region=>!region.selected))classification={state:"review",reason:"文字区域疑似误检，需人工确认"};image={...image,error:"",screening:policy(image,classification.state,classification.reason,result.detectedBoxes)};if(result.profile&&(classification.state==="candidate"||classification.state==="review"))image.screening!.recognition={profile:result.profile,lines:result.lines,detectedBoxes:result.detectedBoxes};
      if(!image.selectionManual)image.selected=classification.state==="candidate";
    }catch(error){if(signal.aborted||error instanceof ScreeningModelError)throw error;image={...image,screening:policy(image,"failed",String(error)),error:String(error)};if(!image.selectionManual)image.selected=false;}
    counts[image.screening!.state]++;pending.push(image);completed++;deepDone++;samples.push({time:performance.now(),done:deepDone});if(samples.length>64)samples.shift();if(pending.length>=16)await flush();report(`文字筛选 ${completed} / ${images.length}`);
  }};
  try{const results=await Promise.allSettled(Array.from({length:Math.max(1,Math.min(8,options.concurrency||1))},(_,i)=>worker(i).catch(error=>{failure=error;throw error;})));const rejected=results.find((result):result is PromiseRejectedResult=>result.status==="rejected");if(rejected)throw rejected.reason;}finally{await flush();}
  return counts;
}
