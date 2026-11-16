import { useState } from "react";
import { loadLlmRuntime } from "../llmRuntime";
import { showAppNotice } from "./AppNotice";

export function LlmRuntimeSettings() {
  const [value, setValue] = useState(loadLlmRuntime);
  const [saved, setSaved] = useState(value);
  const dirty = value.maxOutputTokens !== saved.maxOutputTokens || value.batchInputTokens !== saved.batchInputTokens;
  return <section className="settings-card game-context-settings">
    <h2>大模型生成</h2>
    <p className="hint">输出填 0 使用服务默认。输出上限包含思考；合批输入需为输出预留上下文空间，下次请求生效。</p>
    <form className="game-context-controls" onSubmit={event => { event.preventDefault(); if(!Number.isInteger(value.maxOutputTokens)||value.maxOutputTokens<0||value.maxOutputTokens>1048576||!Number.isInteger(value.batchInputTokens)||value.batchInputTokens<512||value.batchInputTokens>32768){showAppNotice("请输入有效的 token 上限","error");return;}localStorage.setItem("llmchat-llm-runtime",JSON.stringify(value));setSaved(value);showAppNotice("生成设置已保存","success"); }}>
      <fieldset className="game-context-direction" style={{gridTemplateColumns:"minmax(0, 1fr)"}}>
        <legend>输出上限</legend>
        <label>最大输出（token）<input type="number" min={0} max={1048576} step={1} required value={value.maxOutputTokens}
          data-tooltip="单次请求的最大输出量；过低可能截断译文。0 表示沿用服务默认。"
          onChange={event => setValue({...value, maxOutputTokens:Number(event.target.value)})}/></label>
      </fieldset>
      <fieldset className="game-context-direction" style={{gridTemplateColumns:"minmax(0, 1fr)"}}>
        <legend>输入预算</legend>
        <label>合批输入（token）<input type="number" min={512} max={32768} step={1} required value={value.batchInputTokens}
          data-tooltip="合并多条文本时的估算输入预算，包含提示词和上下文；不会裁剪单条原文。"
          onChange={event => setValue({...value, batchInputTokens:Number(event.target.value)})}/></label>
      </fieldset>
      <button className="settings-panel-save" disabled={!dirty}>保存生成设置</button>
    </form>
  </section>;
}
