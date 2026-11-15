import { useState } from "react";
import { BUILTIN_GAME_PROMPTS, GAME_PROMPT_GROUPS, GAME_PROMPT_SCENES, saveGamePromptCatalog, useGamePromptCatalog, type GamePromptScene } from "../gamePrompts";
import { useGameActionConfirm } from "./GameActionConfirm";

export function GamePromptPoolPanel({notify}:{notify:(message:string,ok?:boolean)=>void}){
  const catalog=useGamePromptCatalog(),[id,setId]=useState("builtin:text");
  const [stepId,setStepId]=useState("text-translate");
  const step=GAME_PROMPT_GROUPS.flatMap(group=>group.steps).find(item=>item.id===stepId)!;
  const current=catalog.find(entry=>entry.id===id);
  const [draft,setDraft]=useState<{name:string;scene:GamePromptScene;prompt:string;tags?:string[]}|null>(null);
  const [tagDraft,setTagDraft]=useState("");
  const confirmation=useGameActionConfirm();
  const value=draft||current||BUILTIN_GAME_PROMPTS[0];
  const commit=()=>{
    if(!draft?.name.trim()||!draft.prompt.trim()){notify("请填写提示词标题和内容",false);return;}
    if(catalog.some(entry=>entry.id!==id&&entry.scene===draft.scene&&entry.name===draft.name.trim())){notify("该场景已存在同名提示词",false);return;}
    const nextId=current&&!current.builtin?id:crypto.randomUUID();
    try{saveGamePromptCatalog([...catalog.filter(entry=>entry.id!==nextId),{...draft,name:draft.name.trim(),id:nextId}]);setId(nextId);setDraft(null);notify("游戏翻译提示词已保存");}catch(error){notify(String(error),false);}
  };
  const remove=async()=>{if(!current||current.builtin||!await confirmation.ask("删除提示词","引用此提示词的步骤需要重新选择。","删除"))return;try{saveGamePromptCatalog(catalog.filter(entry=>entry.id!==id));setId("builtin:"+current.scene);setDraft(null);notify("提示词已删除");}catch(error){notify(String(error),false);}};
  const addTags=()=>{if(!draft)return;const added=tagDraft.split(/[,，;；]/).map(tag=>tag.trim()).filter(Boolean);if(added.length)setDraft({...draft,tags:[...new Set([...(draft.tags||[]),...added])]});setTagDraft("");};
  const selectStep=(stepId:string)=>{if(draft)return;const next=GAME_PROMPT_GROUPS.flatMap(group=>group.steps).find(item=>item.id===stepId)!;setStepId(stepId);if(!current||!next.scenes.includes(current.scene))setId(catalog.find(entry=>next.scenes.includes(entry.scene))?.id||"");};
  return <section className="settings-card game-prompt-pool">{confirmation.dialog}<h2>游戏翻译提示词池</h2><p className="hint">按文本、图片及处理步骤管理提示词。默认提示词由软件提供，点击新增可创建自定义提示词。{'{source}'} 和 {'{target}'} 分别表示原文语言与目标语言。</p>
    <div className="game-prompt-layout"><nav className="game-prompt-tree" aria-label="提示词分类">{GAME_PROMPT_GROUPS.map(group=><details key={group.id} open><summary>{group.name}</summary>{group.steps.map(item=><details key={item.id} open={item.id==="text-translate"}><summary onClick={event=>{if(draft)event.preventDefault();else selectStep(item.id);}}>{item.name}</summary>{catalog.filter(entry=>item.scenes.includes(entry.scene)).map(entry=><button key={entry.id} type="button" disabled={!!draft} className={id===entry.id?"is-selected":""} onClick={()=>{setStepId(item.id);setId(entry.id);}}><span className="game-prompt-item-copy"><strong>{entry.name}</strong>{!!entry.tags?.length&&<span className="game-prompt-tags">{entry.tags.map(tag=><span key={tag}>{tag}</span>)}</span>}</span>{entry.builtin&&<span className="game-prompt-default" data-tooltip="软件提供的默认提示词，可通过新增创建自定义提示词">默认</span>}</button>)}{!item.scenes.length&&<div className="game-prompt-empty">使用本地规则，无需提示词</div>}</details>)}</details>)}</nav>
    <div className="game-prompt-editor"><div className="game-prompt-editor-head"><span>{step.name}</span><button className="settings-panel-save" disabled={!!draft||!step.scenes.length} onClick={()=>{const scene=current?.scene||step.scenes[0];setId("");setTagDraft("");setDraft({name:"",scene,prompt:current?.prompt||BUILTIN_GAME_PROMPTS.find(entry=>entry.scene===scene)!.prompt,tags:[...(current?.tags||BUILTIN_GAME_PROMPTS.find(entry=>entry.scene===scene)!.tags||[])]});}}>新增</button></div>
    {current||draft?<><div className="game-prompt-editor-fields"><label>标题<input aria-label="提示词标题" value={value.name} readOnly={!draft} onChange={event=>setDraft({...value,name:event.target.value})}/></label><label>适用场景<select aria-label="提示词场景" disabled={!draft} value={value.scene} onChange={event=>setDraft({...value,scene:event.target.value as GamePromptScene})}>{step.scenes.map(scene=><option key={scene} value={scene}>{GAME_PROMPT_SCENES[scene]}</option>)}</select></label></div>
    <div className="game-prompt-tag-editor"><span>标签</span><div className="game-prompt-tags">{value.tags?.map(tag=><span key={tag}>{tag}{draft&&<button type="button" aria-label={"移除标签"+tag} onClick={()=>setDraft({...draft,tags:draft.tags?.filter(item=>item!==tag)})}>×</button>}</span>)}</div>{draft&&<div className="game-prompt-tag-add"><input aria-label="新增标签" value={tagDraft} placeholder="输入自定义标签，回车添加" onChange={event=>setTagDraft(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();addTags();}}}/><button type="button" className="settings-panel-cancel" onClick={addTags}>添加标签</button></div>}</div>
    <label className="game-prompt-editor-body">提示词内容<textarea aria-label="提示词内容" rows={8} value={value.prompt} readOnly={!draft} onChange={event=>setDraft({...value,prompt:event.target.value})}/></label>
    <div className="game-prompt-editor-actions">{draft?<><button className="settings-panel-save" onClick={commit}>保存</button><button className="settings-panel-cancel" onClick={()=>{setDraft(null);setTagDraft("");if(!current)setId("builtin:"+step.scenes[0]);}}>取消</button></>:<><button className="settings-panel-save" disabled={current?.builtin} onClick={()=>{setTagDraft("");setDraft({name:value.name,scene:value.scene,prompt:value.prompt,tags:value.tags});}}>编辑</button><button className="settings-panel-delete" disabled={current?.builtin} onClick={()=>void remove()}>删除</button></>}</div></>:<p className="game-prompt-empty">{step.scenes.length?"此步骤尚无提示词，可点击新增。":"此步骤使用本地规则进行筛选。"}</p>}
    </div></div>
  </section>;
}
