import { normalizeMosaicSettings } from "../gameMosaic";
import { useMemo, useState, type ReactNode } from "react";
import type { GameConfigurationSetup } from "../gameAuxWindows";
import { GAME_PROMPT_SCENES, useGamePromptCatalog, type GamePromptScene } from "../gamePrompts";
import { builtinGameTestConfigurations, defaultGameTestConfiguration, listGameTestOllamaModels, readGameTestConfigurations, saveGameTestConfigurations,
  type GameTestConfiguration, type GameTestRole, type GameTestTextOptions, type SavedGameTestConfiguration } from "../gameModelPreset";
import { UNITY_LANGUAGES } from "../unityTranslation";
import { OCR_MODE_OPTIONS } from "../ocr/modes";
import { classicEngines, getEngineInfo } from "../translateEngines";
import type { UnityEngineChoice } from "../unityEnginePool";
import { showAppNotice } from "./AppNotice";

type Choice<T extends string> = { value: T; label: string };
const languageChoices = [{ value: "auto", label: "自动检测" }, ...UNITY_LANGUAGES];
const ocrChoices = OCR_MODE_OPTIONS.map(mode => ({ value: mode.id, label: `${mode.title} · ${mode.recognitionModel}` }));
const lanes = [1, 2, 3, 4, 6, 8];
const translationChoices = [{ value: "llm", label: "大模型" }, { value: "engine", label: "翻译引擎" }] as const;

