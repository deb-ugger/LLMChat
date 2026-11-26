import type { ReactNode } from "react";
import { GameFlowParameterGroup } from "./GameFlowCard";

export function GameTextParameters({ step, method, languages, models, modelTitle, wrapping, switches, help }: {
  step: "screen" | "translate"; method: ReactNode; languages: ReactNode; models?: ReactNode;
  modelTitle?: string; wrapping?: ReactNode; switches: ReactNode; help?: ReactNode;
}) {
  return <div className="game-text-parameters" data-text-step={step}>
    {step === "screen" ? <div className="game-text-screen-fields game-flow-group-fields">{method}{languages}</div>
      : <div className="game-text-method">{method}</div>}
    {models && <GameFlowParameterGroup kind="models" title={modelTitle || (step === "screen" ? "模型" : "每类模型")}>
      {models}
    </GameFlowParameterGroup>}
    {step === "translate" && <GameFlowParameterGroup kind="scope" title="语言与换行">
      {languages}{wrapping}
    </GameFlowParameterGroup>}
    <GameFlowParameterGroup kind="runtime"><div className="game-flow-group-fields"><div className="game-flow-chip-row">{switches}</div></div></GameFlowParameterGroup>
    {help && <GameFlowParameterGroup kind="help">{help}</GameFlowParameterGroup>}
  </div>;
}
