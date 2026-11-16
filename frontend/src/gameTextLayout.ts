import { gameFormatTokens } from "./gameDisplayText";
import { unityListBlocks } from "./unityTextStructure";
export type GameWrapMode = "join" | "keep" | "natural";
const graphemes=new Intl.Segmenter(undefined,{granularity:"grapheme"});
const cjk=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\u3000-\u303f\uff01-\uff60]/u;
function units(text:string){const result:{text:string;width:number}[]=[];let offset=0;const append=(part:string)=>{for(const {segment}of graphemes.segment(part))result.push({text:segment,width:/^\s+$/u.test(segment)?.5:cjk.test(segment)?2:1});};for(const match of text.matchAll(gameFormatTokens())){append(text.slice(offset,match.index));result.push({text:match[0],width:0});offset=match.index!+match[0].length;}append(text.slice(offset));return result;}
export function sourceGameLineWidth(source:string){return Math.max(0,...source.split(/\r\n|\r|\n|<br\s*\/?>|\\n(?![A-Za-z<]|\[)/i).map(line=>units(line).reduce((sum,unit)=>sum+unit.width,0)));}
/** Relative character widths are used when the scanned resource supplies no font metrics. */
export function wrapGameTextToSource(source:string,translation:string){
  const maximum=sourceGameLineWidth(source);if(!maximum)return translation;
  const newline=source.includes("\r\n")?"\r\n":"\n";
  return translation.split(/(\r\n|\r|\n)/).map((part,index)=>{
    if(index%2)return part;
    const list=units(part);let result="",start=0,width=0,boundary=-1;
    for(let i=0;i<list.length;i++){
      const unit=list[i];
      if(unit.text==="\\n"||unit.text==="\\r"||/^<br\s*\/?>$/i.test(unit.text)){result+=list.slice(start,i+1).map(u=>u.text).join("");start=i+1;width=0;boundary=-1;continue;}
      if(unit.width>maximum)throw new Error("译文字形宽于原文最长行，请调整换行方式或手动排版");
      if(width+unit.width>maximum){const end=boundary>start?boundary:i;result+=list.slice(start,end).map(u=>u.text).join("")+newline;start=end;i=end-1;width=0;boundary=-1;continue;}
      width+=unit.width;
      const next=list[i+1]?.text||"";
      if((/\s|[，。！？、,.!?;:；：]/u.test(unit.text)||cjk.test(unit.text)&&cjk.test(next))&&!/^[，。！？、,.!?;:；：）】》」』]/u.test(next))boundary=i+1;
    }
    return result+list.slice(start).map(unit=>unit.text).join("");
  }).join("");
}
export function validateGameNaturalLines(source:string,translation:string){
  unityListBlocks(source,translation);
  // Normalize before counting: a single CRLF must never backtrack into two line breaks.
  const count=(text:string)=>text.replace(/\r\n?/g, "\n").replace(gameFormatTokens(), "").trim().split(/\n[\t \u3000]*\n/).filter(part=>part.trim()).length;
  const originalCount = count(source), translatedCount = count(translation);
  if(originalCount!==translatedCount)throw new Error(`模型改变了正文段落数量（原文 ${originalCount} 段，译文 ${translatedCount} 段），请保留空行分段后重试；译文草稿已保留`);
  return translation;
}
