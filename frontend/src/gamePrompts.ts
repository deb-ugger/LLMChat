import { rememberPromptSelection } from "./gameModelPerformance";
import { createContext, useMemo, useSyncExternalStore } from "react";

export const GAME_PROMPT_SCENES = { textScreen: "文本筛选", text: "正文翻译", dialogue: "对白翻译", names: "姓名统一", image: "图片文字翻译", screen: "图片筛选", refine: "图片复筛", recognize: "识字与定位", review: "校验失败重译", layout: "译图断行排版", line: "文本断行辅助" } as const;
export type GamePromptScene = keyof typeof GAME_PROMPT_SCENES;
export const GAME_PROMPT_GROUPS: {id:string;name:string;steps:{id:string;name:string;scenes:GamePromptScene[]}[]}[] = [
  {id:"text",name:"文本",steps:[{id:"text-screen",name:"筛选文本",scenes:["textScreen"]},{id:"text-translate",name:"翻译正文",scenes:["names","text","dialogue","line"]}]},
  {id:"images",name:"图片",steps:[{id:"image-screen",name:"筛选图片",scenes:["screen"]},{id:"image-refine",name:"复筛图片",scenes:["refine"]},{id:"image-recognize",name:"识字与定位",scenes:["recognize"]},{id:"image-translate",name:"翻译图片文字",scenes:["image"]},{id:"image-review",name:"复核与重译",scenes:["review"]},{id:"image-layout",name:"生成译图",scenes:["layout"]}]},
];
export type GamePrompt = { id: string; name: string; scene: GamePromptScene; prompt: string; builtin?: boolean; tags?:string[] };
export type GamePromptSelection = Partial<Record<GamePromptScene, string>>;
const defaults: Record<GamePromptScene,string> = {
  textScreen: "判断游戏原文是否已经完整使用目标语言。只有明确无需翻译时才判定为保留，混合语言、仅有共用汉字或无法确认的内容继续翻译。",
  text: "将游戏文本从{source}翻译为{target}。完整理解上下文，准确保留事实、人物关系和语气，不删减、不增加解释。已符合目标语言的片段原样保留，术语和人物译名保持一致。",
  dialogue: "将游戏对白从{source}翻译为{target}。结合说话人和上下文理解省略、指代、敬语、情绪及人物关系，表达自然、口语化；保留人物个性和原文含义，不自行弱化或扩写内容，沿用已有译名。",
  names: "将游戏人物姓名或称呼从{source}译为{target}。依据上下文区分姓名、绰号和身份称呼，优先沿用给定术语及已有译名；不将身份称呼误译为亲属关系，不附加解释，只返回一个译名。",
  image: "将图片中识别出的游戏文字从{source}翻译为{target}。兼顾完整含义和界面空间，使用简洁自然的表达，保留数值、等级、快捷键和人物译名，不凭空补全未识别内容。",
  screen: "逐一检查图片中的可读文字并给出位置。不要将纹理、图案或装饰误识别为文字，不猜测无法辨认的内容；文字不是目标语言也应如实识别，不翻译。",
  refine: "判断图片是否存在真实可读文字。忽略装饰、衣物纹理和重复图案，不猜测模糊内容，不抄录文字。",
  recognize: "准确抄录图片中的全部可读文字并标出各区域位置。保留原语言、标点和有意义的换行，区分正文、按钮、标题与姓名；不要翻译、改写或凭空补字。",
  review: "将校验失败的游戏原文从{source}重新翻译为{target}。重新理解上下文，完整保留正文、说话人、数值及术语，不重复错误结果，不输出原因分析或修正说明。",
  layout: "为游戏译文规划自然断行。结合区域宽高，优先在标点或完整词语之间断行，避免拆开姓名、数字与单位；只能改变换行，其他字符包括空格和标点必须保持原样。",
  line: "结合游戏原文和译文语义选择自然断点。优先保留完整词语、姓名、数字与单位，不跨越段落或列表边界，只选择程序提供的合法断点，不改动译文。",
};
const generalPrompts: GamePrompt[] = (Object.keys(defaults) as GamePromptScene[]).map(scene => ({id:"builtin:"+scene,name:GAME_PROMPT_SCENES[scene],scene,prompt:defaults[scene],builtin:true,tags:({textScreen:["文本","筛选"],text:["游戏","正文"],dialogue:["对白","语气"],names:["姓名","术语"],image:["图片","翻译"],screen:["图片","筛选"],refine:["图片","复筛"],recognize:["图片","OCR"],review:["校验","重译"],layout:["排版","换行"],line:["文本","断行"]} as Record<GamePromptScene,string[]>)[scene]}));

