import type { UnityEntry, UnityProject, UnityProgress } from "./unityOffline";
import { unityTranslationStats, unityTranslationContextKey } from "./unityTranslationSession";
import { unityImagesReady, unityImageResultReady } from "./unityWorkflow";

export function unityTranslationReadiness(project: UnityProject | null, selected: UnityEntry[], validate: (source: string, translation: string) => string, partial = false) {
  const stats = unityTranslationStats(selected, validate, unityTranslationContextKey);
  const textComplete = !!project && stats.coverageCompleted === selected.length;
  const textSkipped = !!project?.textSkipped || partial && stats.coverageCompleted > 0 && !textComplete;
  const images = (project?.images || []).filter(image => image.selected);
  const validImages = images.filter(unityImageResultReady);
  const imagesComplete = !!project && unityImagesReady(project) && validImages.length === images.length;
  return {
    stats, textComplete, textSkipped, textReady: !!project && (textComplete || textSkipped),
    validText: stats.coverageCompleted, missingText: selected.length - stats.coverageCompleted,
    imagesComplete, imagesSkipped: !!project?.imagesSkipped,
    imagesReady: !!project && (imagesComplete || !!project.imagesSkipped),
    validImages: validImages.length, totalImages: images.length, missingImages: images.length - validImages.length,
    hasPatchContent: stats.coverageCompleted > 0 || validImages.length > 0,
  };
}

type PartProgress = UnityProgress & { step: number; state: "pending" | "running" | "done" | "stopped" | "error" | "skipped"; failure?: string };

/** Saved task state cannot overrule the current selected results. */
export function unityCurrentPartProgress<T extends PartProgress>(progress: T | undefined, part: "text" | "images", readiness: ReturnType<typeof unityTranslationReadiness>, layoutOnly = false): T | undefined {
  if (!progress || progress.state === "running" || layoutOnly) return progress;
  const complete = part === "text" ? readiness.textComplete : readiness.imagesComplete;
  const skipped = part === "text" ? readiness.textSkipped : readiness.imagesSkipped;
  const missing = part === "text" ? readiness.stats.total - readiness.stats.completed : readiness.missingImages;
  const state = complete ? "done" : skipped ? "skipped" : progress.state === "done" || progress.state === "skipped" ? "pending" : progress.state;
  const stats = part === "text" ? readiness.stats : { completed: readiness.validImages, total: readiness.totalImages };
  const detail = complete ? part === "images" && !readiness.totalImages ? "没有选中的图片，无需处理" : part === "text" ? "所选文本均有有效译文" : "所选译图均已完成"
    : skipped ? "已完成结果保留，未完成内容保持原样"
    : `仍有 ${missing} ${part === "text" ? "种原文" : "张图片"}未完成，可继续处理或跳过剩余内容`;
  return { ...progress, ...stats, state, detail, failure: state === "error" ? progress.failure : undefined };
}
