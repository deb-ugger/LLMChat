import type { ImageScreening } from "./gameImageScreening";
import type { UnityImage } from "./unityOffline";
import { unityImageParticipates, unityImageResultGroup } from "./unityImages";

export type ImageResultGroup = ReturnType<typeof unityImageResultGroup>;
export type ImageIndexIssue = { id: string; detail: string };
type ImageOrigin = { group: ImageResultGroup; index: number };
const screeningGroups: Record<ImageScreening["state"], ImageResultGroup> = {
  candidate: "candidate", review: "review", "no-text": "empty", "not-needed": "excluded", failed: "failed",
};

const groupHistoryKey = (folder: string) => "game-image-group-changes-after-screening:" + folder;

export function clearImageGroupHistory(folder: string) {
  try { localStorage.removeItem(groupHistoryKey(folder)); }
  catch { /* Storage can be unavailable. */ }
}

export function resetImageGroupHistory(folder: string) {
  try { localStorage.setItem(groupHistoryKey(folder), "[]"); }
  catch { /* Storage can be unavailable. */ }
}

export function imageGroupHistory(folder?: string) {
  const key = folder && groupHistoryKey(folder);
  const stored = key ? localStorage.getItem(key) : null;
  let serialized = stored ?? "[]";
  let origins: Map<string, ImageOrigin | null>;
  try { origins = new Map(JSON.parse(serialized)); }
  catch { origins = new Map(); }
  let initialized = false;
  let sawScreening = stored === "[]";
  return {
    origins,
    record(images: readonly UnityImage[], initialScreeningComplete: boolean) {
      if (!images.length) return false;
      if (!initialScreeningComplete) {
        const changed = origins.size > 0;
        sawScreening = true;
        initialized = false;
        origins.clear();
        if (folder && serialized !== "[]") {
          clearImageGroupHistory(folder);
          serialized = "[]";
        }
        return changed;
      }
      const moved: [string, ImageOrigin | null][] = [];
      const counts: Partial<Record<ImageResultGroup, number>> = {};
      const occupied: Partial<Record<ImageResultGroup, Set<number>>> = {};
      if (!initialized) {
        for (const origin of origins.values()) {
          if (origin) (occupied[origin.group] ??= new Set()).add(origin.index);
        }
      }
      let changed = false;
      for (const image of images) {
        const current = unityImageResultGroup(image);
        if (!origins.has(image.id)) {
          if (initialized) {
            origins.set(image.id, null);
            changed = true;
          } else {
            const screening = image.screening;
            const prior = screening?.initial?.state ?? screening?.beforeRefine?.state;
            const group = !sawScreening && prior && prior !== screening?.state && !screening?.refineFailed
              ? screeningGroups[prior] : current;
            let index = counts[group] ?? 0;
            while (occupied[group]?.has(index)) index++;
            counts[group] = index + 1;
            origins.set(image.id, { group, index });
            changed ||= group !== current;
          }
        }
        const origin = origins.get(image.id)!;
        if (origin === null || origin.group !== current) moved.push([image.id, origin]);
      }
      initialized = true;
      if (key) {
        const next = JSON.stringify(moved);
        if (next !== serialized) {
          try { localStorage.setItem(key, next); serialized = next; }
          catch (error) { console.warn("无法保存图片分组变更索引", error); }
        }
      }
      return changed;
    },
  };
}

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