const gameLocales = [
  { id: "en", label: "英语", guidance: "结合上下文辨认俚语、双关和反讽。按说话人的身份译出称呼，避免逐词直译习语。" },
  { id: "ja", label: "日语", guidance: "结合场景补足可确定的省略主语，保留敬语、称谓和语气差异，避免把音译称呼误认成人物本名。" },
  { id: "ko", label: "韩语", guidance: "按人物关系处理敬语、半语和称谓。根据已知译名判断汉字姓名，缺少依据时使用一致的音译。" },
] as const;
const adultGameScenes = {
  text: "完整保留剧情、人物关系、任务条件和界面术语，叙述自然。",
  dialogue: "保留人物口吻、停顿、情绪和言外之意，使用自然的中文口语。",
  image: "使用适合按钮、标题和提示框的简洁措辞，精确保留数字、等级与快捷键。",
  review: "重新核对人名、否定、数值和控制符，修正漏译及语义错误，只输出最终译文。",
} satisfies Partial<Record<GamePromptScene, string>>;
const localizedPrompts: GamePrompt[] = gameLocales.flatMap(locale =>
  (Object.entries(adultGameScenes) as [GamePromptScene, string][]).map(([scene, guidance]) => ({
    id: `builtin:${locale.id}-zh-cn-r18:${scene}`,
    name: `${locale.label} → 简体中文 · ${GAME_PROMPT_SCENES[scene]}`,
    scene,
    builtin: true,
    tags: ["R18", locale.label, "简体中文"],
    prompt: `将面向成年玩家的${locale.label}游戏原文译为简体中文。按原有叙事和语域忠实翻译，保留原文信息，不补写情节，不揣测未明确的人物关系。

${locale.guidance}${guidance}

使用术语表和已有译名。保留占位符、控制符、富文本标签、分页符和有意义的段落。只输出译文。`,
  })),
);
export const BUILTIN_GAME_PROMPTS = [...generalPrompts, ...localizedPrompts];

const catalogKey = "llmchat-game-prompt-pool", eventName = "llmchat-game-prompts-changed";
const subscribe = (listener:()=>void) => { window.addEventListener(eventName,listener);window.addEventListener("storage",listener);return()=>{window.removeEventListener(eventName,listener);window.removeEventListener("storage",listener);}; };
function readGamePromptCatalog(raw: string): GamePrompt[] {
  const saved = new Map((JSON.parse(raw) as GamePrompt[]).map(entry => [entry.id, entry]));
  const builtins = BUILTIN_GAME_PROMPTS.map(entry => {
    const override = saved.get(entry.id);
    saved.delete(entry.id);
    return override ? { ...entry, name: override.name, tags: override.tags, prompt: override.prompt } : entry;
  });
  return [...builtins, ...saved.values()];
}
export function gamePromptCatalog() {
  return readGamePromptCatalog(localStorage.getItem(catalogKey) || "[]");
}
export function saveGamePromptCatalog(entries: GamePrompt[]) {
  const defaultsById = new Map(BUILTIN_GAME_PROMPTS.map(entry => [entry.id, entry]));
  const saved = entries.filter(entry => {
    const original = defaultsById.get(entry.id);
    return !original || entry.name !== original.name || entry.prompt !== original.prompt ||
      JSON.stringify(entry.tags || []) !== JSON.stringify(original.tags || []);
  });
  localStorage.setItem(catalogKey, JSON.stringify(saved));
  window.dispatchEvent(new Event(eventName));
}
export function useGamePromptCatalog() {
  const raw = useSyncExternalStore(subscribe, () => localStorage.getItem(catalogKey) || "[]");
  return useMemo(() => readGamePromptCatalog(raw), [raw]);
}
export function useGamePromptSelection(scope: string) {
  const key="llmchat-game-prompt-selection:"+scope,raw=useSyncExternalStore(subscribe,()=>localStorage.getItem(key)||"{}");
  const selection=useMemo(()=>JSON.parse(raw) as GamePromptSelection,[raw]);
  rememberPromptSelection(selection, scope);
  return {scope,selection,select:(scene:GamePromptScene,id:string)=>{
    const current = JSON.parse(localStorage.getItem(key) || "{}") as GamePromptSelection;
    if ((current[scene] || "builtin:" + scene) === id) return;
    localStorage.setItem(key, JSON.stringify({ ...current, [scene]: id }));
    window.dispatchEvent(new Event(eventName));
  }};
}
export const GamePromptContext = createContext<{scope?:string;selection:GamePromptSelection;select:(scene:GamePromptScene,id:string)=>void}|null>(null);
export function gameTaskPrompt(scene:GamePromptScene,selection?:GamePromptSelection,variables:{source?:string;target?:string}={}) {
  const id=selection?.[scene]||"builtin:"+scene,entry=gamePromptCatalog().find(item=>item.id===id&&item.scene===scene);
  if(!entry)throw new Error(`${GAME_PROMPT_SCENES[scene]}提示词已删除，请重新选择`);
  const prompt = entry.prompt.replace(/\{(source|target)\}/g,(_,key:"source"|"target")=>variables[key]||(key==="source"?"原文语言":"目标语言"));
  return scene === "text" || scene === "dialogue"
    ? prompt + "\n保留动作发出者和承受者的关系；原文省略主语且无法确定时，译文也不补主语。不要把已保留的译名或术语再翻译一遍，也不要抄写参考语境。"
    : prompt;
}
