import type { readFileBytes } from "../../localDocFile";
import { unityTranslationError, type UnityFontPlan, type UnityPatch, type UnityProgress, type UnityProject, type unityRun } from "../../unityOffline";
import { textTranslationMatchesTarget } from "../../unityTranslationSession";
import { unityImageReadyForTarget, unityLanguageScope, type measureDeploymentStage } from "../../unityWorkflow";
import type { DeploymentPhase } from "../UnityDeploymentPanel";

type ExportedPatch = UnityPatch & { mosaicImages?: number };
export type DeploymentPatch = ExportedPatch & { deploymentExcluded?: DeploymentPhase[] };

type ExportOptions = {
  source: string;
  target: string;
  onlySourceLanguage: boolean;
  imageTarget: string;
  fontPath: string;
  extraCharacters: string;
};
type ExportCheckpoint = Partial<Pick<ExportOptions, "source" | "target" | "onlySourceLanguage" | "fontPath" | "extraCharacters">> & {
  patchFolder?: string;
  partial?: boolean;
};
type ExportPorts = {
  run: typeof unityRun;
  measure: typeof measureDeploymentStage;
  readFile: typeof readFileBytes;
  reportFontPlan: (plan: UnityFontPlan) => void;
};

function buildExportRequest(project: UnityProject, options: ExportOptions, checkpoint: ExportCheckpoint | undefined,
  excluded: DeploymentPhase[], deploymentBatch?: string) {
  const ids = unityLanguageScope(project.entries, checkpoint?.source || options.source, checkpoint?.onlySourceLanguage ?? options.onlySourceLanguage).ids;
  const patchTarget = checkpoint?.target ?? options.target;
  const partial = checkpoint?.partial || project.textSkipped;
  const selectedIds = project.entries.filter(entry => entry.selected && ids.has(entry.id) && textTranslationMatchesTarget(entry, patchTarget) &&
    (!partial || !entry.error && entry.translation && !unityTranslationError(entry.source, entry.translation))).map(entry => entry.id);
  const patchImageIds = (project.images || []).filter(image => image.selected && unityImageReadyForTarget(image, options.imageTarget)).map(image => image.id);
  const textEnabled = !excluded.includes("text");
  return {
    project,
    selectedIds: textEnabled ? selectedIds : [],
    patchImageIds: excluded.includes("image") ? [] : patchImageIds,
    excludeMosaic: excluded.includes("mosaic"),
    fontPath: textEnabled ? checkpoint?.fontPath ?? options.fontPath : "",
    extraCharacters: textEnabled ? checkpoint?.extraCharacters ?? options.extraCharacters : "",
    path: checkpoint?.patchFolder || "",
    deploymentBatch,
  };
}

export async function generateOfflinePatch(root: string, project: UnityProject, options: ExportOptions, checkpoint: ExportCheckpoint | undefined,
  excluded: DeploymentPhase[], deploymentBatch: string | undefined, onProgress: ((value: UnityProgress) => void) | undefined,
  signal: AbortSignal | undefined, ports: ExportPorts): Promise<DeploymentPatch> {
  const request = buildExportRequest(project, options, checkpoint, excluded, deploymentBatch);
  let result: ExportedPatch;
  try {
    result = await ports.measure(root, "generate",
      () => ports.run<ExportedPatch>("export", request, onProgress, signal),
      written => written.files);
  } catch (error) {
    if (/所选字体缺少/.test(String(error))) {
      const report = JSON.parse(new TextDecoder().decode(await ports.readFile(project.folder + "/font-plan/font-plan.json"))) as UnityFontPlan;
      ports.reportFontPlan(report);
    }
    throw error;
  }
  return { ...result, deploymentExcluded: excluded };
}

export function offlineExportMessage(result: DeploymentPatch) {
  return `已生成 ${result.files} 个补丁文件 · ${result.entries} 条译文 · ${result.images || 0} 张译图 · ${result.mosaicImages || 0} 张去码图 · ${result.fontReplacements} 个替换字体`;
}