function Select<T extends string>({ label, accessibleLabel, value, choices, change }: {
  label: string; accessibleLabel?: string; value: T; choices: readonly Choice<T>[]; change: (value: T) => void;
}) {
  return <label>{label}<select aria-label={accessibleLabel} value={value} onChange={event => change(event.target.value as T)}>
    {!choices.some(choice => choice.value === value) && <option value={value}>{value}</option>}
    {choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
  </select></label>;
}

function Count({ label, accessibleLabel, value, choices, change }: {
  label: string; accessibleLabel?: string; value: number; choices: number[]; change: (value: number) => void;
}) {
  return <Select label={label} accessibleLabel={accessibleLabel} value={String(value)}
    choices={[...new Set([...choices, value])].map(count => ({ value: String(count), label: String(count) }))} change={count => change(Number(count))} />;
}

function Flag({ label, value, change }: { label: string; value: boolean; change: (value: boolean) => void }) {
  return <label className="unity-inline-check"><input type="checkbox" checked={value} onChange={event => change(event.target.checked)} />{label}</label>;
}

const Group = ({ title, children, fieldsClass }: { title: string; children: ReactNode; fieldsClass?: string }) => <fieldset className="game-test-group">
  <legend>{title}</legend><div className={fieldsClass ? `game-test-fields ${fieldsClass}` : "game-test-fields"}>{children}</div>
</fieldset>;

type LanguageSettings = Pick<GameTestTextOptions, "source" | "target" | "onlySourceLanguage" | "skipTargetLanguage">;
function Languages({ value, change }: { value: LanguageSettings; change: (value: Partial<LanguageSettings>) => void }) {
  return <>
    <Select label="原文语言" value={value.source} choices={languageChoices} change={source => change({ source })} />
    <Select label="目标语言" value={value.target} choices={UNITY_LANGUAGES} change={target => change({ target })} />
    <Flag label="仅翻译原语言" value={value.onlySourceLanguage !== false} change={onlySourceLanguage => change({ onlySourceLanguage })} />
    <Flag label="跳过目标语言" value={value.skipTargetLanguage !== false} change={skipTargetLanguage => change({ skipTargetLanguage })} />
  </>;
}

function Engines({ value, change }: { value: UnityEngineChoice[]; change: (value: UnityEngineChoice[]) => void }) {
  return <div className="game-test-engines">{classicEngines().map(engine => <Flag key={engine.id} label={getEngineInfo(engine.id)!.label} value={value.some(choice => choice.id === engine.id && choice.enabled)}
    change={enabled => change(value.some(choice => choice.id === engine.id) ? value.map(choice => choice.id === engine.id ? { ...choice, enabled } : choice) : [...value, { id: engine.id, enabled }])} />)}</div>;
}

export function GameTestConfigurations({ setup, capture, onApply, onClose }: {
  setup: GameConfigurationSetup; capture: () => Promise<GameTestConfiguration>;
  onApply: (row: SavedGameTestConfiguration) => Promise<void>; onClose: () => void;
}) {
  const [rows, setRows] = useState(() => readGameTestConfigurations(setup.scope));
  const presets = useMemo(() => builtinGameTestConfigurations(setup.current), [setup.current]);
  const [draft, setDraft] = useState(() => presets[0]);
  const [part, setPart] = useState(setup.initialPart);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const prompts = useGamePromptCatalog();
  const value = draft?.value;
  const models = [...new Set([...setup.models, ...ollamaModels])].sort();
  const modelChoices = models.map(model => ({ value: model, label: model }));
  const run = async (action: () => Promise<void>) => {
    setWorking(true);
    try { await action(); }
    catch (error) { showAppNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setWorking(false); }
  };
  const newConfiguration = (value: SavedGameTestConfiguration["value"]) => {
    let counter = 1;
    while (rows.some(row => row.name === `配置单 ${counter}`)) counter++;
    return { id: crypto.randomUUID(), name: `配置单 ${counter}`, value };
  };
  const create = () => void run(async () => {
    setDraft(newConfiguration(await capture()));
    setPart(setup.initialPart);
  });
  const save = (row: SavedGameTestConfiguration) => {
    const latest = readGameTestConfigurations(setup.scope);
    const next = latest.some(saved => saved.id === row.id) ? latest.map(saved => saved.id === row.id ? row : saved) : [...latest, row];
    saveGameTestConfigurations(setup.scope, next);
    setRows(next); setDraft(row);
  };
  const updateValue = (next: NonNullable<typeof value>) => setDraft(previous =>
    presets.some(preset => preset.id === previous.id) ? newConfiguration(next) : { ...previous, value: next });
  const text = value?.text, images = value?.images;
  const updateText = (patch: Partial<GameTestTextOptions>) => { if (value && text) updateValue({ ...value, text: { ...text, options: { ...text.options, ...patch } } }); };
  const updateImages = (patch: Partial<NonNullable<typeof images>["options"]>) => { if (value && images) updateValue({ ...value, images: { ...images, options: { ...images.options, ...patch } } }); };
  const mosaic = images?.options.mosaic && normalizeMosaicSettings(images.options.mosaic);
  const updateMosaic = (patch: Partial<NonNullable<typeof mosaic>>) => {
    if (mosaic) updateImages({ mosaic: { ...mosaic, ...patch } });
  };
  const updateRole = (where: "text" | "images", scene: GamePromptScene, patch: Partial<GameTestRole>) => {
    const current = value?.[where];
    const role = current?.roles[scene];
    if (value && current && role) updateValue({ ...value, [where]: { ...current, roles: { ...current.roles, [scene]: { ...role, ...patch } } } });
  };
  const roleFields = (where: "text" | "images", scene: GamePromptScene, label: string, follow = "请选择模型", method?: ReactNode) => {
    const role = value?.[where]?.roles[scene];
    return role && <div className={method ? "game-test-role has-method" : "game-test-role"}>
      {method}
      <Select label={label} value={role.model || ""} choices={[{ value: "", label: follow }, ...modelChoices]} change={model => updateRole(where, scene, { model })} />
      <Select label="提示词" accessibleLabel={`${label}提示词`} value={role.prompt} choices={prompts.filter(prompt => prompt.scene === scene).map(prompt => ({ value: prompt.id, label: prompt.name }))} change={prompt => updateRole(where, scene, { prompt })} />
      <Count label="并发" accessibleLabel={`${label}并发`} value={role.concurrency} choices={[1, 2, 3, 4]} change={concurrency => updateRole(where, scene, { concurrency })} />
    </div>;
  };
  const toggleModel = (where: "text" | "images", scene: GamePromptScene, label: string, local: string) => {
    const localMethod = value?.[where]?.roles[scene]?.model === undefined;
    const method = <Select label={label} value={localMethod ? "local" : "llm"}
      choices={[{ value: "local", label: local }, { value: "llm", label: "大模型" }]}
      change={method => updateRole(where, scene, { model: method === "local" ? undefined : "" })} />;
    return localMethod ? method : roleFields(where, scene, `${GAME_PROMPT_SCENES[scene]}模型`, "请选择模型", method);
  };
  const textOptions = text?.options, imageOptions = images?.options;
  const imageTranslation = imageOptions?.translation;
  const refine = imageOptions?.refine;
  const builtIn = presets.some(preset => preset.id === draft.id);
  const edited = !builtIn && !rows.some(row => row.id === draft.id);
  const duplicateName = !builtIn && rows.some(row => row.id !== draft.id && row.name === draft.name.trim());
  const named = draft.name.trim() && !duplicateName ? { ...draft, name: draft.name.trim() } : undefined;
  return <main className="game-test-page" aria-label="测试配置">
    <header className="game-test-toolbar">
    <div className="game-test-picker">
      <label>配置单<select disabled={working} value={draft.id} onChange={event => {
        const row = [...presets, ...rows].find(row => row.id === event.target.value);
        if (row) setDraft(row);
      }}>
        {presets.map(preset => <option value={preset.id} key={preset.id}>{preset.name}（内置）</option>)}
        {edited && <option value={draft.id}>{draft.name || "新配置单"}（草稿）</option>}
        {rows.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}
      </select></label>
      <button type="button" className="unity-btn" disabled={working} onClick={create}>新增配置单</button>
      <button type="button" className="unity-btn" disabled={working} onClick={() => void run(async () => { const installed = await listGameTestOllamaModels(); setOllamaModels(installed); showAppNotice(`已读取 ${installed.length} 个 Ollama 模型`); })}>读取 Ollama 模型</button>
      {!builtIn && <button type="button" className="unity-btn" disabled={working} onClick={() => updateValue(defaultGameTestConfiguration(value))}>填入默认配置</button>}
      {!builtIn && <label>名称<input value={draft.name} disabled={working} maxLength={80} aria-invalid={duplicateName}
        onChange={event => setDraft({ ...draft, name: event.target.value })} />{duplicateName && <small role="alert">已存在同名配置单</small>}</label>}
    </div>
    {images && <div className="game-test-tabs" role="group" aria-label="配置步骤">
      <button type="button" className="unity-btn" disabled={working} aria-pressed={part === "text"} onClick={() => setPart("text")}>文本翻译</button>
      <button type="button" className="unity-btn" disabled={working} aria-pressed={part === "images"} onClick={() => setPart("images")}>图片翻译</button>
    </div>}
    </header>
    <div className="game-test-scroll">
    <fieldset className="game-test-editor" disabled={working}><div className="game-test-groups">
      {(part === "text" || !images) && <>
        <Group title={imageOptions && !imageTranslation ? "文本与图片共用设置" : "语言与方式"}>
          <Languages value={textOptions} change={updateText} />
          <Select label="翻译方式" value={textOptions.kind === "engine" ? "engine" : "llm"} choices={translationChoices} change={kind => updateText({ kind })} />
          {textOptions.kind === "engine" && <Engines value={textOptions.engines} change={engines => updateText({ engines })} />}
        </Group>
        <Group title="筛选文本">{toggleModel("text", "textScreen", "筛选方式", "按语言规则筛选")}</Group>
        <Group title="翻译正文">
          {textOptions.kind !== "engine" && <>
            {roleFields("text", "text", "常规模型")}
            {roleFields("text", "dialogue", "对白模型", "跟随常规模型")}
            {roleFields("text", "names", "术语模型", "跟随常规模型")}
            <Flag label="附带上下文" value={!!textOptions.includeContext} change={includeContext => updateText({ includeContext })} />
          </>}
          <Select label="换行处理" value={textOptions.wrapMode || (textOptions.joinLines ? "join" : "keep")}
            choices={[{ value: "join", label: "合并翻译后恢复换行" }, { value: "keep", label: "保留换行翻译" }, ...(textOptions.kind === "engine" ? [] : [{ value: "natural", label: "大模型自然断行" }] as const)]}
            change={wrapMode => updateText({ wrapMode, joinLines: wrapMode !== "keep" })} />
          {textOptions.lineMode && textOptions.joinLines && textOptions.wrapMode !== "natural" && <>
            <Select label="断行方式" value={textOptions.lineMode} choices={[{ value: "local", label: "本地智能断行" }, { value: "ratio", label: "按比例断行" }, { value: "wtp", label: "WtP 断句" }, { value: "model", label: "大模型断行" }]} change={lineMode => updateText({ lineMode })} />
            {textOptions.lineMode === "model" && roleFields("text", "line", GAME_PROMPT_SCENES.line, "跟随通用模型")}
          </>}
        </Group>
      </>}
      {part === "images" && imageOptions && <>
        {imageOptions.strategy && <Group title="筛选图片">
          {toggleModel("images", "screen", "筛选方式", "本地筛选")}
          {images.roles.screen?.model === undefined && <Select label="本地筛选策略" value={imageOptions.strategy} choices={[{ value: "staged", label: "分级快速筛选" }, { value: "full", label: "完整范围筛选" }]} change={strategy => updateImages({ strategy })} />}
        </Group>}
        {refine && <Group title="复筛图片" fieldsClass={refine.method === "local" ? "game-test-refine-fields" : undefined}>
          <Select label="复筛方式" value={refine.method} choices={[{ value: "off", label: "关闭" }, { value: "local", label: "本地 OCR" }, { value: "llm", label: "视觉模型" }]} change={method => updateImages({ refine: { ...refine, method } })} />
          {refine.method === "llm" && <>{roleFields("images", "refine", "复筛模型")}<label>复筛置信度阈值<input type="number" min={0} max={100} value={refine.confidence} onChange={event => updateImages({ refine: { ...refine, confidence: Math.max(0, Math.min(100, Number(event.target.value))) } })} /></label></>}
          {refine.method === "local" && <><Select label="本地复筛模型" value={refine.mode} choices={ocrChoices.filter(choice => choice.value !== "manga")} change={mode => updateImages({ refine: { ...refine, mode: mode === "manga" ? "precise" : mode } })} />
            <Count label="复筛并发" value={refine.concurrency} choices={lanes} change={concurrency => updateImages({ refine: { ...refine, concurrency } })} /></>}
        </Group>}
        <Group title="识字与定位">
          {toggleModel("images", "recognize", "识字方式", "本地 OCR")}
          {images.roles.recognize?.model === undefined && <><Select label="本地 OCR" value={imageOptions.mode} choices={ocrChoices} change={mode => updateImages({ mode })} />
            <Count label="识字并发" value={imageOptions.concurrency} choices={lanes} change={concurrency => updateImages({ concurrency })} /></>}
          <div className="game-test-options">
            {images.roles.recognize?.model !== undefined && <Flag label="用 Manga OCR 复读日文竖排" value={imageOptions.mode === "manga"}
              change={enabled => updateImages({ mode: enabled ? "manga" : "precise" })} />}
            {imageOptions.confidence !== undefined && <label>翻译置信度阈值<input type="number" min={0} max={100} value={imageOptions.confidence} onChange={event => updateImages({ confidence: Math.max(0, Math.min(100, Number(event.target.value))) })} /></label>}
          </div>
        </Group>
        <Group title="翻译图片文字">
          {imageTranslation && <><Languages value={imageTranslation} change={patch => updateImages({ translation: { ...imageTranslation, ...patch } })} />
            <Select label="翻译方式" value={imageTranslation.kind === "engine" ? "engine" : "llm"} choices={translationChoices} change={kind => updateImages({ translation: { ...imageTranslation, kind, provider: kind === "llm" ? "llm" : imageTranslation.provider === "llm" ? "bing" : imageTranslation.provider } })} />
            {imageTranslation.kind === "engine" && <Engines value={imageTranslation.engines} change={engines => updateImages({ translation: { ...imageTranslation, engines } })} />}</>}
          {(imageTranslation?.kind ?? textOptions.kind) !== "engine" && roleFields("images", "image", "图片初译模型")}
        </Group>
        {(imageTranslation || textOptions.kind !== "engine") && <Group title="复核与重译">{roleFields("images", "review", "校验失败重译模型", "关闭")}</Group>}
        {imageOptions.redrawProfile && <Group title="AI 风格重绘"><Select label="模型工作流" value={imageOptions.redrawProfile}
          choices={[{value:"turbo",label:"Qwen Image 2.1 Turbo"},{value:"2511",label:"Qwen Image Edit 2511"},{value:"custom",label:"自定义工作流"}]} change={redrawProfile => updateImages({redrawProfile})}/></Group>}
        {mosaic && <Group title="图片去码">
          <Select label="筛选范围" value={mosaic.scope} choices={[{value:"scenes",label:"场景图片"},{value:"all",label:"全部图片"}]} change={scope=>updateMosaic({scope})}/>
          <Select label="筛选方式" value={mosaic.detector} choices={[{value:"grid",label:"方格规则"},{value:"anime",label:"高召回初筛（分类＋定位）"}]} change={detector=>updateMosaic({detector})}/>
          <Count label="筛选并发" value={mosaic.concurrency ?? 2} choices={[1,2,4]} change={concurrency=>updateMosaic({concurrency})}/>
          <Flag label="自动流程执行视觉复筛" value={mosaic.refine!==false} change={refine=>updateMosaic({refine})}/>
          <Flag label="自动流程使用大模型补查未发现" value={!!mosaic.refineIncludeMissed} change={refineIncludeMissed=>updateMosaic({refineIncludeMissed})}/>
          <Select label="候选区域推理模型" value={mosaic.refineModel || "qwen3.5:latest"} choices={[...new Set(["qwen3.5:latest",...setup.models])].map(model=>({value:model,label:model.split("/").pop() || model}))} change={refineModel=>updateMosaic({refineModel})}/>
          <Select label="纹理与漏检复核模型" value={mosaic.refineGuardModel || "qwen3-vl:8b-instruct"} choices={[...new Set(["qwen3-vl:8b-instruct",...setup.models])].map(model=>({value:model,label:model.split("/").pop() || model}))} change={refineGuardModel=>updateMosaic({refineGuardModel})}/>
          <Count label="去码复筛并发" value={mosaic.refineConcurrency ?? 1} choices={[1,2]} change={refineConcurrency=>updateMosaic({refineConcurrency})}/>
          <Select label="去码模型" value={mosaic.model} choices={[{value:"turbo",label:"Qwen Image 2.1 Turbo"},{value:"2511",label:"Qwen Image Edit 2511"}]} change={model=>updateMosaic({model,steps:model==="turbo"?8:20})}/>
          {mosaic.model==="2511" && <label>步数<input type="number" min={1} max={100} value={mosaic.steps} onChange={e=>updateMosaic({steps:Math.max(1,Math.min(100,Number(e.target.value)))})}/></label>}
          <Flag label="保护已识别文字" value={mosaic.protect} change={protect=>updateMosaic({protect})}/>
        </Group>}
        <Group title="生成译图">{toggleModel("images", "layout", "排版方式", "本地原位排版")}</Group>
      </>}
    </div></fieldset>
    </div>
    <footer className="game-test-actions">
      {working && <span role="status">正在处理…</span>}
      <button type="button" className="unity-btn" disabled={!named || builtIn || working} onClick={() => named && void run(async () => { save(named); showAppNotice("已保存测试配置单"); })}>保存配置单</button>
      <button type="button" className="unity-btn unity-btn-primary" disabled={!named || working} onClick={() => named && void run(async () => {
        if (!builtIn) save(named);
        await onApply(named); onClose();
      })}>应用所选配置</button>
      <button type="button" className="unity-btn" disabled={working} onClick={onClose}>关闭</button>
    </footer>
  </main>;
}
