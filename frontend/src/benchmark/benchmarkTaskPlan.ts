
import type { BenchmarkInput, BenchmarkRequest } from "./benchmarkRunner";
import type { MosaicSettings } from "../gameMosaic";
import { normalizeMosaicScreening, type MosaicScreening } from "../gameMosaicScreening";
import type { BenchmarkConfig } from "../gameTextBenchmark";
import { validateMosaicLocalModels } from "../gameMosaicCandidateInputs";

type Source = "dataset-all" | "project-initial-snapshot";
type ConfigRow = {
  name?: string; detector?: "anime" | "grid"; lanes?: number;
  screenModel?: string; candidateModel?: string; reviewModel?: string;
  screening?: Partial<MosaicScreening>;
};

export function readMosaicTaskPlan(raw: string, scope: string, current: BenchmarkInput["current"],
  mosaic: MosaicSettings, installedModels: readonly string[]): BenchmarkRequest[] {
  const file = JSON.parse(raw) as {
    version?: number; dataset?: string;
    tasks?: { step?: "mosaicScreen" | "mosaicRefine"; source?: Source; rounds?: number; configs?: ConfigRow[] }[];
  } | null;
  if ((file?.version !== 1 && file?.version !== 2 && file?.version !== 3 && file?.version !== 4) || !Array.isArray(file.tasks) || file.tasks.length < 1 || file.tasks.length > 24)
    throw new Error("配置单须为版本 1 至 4，并包含 1 至 24 个测试任务");
  const version = file.version;
  const dataset = typeof file.dataset === "string" ? file.dataset.trim() : "";
  if (!dataset || !/[\\/]manifest\.json$/i.test(dataset))
    throw new Error("配置单须提供数据集 manifest.json 的路径");
  const { modelIds: _modelIds, ...defaults } = current;
  const verifyModel = (name: string | undefined) => {
    if (typeof name !== "string" || !installedModels.includes(name))
      throw new Error("配置单中的模型不可用：" + String(name ?? "未填写"));
    return name;
  };
  return file.tasks.map((task, index) => {
    if (!task || (task.step !== "mosaicScreen" && task.step !== "mosaicRefine"))
      throw new Error("第 " + (index + 1) + " 项的测试步骤无效");
    const step = task.step;
    const screen = step === "mosaicScreen";
    if (task.source !== (screen ? "dataset-all" : "project-initial-snapshot"))
      throw new Error("第 " + (index + 1) + " 项的样本来源无效");
    const rounds = task.rounds ?? 1;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100 ||
        !Array.isArray(task.configs) || task.configs.length < 1 || task.configs.length > 100)
      throw new Error("第 " + (index + 1) + " 项的循环轮次或配置数量无效");
    const configs = task.configs.map((config): BenchmarkConfig => {
      if (!config || typeof config.name !== "string" || !config.name.trim()) throw new Error("配置名称不能为空");
      const lanes = config.lanes ?? 2;
      if (![1, 2, 4].includes(lanes)) throw new Error("并发只接受 1、2 或 4");
      const detector = config.detector ?? "anime";
      if (detector !== "anime" && detector !== "grid") throw new Error("初筛检测器无效");
      const screening = config.screening;
      if (version >= 2 && screen && screening === undefined) throw new Error("版本 2 及以上的初筛配置须明确提供 screening 参数");
      if (screening !== undefined && (!screening || typeof screening !== "object" || Array.isArray(screening) ||
          (screening.localZoom !== undefined && typeof screening.localZoom !== "boolean") ||
          (screening.modelConcurrency !== undefined && ![1, 2, 4].includes(screening.modelConcurrency)) ||
          [screening.presenceThreshold, screening.boxThreshold].some(value => value !== undefined &&
            (typeof value !== "number" || !Number.isFinite(value) || value < 0.05 || value > 0.95))))
        throw new Error("初筛阈值须为 0.05 至 0.95，ONNX 推理路数须为 1、2 或 4，局部放大须为布尔值");
      if (version >= 4 && screen && screening?.modelConcurrency === undefined) throw new Error("版本 4 的初筛配置须明确提供 ONNX 推理路数");
      validateMosaicLocalModels(screening?.localModels);
      if (screening?.localModels && (version < 3 || detector !== "anime")) throw new Error("本地 ONNX 模型需要版本 3 的分类＋定位配置");
      const settings = { ...mosaic, detector, screening: normalizeMosaicScreening(screening ?? mosaic.screening), selection: screen ? "all" as const : "checked" as const, sampleLimit: 0 };
      return {
        ...defaults, id: crypto.randomUUID(), label: config.name.trim(), enabled: true,
        models: { text: { id: "", lanes }, dialogue: { id: "", lanes: 1 }, names: { id: "", lanes: 1 } },
        mosaic: screen
          ? { ...settings, concurrency: lanes, screenVisionModel: config.screenModel === undefined ? undefined : verifyModel(config.screenModel) }
          : { ...settings, refineConcurrency: lanes, refineModel: verifyModel(config.candidateModel), refineGuardModel: verifyModel(config.reviewModel) },
      };
    });
    return { scope, step, configs, rounds, priority: index === 0, sampleLimit: 0,
      sampleSetPath: screen ? dataset : undefined, referenceSampleSetPath: dataset };
  });
}
