import { useSyncExternalStore } from "react";
import { mosaicRowsStorageKey, readMosaicRows } from "../../gameMosaicRefine";
import type { MosaicCandidate, Result, Results } from "./mosaicWorkbenchTypes";

type RowDraft = { base: Result; storedSource?: string; patch: Partial<Result>; candidate?: { value?: MosaicCandidate } };
type Drafts = ReadonlyMap<string, RowDraft>;
const emptyDrafts: Drafts = new Map();
const projects = new Map<string, Drafts>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const mosaicDraftSavedEvent = "llmchat-mosaic-draft-saved";
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

export type MosaicDraftSaved = { root: string; rows: Results; drafts: Drafts };
export function saveMosaicDrafts(root: string) {
  const drafts = mosaicDraftsOf(root);
  if (!drafts.size) return false;
  const stored = readMosaicRows<Result>(root);
  for (const [id, { base, storedSource }] of drafts) {
    const source = stored[id]?.source;
    if (source !== base.source && source !== storedSource) throw new Error("原图已更新，无法保存上一版的去码修改");
  }
  const rows = applyMosaicDrafts(stored, drafts);
  localStorage.setItem(mosaicRowsStorageKey(root), JSON.stringify(rows));
  window.dispatchEvent(new CustomEvent<MosaicDraftSaved>(mosaicDraftSavedEvent, { detail: { root, rows, drafts } }));
  publishDrafts(root, emptyDrafts);
  return true;
}
