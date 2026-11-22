import type { MosaicBenchmarkStep } from "../gameMosaicBenchmark";
import type { BenchmarkTarget } from "./benchmarkRunner";
import { LOCAL_REFINE_MODELS } from "../gameImageScreening";
import { imageBenchmarkSteps, type ImageBenchmarkSetup } from "../gameImageBenchmark";
import { defaultMosaicSettings, mosaicModelLabels } from "../gameMosaic";
import { gamePromptCatalog, type GamePromptScene } from "../gamePrompts";
import { benchmarkRoles, type BenchmarkConfig } from "../gameTextBenchmark";
import { labelForModelId } from "../modelPresets";
import { OCR_MODE_OPTIONS } from "../ocr/modes";
import { translationEngineLabel } from "../translateEngines";
import { UNITY_LANGUAGES } from "../unityTranslation";

export type BenchmarkParameter = { label: string; value: string; scope: "task" | "config" };

const roleLabels = { text: "正文", dialogue: "对白", names: "术语" };
const wrapLabels = { keep: "保留换行", join: "合并后恢复换行", natural: "大模型自然断行" };
const refineScopes = { selected: "已勾选图片", suspected: "疑似及待复核", all: "全部已筛选图片" };
const languageLabel = (value: string) => value === "auto" ? "自动检测" : UNITY_LANGUAGES.find(item => item.value === value)?.label || value;
const switchLabel = (enabled: boolean) => enabled ? "开启" : "关闭";

export function formatBenchmarkParameters(step: BenchmarkTarget, config: BenchmarkConfig, context: {
  rounds: number;
  sampleLimit: number | null;
  annotated: boolean;
  mosaicSelection?: "checked" | "all";
  imageSetup?: ImageBenchmarkSetup;
}): BenchmarkParameter[] {
  const { rounds, sampleLimit, annotated, mosaicSelection, imageSetup } = context;
  const rows: BenchmarkParameter[] = [];
  const add = (scope: BenchmarkParameter["scope"], label: string, value: string | number) => rows.push({ label, value: String(value), scope });
  const addPrompt = (label: string, role: GamePromptScene) => {
    const id = config.prompts[role] || "builtin:" + role;
    const name = gamePromptCatalog().find(item => item.scene === role && item.id === id)?.name;
    add("config", label, name || "默认提示词");
  };

  const textStep = step === "translate" || step === "screen";
  if (step === "mosaicRefine" || step === "mosaicScreen" || step === "mosaicRedraw") {
    rows.push(...formatMosaicParameters(step, config.mosaic));
    add("task", "样本范围", annotated ? "已标注样本集" : mosaicSelection === "all" ? "当前项目全部可用图片" : "去码页已勾选");
  } else {
    const model = config.models.text;
    if (step === "translate" && model.id) {
      for (const role of benchmarkRoles) {
        const selected = config.models[role];
        const effective = selected.id ? selected : model;
        add("config", roleLabels[role] + "模型", labelForModelId(effective.id) + (selected.id ? "" : "（跟随正文）"));
        add("config", roleLabels[role] + "并发", effective.lanes);
        addPrompt(roleLabels[role] + "提示词", role);
      }
    } else if ((step === "translate" || step === "imageTranslate") && !model.id) {
      const engines = (config.engines || imageSetup?.engines || []).filter(engine => engine.enabled);
      add("config", "处理方式", "翻译引擎");
      add("config", "启用的翻译引擎", engines.map(engine => translationEngineLabel(engine.id)).join("、") || "未配置");
    } else if (model.id && step !== "translate") {
      const role = step === "screen" ? "textScreen" : imageBenchmarkSteps[step].role;
      add("config", "处理模型", labelForModelId(model.id));
      add("config", "模型并发", model.lanes);
      addPrompt("提示词", role);
    } else if (step !== "translate" && step !== "imageTranslate") {
      const localLabels = { screen: "本地筛选", filter: "本地筛选", refine: "本地复筛", recognize: "本地 OCR", review: "未选模型", render: "本地原位排版" };
      add("config", "处理方式", localLabels[step]);
      if (step === "filter" || step === "refine" || step === "recognize" || step === "render") {
        add("config", "本地并发", config.localLanes || (step === "refine" ? imageSetup?.refineConcurrency || 2 : imageSetup?.concurrency || 1));
      }
    }

    add("config", "原文语言", languageLabel(config.source));
    add("config", "目标语言", languageLabel(config.target));
    if (step === "screen" || step === "translate" || step === "imageTranslate" || step === "review")
      add("config", "跳过目标语言", switchLabel(config.skipTarget));
    if (step === "translate") {
      add("config", "换行处理", wrapLabels[config.wrap]);
      add("config", "附带上下文", switchLabel(config.includeContext));
    }
    if (step === "filter") {
      const strategy = model.id ? "full" : config.imageStrategy || imageSetup?.strategy;
      add("config", "筛选策略", strategy === "full" ? "完整范围筛选" : "分级快速筛选");
    }
    if (step === "refine" && !model.id) {
      const mode = LOCAL_REFINE_MODELS.find(item => item.id === config.imageMode)?.id || imageSetup?.refineMode || "precise";
      add("config", "本地模型", LOCAL_REFINE_MODELS.find(item => item.id === mode)?.title || "默认");
    }
    if (step === "recognize") {
      const mode = config.imageMode || imageSetup?.mode || "fast";
      if (model.id) add("config", "用 Manga OCR 复读日文竖排", switchLabel(mode === "manga"));
      else add("config", "识别模式", OCR_MODE_OPTIONS.find(item => item.id === mode)?.title || "默认");
    }
    if (step === "refine" || step === "recognize") {
      const confidence = config.imageConfidence ?? (step === "refine" ? imageSetup?.refineConfidence : imageSetup?.confidence);
      if (confidence !== undefined) add("config", "置信度阈值", confidence + "%");
    }
    add("task", "样本范围", annotated ? "已标注样本集" : textStep ? "当前项目已勾选文本" : "当前项目已勾选图片");
  }
  add("task", "样本上限", sampleLimit === null ? "沿用原批次样本" : sampleLimit ? sampleLimit + (textStep ? " 条" : " 张") : "不限");
  add("task", "循环轮次", rounds + " 轮");
  return rows;
}

export function formatMosaicParameters(step: MosaicBenchmarkStep, settings?: Partial<typeof defaultMosaicSettings>): BenchmarkParameter[] {
  const rows: BenchmarkParameter[] = [];
  const add = (label: string, value: string | number) => rows.push({ label, value: String(value), scope: "config" });
  const mosaic = { ...defaultMosaicSettings, ...settings };
    if (step === "mosaicRefine") {
      add("候选区域推理模型", labelForModelId(mosaic.refineModel || defaultMosaicSettings.refineModel!));
      add("纹理与漏检复核模型", labelForModelId(mosaic.refineGuardModel || defaultMosaicSettings.refineGuardModel!));
      add("复筛并发", mosaic.refineConcurrency ?? 1);
      add("手动复筛范围", refineScopes[mosaic.refineScope ?? "selected"]);
      add("自动补查未发现", switchLabel(!!mosaic.refineIncludeMissed));
      add("自动执行视觉复筛", switchLabel(mosaic.refine !== false));
    } else if (step === "mosaicScreen") {
      add("筛选方式", mosaic.detector === "grid" ? "方格规则" : "分类＋定位");
      add("筛选并发", mosaic.concurrency ?? 2);
    } else {
      add("重绘模型", mosaicModelLabels[mosaic.model]);
      add("步数", mosaic.steps);
      add("保护已识别文字", switchLabel(mosaic.protect));
    }
  return rows;
}
