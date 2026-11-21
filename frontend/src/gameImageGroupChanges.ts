import type { UnityImage } from "./unityOffline";
import { unityImageParticipates } from "./unityImages";

export type ImageIndexIssue = { id: string; detail: string };

export function matchImagePatchConflicts(paths: readonly string[], images: readonly UnityImage[]) {
  const pathKey = (path: string) => path.replaceAll("\\", "/").toLowerCase();
  const pathsByKey = new Map(paths.map(path => [pathKey(path), path]));
  const matched = new Set<string>();
  const issues: ImageIndexIssue[] = [];
  if (pathsByKey.size) for (const image of images) {
    const path = pathsByKey.get(pathKey(image.file));
    if (!path || !unityImageParticipates(image)) continue;
    matched.add(path);
    issues.push({ id: image.id, detail: "补丁资源存在改动 · " + path });
  }
  return { matched, issues };
}
