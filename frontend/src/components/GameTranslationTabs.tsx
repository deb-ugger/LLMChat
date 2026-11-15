import { recommendedGameModels } from "../gameModelPreset";
import { ModelFilterSelect } from "./ModelFilterSelect";
import { GamePromptContext, useGamePromptCatalog, type GamePromptScene } from "../gamePrompts";
import { useContext, useEffect, useId, type ReactNode } from "react";
import { currentEffectivePresets, loadLocalModelProfiles, loadVendorProfiles, resolveFeatureLlm } from "../modelPresets";
import type { Settings } from "../api";
import type { GameTranslationKind } from "../unityTranslation";
import { SearchableSelect } from "./SearchableSelect";

export function GameTranslationTabs({ kind, disabled, onChange, children }: {
  kind: GameTranslationKind; disabled: boolean; onChange: (kind: GameTranslationKind) => void; children: ReactNode;
}) {
  return <GameMethodTabs label="翻译方式" localLabel="翻译引擎" model={kind !== "engine"} disabled={disabled}
    onChange={model => onChange(model ? "llm" : "engine")}>{children}</GameMethodTabs>;
}

export function GameProcessingTabs({ label, localLabel, value, disabled, onChange, children }: {
  label: string; localLabel: string; value: "local" | "llm"; disabled: boolean;
  onChange: (value: "local" | "llm") => void; children: ReactNode;
}) {
  return <GameMethodTabs label={label} localLabel={localLabel} model={value === "llm"} disabled={disabled}
    onChange={model => onChange(model ? "llm" : "local")}>{children}</GameMethodTabs>;
}

function GameMethodTabs({ label, localLabel, model, disabled, onChange, children }: {
  label: string; localLabel: string; model: boolean; disabled: boolean;
  onChange: (model: boolean) => void; children: ReactNode;
}) {
  const id = useId();
  const selected = model ? "llm" : "local";
  return <>
    <div className="game-translation-tabs" role="tablist" aria-label={label}>
      {(["local", "llm"] as const).map(value => <button key={value} type="button" role="tab"
        id={id + value} aria-controls={id + "panel"} aria-selected={selected === value} disabled={disabled}
        onClick={() => { if (value !== selected) onChange(value === "llm"); }}>
        {value === "local" ? localLabel : "大模型"}
      </button>)}
    </div>
    <div className="game-translation-page" id={id + "panel"} role="tabpanel" aria-labelledby={id + selected}>{children}</div>
  </>;
}

export function gameAvailableModels(settings: Settings) {
  const locals = loadLocalModelProfiles(), vendors = loadVendorProfiles(), presets = currentEffectivePresets();
  return [...new Set([settings.model, ...presets.map(preset => preset.model), ...Object.keys(locals)])].filter(model => {
    if (!model) return false;
    const connection = resolveFeatureLlm(settings, model, locals, vendors, presets);
    return !!connection.apiUrl.trim() && (!presets.some(preset => preset.model === model) || !!connection.apiKey.trim());
  });
}

export function GameModelSelect({ label, value, models, disabled, onChange, optional = false, promptKey = "text" }: {
  label: string; value: string; models: string[]; disabled: boolean; onChange: (model: string) => void; optional?: boolean; promptKey?: GamePromptScene;
}) {
  const unset = useId();
  const prompts=useGamePromptCatalog(),context=useContext(GamePromptContext);
  useEffect(()=>{if(value||optional||disabled)return;const preset=recommendedGameModels(),candidate=promptKey==="recognize"||promptKey==="screen"?preset?.vision||models.find(model=>/^qwen3-vl:4b-instruct$/i.test(model)):promptKey==="review"?preset?.review:promptKey==="names"?preset?.names:promptKey==="dialogue"?preset?.dialogue:preset?.text;if(candidate&&models.includes(candidate))onChange(candidate);},[value,optional,disabled,models,promptKey,onChange]);
  return <div className="game-model-prompt-row"><div className="game-model-column"><span>{label}</span><ModelFilterSelect key={(context?.scope||"game")+":"+promptKey} label={label} value={value} models={models} disabled={disabled} optionalValue={optional?unset:undefined} filterKey={(context?.scope||"game")+":"+promptKey} onChange={value=>onChange(value===unset?"":value)}/></div><label>提示词<SearchableSelect aria-label={label+"提示词"} value={context?.selection[promptKey]||"builtin:"+promptKey} disabled={disabled||!context} placeholder="请选择提示词" onChange={event=>context?.select(promptKey,event.target.value)}>{prompts.filter(entry=>entry.scene===promptKey).map(entry=><option key={entry.id} value={entry.id}>{entry.name}{entry.tags?.length?" · "+entry.tags.join(" / "):""}</option>)}</SearchableSelect></label></div>;
}
