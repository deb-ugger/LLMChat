/** Shared AutoTranslator config draft (same ini shape for every game). */
import type { UnityIniSection } from "./api";

export const UNITY_CONFIG_DRAFT_KEY = "llmchat-unity-config-draft";

export function loadUnityConfigDraft(): UnityIniSection[] | null {
  try {
    const raw = localStorage.getItem(UNITY_CONFIG_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as UnityIniSection[];
  } catch {
    return null;
  }
}

export function saveUnityConfigDraft(sections: UnityIniSection[]) {
  try {
    localStorage.setItem(UNITY_CONFIG_DRAFT_KEY, JSON.stringify(sections));
  } catch {
    /* ignore quota / private mode */
  }
}

/** Fill empty keys in `base` from `draft` (by section/key name). */
export function mergeUnityDraftInto(
  base: UnityIniSection[],
  draft: UnityIniSection[],
): UnityIniSection[] {
  const draftBySec = new Map(
    draft.map((s) => [s.name.toLowerCase(), s] as const),
  );
  return base.map((sec) => {
    const d = draftBySec.get(sec.name.toLowerCase());
    if (!d) return { ...sec, keys: sec.keys.map((k) => ({ ...k })) };
    return {
      ...sec,
      keys: sec.keys.map((k) => {
        const dv = d.keys.find(
          (x) => x.key.toLowerCase() === k.key.toLowerCase(),
        )?.value;
        if (dv != null && dv.trim() !== "" && k.value.trim() === "") {
          return { ...k, value: dv };
        }
        return { ...k };
      }),
    };
  });
}
