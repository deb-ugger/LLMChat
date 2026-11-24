import { useSyncExternalStore } from "react";
import { readMosaicRows, writeMosaicRowEdits } from "../../gameMosaicRefine";
import type { MosaicCandidate, Result, Results } from "./mosaicWorkbenchTypes";

type RowDraft = { base: Result; storedSource?: string; patch: Partial<Result>; candidate?: { value?: MosaicCandidate } };
type Drafts = ReadonlyMap<string, RowDraft>;
const emptyDrafts: Drafts = new Map();
const projects = new Map<string, Drafts>();
const currentRows = new Map<string, () => Results>();

export function registerMosaicRows(root: string, read: () => Results) {
  currentRows.set(root, read);
  return () => { if (currentRows.get(root) === read) currentRows.delete(root); };
}
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const mosaicDraftSavedEvent = "llmchat-mosaic-draft-saved";
export const mosaicAdoptionChangedEvent = "llmchat-mosaic-adoption-changed";
export type MosaicAdoptionChange = { root: string; imageIds: readonly string[] };

export function notifyMosaicAdoptionChanged(root: string, imageIds: readonly string[]) {
  if (imageIds.length) window.dispatchEvent(new CustomEvent<MosaicAdoptionChange>(mosaicAdoptionChangedEvent, { detail: { root, imageIds } }));
}
export const mosaicDraftsOf = (root: string) => projects.get(root) ?? emptyDrafts;
export const hasMosaicDrafts = (root: string) => mosaicDraftsOf(root).size > 0;
export const useMosaicDrafts = (root: string) => useSyncExternalStore(subscribe, () => mosaicDraftsOf(root));
export const useHasMosaicDrafts = (root: string) => useSyncExternalStore(subscribe, () => hasMosaicDrafts(root));

function publishDrafts(root: string, drafts: Drafts) {
  if (drafts.size) projects.set(root, drafts); else projects.delete(root);
  listeners.forEach(listener => listener());
}

export function stageMosaicEdits(root: string, edits: readonly {
  id: string;
  base: Result;
  storedSource?: string;
  patch: Partial<Result>;
  candidate?: RowDraft["candidate"];
}[]) {
  if (!edits.length) return;
  const drafts = new Map(mosaicDraftsOf(root));
  for (const edit of edits) {
    const existing = drafts.get(edit.id);
    const previous = existing?.base.source === edit.base.source ? existing : undefined;
    const patch = { ...previous?.patch, ...edit.patch };
    for (const key of Object.keys(patch) as (keyof Result)[]) {
      if (Object.is(patch[key], edit.base[key]) ||
          key === "boxes" && JSON.stringify(patch.boxes) === JSON.stringify(edit.base.boxes)) delete patch[key];
    }
    if (Object.keys(patch).length) {
      drafts.set(edit.id, { base: edit.base, storedSource: edit.storedSource, patch, candidate: edit.candidate ?? previous?.candidate });
    } else {
      drafts.delete(edit.id);
    }
  }
  publishDrafts(root, drafts);
}

export function applyMosaicDrafts(rows: Results, drafts: Drafts): Results {
  if (!drafts.size) return rows;
  const next = { ...rows };
  for (const [id, { base, storedSource, patch }] of drafts) {
    const row = rows[id];
    if (row?.source === base.source) next[id] = { ...row, ...patch };
    else if (row?.source === storedSource) next[id] = { ...base, ...patch };
  }
  return next;
}

export function discardMosaicDraft(root: string, imageId: string) {
  const current = mosaicDraftsOf(root);
  if (!current.has(imageId)) return false;
  const remaining = new Map(current);
  remaining.delete(imageId);
  publishDrafts(root, remaining);
  return true;
}

export type MosaicDraftSaved = { root: string; changes: Results; drafts: Drafts };
export function saveMosaicDrafts(root: string, imageId?: string) {
  const current = mosaicDraftsOf(root);
  const draft = imageId === undefined ? undefined : current.get(imageId);
  const drafts = imageId === undefined ? current : draft ? new Map([[imageId, draft]]) : emptyDrafts;
  if (!drafts.size) return false;
  const stored = currentRows.get(root)?.() ?? readMosaicRows<Result>(root);
  const changes: Results = {};
  for (const [id, { base, storedSource, patch }] of drafts) {
    const row = stored[id];
    if (row?.source !== base.source && row?.source !== storedSource)
      throw new Error("原图已更新，无法保存上一版的去码修改");
    const next = { ...(row?.source === base.source ? row : base), ...patch };
    if (base.saved && next.saved === false) {
      next.checked = false;
      next.manualChecked = true;
    }
    changes[id] = next;
  }
  writeMosaicRowEdits(root, changes);
  window.dispatchEvent(new CustomEvent<MosaicDraftSaved>(mosaicDraftSavedEvent, { detail: { root, changes, drafts } }));
  const remaining = new Map(mosaicDraftsOf(root));
  for (const [id, saved] of drafts) if (remaining.get(id) === saved) remaining.delete(id);
  publishDrafts(root, remaining);
  notifyMosaicAdoptionChanged(root, [...drafts].flatMap(([id, draft]) => draft.base.saved && changes[id].saved === false ? [id] : []));
  return true;
}
