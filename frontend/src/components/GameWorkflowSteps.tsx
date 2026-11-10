import type {ReactNode} from "react";
export type GameWorkflowStep={id:string;number:string;label:ReactNode;state:string;selected:boolean;running?:boolean;paused?:boolean;title?:string;onSelect:()=>void};
export function GameWorkflowSteps({steps,idPrefix,panelId}:{steps:GameWorkflowStep[];idPrefix?:string;panelId?:string}){
 return <nav style={{gridTemplateColumns:`repeat(${steps.length},minmax(0,1fr))`}} className="unity-step-tabs game-workflow-steps" role="tablist" aria-label="处理步骤">{steps.map(item=><button key={item.id} id={idPrefix?`${idPrefix}-${item.id}`:undefined} type="button" role="tab" aria-selected={item.selected} aria-controls={panelId} aria-current={item.running?"step":undefined} title={item.title} className={`unity-step-tab ${item.state}${item.selected?" is-selected":item.running?" is-active-task":""}${item.paused?" is-paused-task":""}`} onClick={item.onSelect}><span className="unity-step-number" aria-hidden="true">{item.number}</span>{item.label}</button>)}</nav>;
}
