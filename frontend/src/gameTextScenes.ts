import type { UnityEntry } from "./unityOffline";
import type { GameDialoguePage } from "./gameTranslationContext";
import type { GameSemanticEntry, GameSemanticReview } from "./gameTextSemantics";

export type GameSceneLocation = { file: string; event: number; page: number; command: number; slot: string };
export type GameSceneTranslation = GameSceneLocation & {
  source: string; translation: string; target: string; error: string; contextKnown: boolean; semanticReview?: GameSemanticReview;
};
export type GameSceneProject = { entries: GameSemanticEntry[]; dialoguePages?: GameDialoguePage[]; sceneTranslations?: GameSceneTranslation[] };
export const gameSceneKey = (scene: GameSceneLocation) => JSON.stringify([scene.file, scene.event, scene.page, scene.command, scene.slot]);
export const gameSceneLabel = (scene: GameSceneLocation) => `${scene.file} · 事件 ${scene.event} · 第 ${scene.page + 1} 页 · 指令 ${scene.command}`;

export function gameEntrySceneLocations(project: GameSceneProject, entry: GameSemanticEntry) {
  return (entry.dialoguePositions || (entry.dialoguePosition ? [entry.dialoguePosition] : [])).map(position => {
    const page = project.dialoguePages?.[position.page];
    if (!page || page.lines[position.line] !== entry.source || page.commands[position.line] === undefined)
      throw new Error(`第 ${entry.id} 条场景与原文不一致，请重新读取工程`);
    return { position, location: { file: page.file, event: page.event, page: page.page, command: page.commands[position.line], slot: page.slots?.[position.line] || "message" } };
  });
}

export function gameEntrySceneTranslations(project: GameSceneProject, entry: GameSemanticEntry, target: string) {
  return (project.sceneTranslations || []).filter(scene => scene.source === entry.source && scene.target === target);
}

export function editGameScene(project: GameSceneProject, scene: GameSceneTranslation) {
  const parent = project.entries.find(entry => entry.source === scene.source);
  if (!parent) throw new Error("场景原文不属于当前工程");
  const records = new Map((project.sceneTranslations || []).map(value => [value.target + ":" + gameSceneKey(value), value]));
  for (const { location } of gameEntrySceneLocations(project, parent)) {
    const key = scene.target + ":" + gameSceneKey(location);
    if (!records.has(key)) records.set(key, { ...location, target: scene.target, source: parent.source, translation: parent.translation, error: parent.error, contextKnown: false });
  }
  records.set(scene.target + ":" + gameSceneKey(scene), scene);
  const scenes = [...records.values()], variants = scenes.filter(value => value.source === parent.source && value.target === scene.target);
  const canonical = variants.find(value => value.translation.trim() && !value.error);
  const failed = variants.filter(value => value.error);
  return { ...project, sceneTranslations: scenes, entries: project.entries.map(entry => entry !== parent ? entry : { ...parent,
    ...(canonical ? { translation: canonical.translation, translationTarget: scene.target, semanticReview: canonical.semanticReview } : {}),
    error: failed.length ? `${failed.length} 处场景译文失败：${failed[0].error}` : "",
  }) };
}

export function createGameScenePlan(project: GameSceneProject, selected: GameSemanticEntry[], target: string, enabled = true) {
  const entries: GameSemanticEntry[] = [], bindings = new Map<string, { parent: GameSemanticEntry; location: GameSceneLocation; initiallyTranslated: boolean }>();
  const groups = new Map<string, GameSemanticEntry[]>(), changedScenes = new Map<string, GameSceneTranslation>();
  if (!enabled) {
    const sources = new Set(selected.map(entry => entry.source));
    project.sceneTranslations = (project.sceneTranslations || []).filter(scene => !sources.has(scene.source));
  }
  for (const entry of selected) {
    const locations = enabled && entry.dialoguePositions?.length && project.dialoguePages ? gameEntrySceneLocations(project, entry) : [];
    if (locations.length <= 1) { entries.push(entry); continue; }
    const saved = new Map(gameEntrySceneTranslations(project, entry, target).map(scene => [gameSceneKey(scene), scene]));
    const variants = locations.map(({ position, location }) => {
      const record = saved.get(gameSceneKey(location));
      const value: GameSemanticEntry = { ...entry, id: `${entry.id}@${position.page}:${position.line}`, dialoguePosition: position, dialoguePositions: undefined,
        translation: record?.translation ?? entry.translation, error: record?.error ?? entry.error,
        translationTarget: record?.target ?? entry.translationTarget, semanticReview: record?.semanticReview, sceneContextPending: !record?.contextKnown };
      bindings.set(value.id, { parent: entry, location, initiallyTranslated: !!value.translation.trim() });
      return value;
    });
    groups.set(entry.id, variants); entries.push(...variants);
  }
  const byId = new Map(project.entries.map(entry => [entry.id, entry])), liveEntries = new Map(entries.map(entry => [entry.id, entry]));
  const merge = (changes: readonly UnityEntry[], final = false) => {
    const parents = new Set<GameSemanticEntry>();
    const records = new Map((project.sceneTranslations || []).map(scene => [scene.target + ":" + gameSceneKey(scene), scene]));
    for (const raw of changes) {
      const entry = raw as GameSemanticEntry, binding = bindings.get(entry.id);
      if (!binding) { const parent = byId.get(entry.id); if (parent) parents.add(parent); continue; }
      const live = liveEntries.get(entry.id)!;
      if (live !== entry) Object.assign(live, entry);
      if (!binding.initiallyTranslated && live.translation.trim() && !live.error) live.sceneContextPending = false;
      const record: GameSceneTranslation = { ...binding.location, source: live.source, translation: live.translation, target,
        error: live.error, contextKnown: !live.sceneContextPending, semanticReview: live.semanticReview };
      const key = gameSceneKey(record);
      records.set(target + ":" + key, record);
      changedScenes.set(key, record); parents.add(binding.parent);
    }
    if (changedScenes.size) project.sceneTranslations = [...records.values()];
    for (const parent of parents) {
      const variants = groups.get(parent.id); if (!variants) continue;
      const canonical = variants.find(value => value.translation.trim() && !value.error) || variants[0];
      parent.translation = canonical.translation; parent.translationTarget = canonical.translationTarget;
      parent.semanticReview = canonical.semanticReview;
      const failed = variants.filter(value => value.error), pending = variants.filter(value => !value.translation.trim() && !value.error);
      parent.error = failed.length ? `${failed.length} 处场景译文失败：${failed[0].error}` : final && pending.length ? `${pending.length} 处场景尚未翻译` : "";
    }
    return [...parents];
  };
  merge(entries);
  return {
    entries, merge,
    finish: () => merge(entries, true),
    takeChanges: () => { const values = [...changedScenes.values()].map(value => ({ ...value })); changedScenes.clear(); return values; },
  };
}
