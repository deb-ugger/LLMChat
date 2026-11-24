import { GameConcurrencyDraft } from "./GameFlowSequence";
import { modelConcurrency } from "../gameModelPerformance";
import { recommendedGameModels } from "../gameModelPreset";
import { ModelFilterSelect, readModelFilter } from "./ModelFilterSelect";
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
  const concurrencyId = unset + "-concurrency";
  const prompts = useGamePromptCatalog().filter(entry => entry.scene === promptKey);
  const context = useContext(GamePromptContext);
  const drafts = useContext(GameConcurrencyDraft);
  const concurrency = drafts?.value(promptKey, value) ?? modelConcurrency(context?.scope || "game", promptKey, value);
  const promptId = context?.selection[promptKey] || "builtin:" + promptKey;
  useEffect(()=>{if(value||optional||disabled)return;const preset=recommendedGameModels(),candidate=promptKey==="recognize"||promptKey==="screen"?preset?.vision||models.find(model=>/^qwen3-vl:4b-instruct$/i.test(model)):promptKey==="review"?preset?.review:promptKey==="names"?preset?.names:promptKey==="dialogue"?preset?.dialogue:preset?.text;if(candidate&&models.includes(candidate))onChange(candidate);},[value,optional,disabled,models,promptKey,onChange]);
  const scope = context?.scope || "game";
  return <div className="game-model-prompt-row">
    <div className="game-model-column">
      <div className="game-model-head">
        <span>{label}</span>
        <label htmlFor={concurrencyId}>并发</label>
      </div>
      <div className="game-model-controls">
        <div className="game-model-filter">
          <ModelFilterSelect key={scope + ":" + promptKey} label={label} value={value} models={models}
            disabled={disabled} optionalValue={optional ? unset : undefined}
            filter={drafts?.filter(promptKey) ?? readModelFilter(scope + ":" + promptKey)}
            setFilter={filter => drafts?.updateFilter(promptKey, filter)}
            onChange={model => onChange(model === unset ? "" : model)} />
        </div>
        <select id={concurrencyId} aria-label={label + "并发数"} data-tooltip="并发请求数（1–4）。使用 Ollama 时，修改后重启服务。"
          className="game-model-concurrency-control" disabled={disabled || !value || !drafts} value={concurrency}
          onChange={event => drafts?.update({ role: promptKey, model: value, count: Number(event.target.value) })}>
          {[1, 2, 3, 4].map(count => <option key={count} value={count}>{count}</option>)}
        </select>
      </div>
    </div>
    <label>提示词
    <SearchableSelect aria-label={label + "提示词"} value={promptId} disabled={disabled || !context}
      placeholder="请选择提示词" optionTags={Object.fromEntries(prompts.map(entry => [entry.id, entry.tags]))}
      onChange={event => context?.select(promptKey, event.target.value)}>
      {prompts.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
    </SearchableSelect>
  </label></div>;
}
