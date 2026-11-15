import { GameDialog } from "./GameActionConfirm";
export type UnityExitChoice = "save" | "discard" | "cancel";
export function UnityExitDialog({running,projectOnly,changes,onChoice}:{running:boolean;projectOnly:boolean;changes:string[];onChoice:(choice:UnityExitChoice)=>void}) {
 return <GameDialog title={projectOnly?"离开当前工程":"退出 LLMChat"} description={running?"退出前将中止任务并保存已完成进度。请选择如何处理当前修改。":"当前修改尚未保存，请选择退出方式。"} onCancel={()=>onChoice("cancel")} details={changes.length>0?<><strong>尚未保存的内容</strong><ul>{changes.slice(0,10).map((text,index)=><li key={index}>{text}</li>)}</ul>{changes.length>10&&<p>另有 {changes.length-10} 项修改</p>}</>:undefined}>
  <button className="game-confirm-cancel" autoFocus onClick={()=>onChoice("cancel")}>返回</button><button className="game-confirm-accept" onClick={()=>onChoice("discard")}>不保存退出</button><button className="game-confirm-primary" onClick={()=>onChoice("save")}>保存后退出</button>
 </GameDialog>;
}
