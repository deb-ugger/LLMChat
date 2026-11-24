import type { MosaicCandidate, RedrawPlan } from "./mosaicWorkbenchTypes";

type CandidateRecord = { project: string; imageId: string; candidate: MosaicCandidate };
type PlanRecord = { project: string; plan: RedrawPlan };

function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function archive<T>(mode: IDBTransactionMode, work: (candidates: IDBObjectStore, plans: IDBObjectStore) => Promise<T>) {
  const opening = indexedDB.open("llmchat-mosaic-redraw", 1);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore("candidates", { keyPath: ["project", "imageId"] }).createIndex("project", "project");
    db.createObjectStore("plans", { keyPath: "project" });
  };
  const db = await result(opening);
  try {
    const tx = db.transaction(["candidates", "plans"], mode);
    const complete = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    const [value] = await Promise.all([work(tx.objectStore("candidates"), tx.objectStore("plans")), complete]);
    return value;
  } finally { db.close(); }
}

export function readMosaicRedrawArchive(project: string) {
  return archive("readonly", async (candidates, plans) => {
    const [entries, saved]: [CandidateRecord[], PlanRecord | undefined] = await Promise.all([
      result(candidates.index("project").getAll(project)), result(plans.get(project)),
    ]);
    return { candidates: Object.fromEntries(entries.map(entry => [entry.imageId, entry.candidate])), plan: saved?.plan };
  });
}

export function writeMosaicRedrawCandidates(project: string, changes: readonly (readonly [string, MosaicCandidate | undefined])[]) {
  return archive("readwrite", async candidates => {
    for (const [imageId, candidate] of changes) {
      if (candidate) candidates.put({ project, imageId, candidate });
      else candidates.delete([project, imageId]);
    }
  });
}

export function writeMosaicRedrawPlan(project: string, plan: RedrawPlan | null) {
  return archive("readwrite", async (_candidates, plans) => {
    if (plan) plans.put({ project, plan });
    else plans.delete(project);
  });
}

export function clearMosaicRedrawArchive(project: string) {
  return archive("readwrite", async (candidates, plans) => {
    const keys = await result(candidates.index("project").getAllKeys(project));
    for (const key of keys) candidates.delete(key);
    plans.delete(project);
  });
}

export function restoreMosaicRedrawPlan(plan: RedrawPlan | undefined, candidates: Readonly<Record<string, MosaicCandidate>>) {
  if (!plan) return null;
  for (const target of plan.targets) {
    const candidate = candidates[target.image.id];
    if (candidate?.revision !== target.image.sourceHash) continue;
    const reference = plan.groupReferences?.get(target.style.group);
    for (const version of candidate.versions) {
      if (target.promptIds?.[version.model] !== version.id) continue;
      target.pending.delete(version.model);
      if (reference?.source === "generate" && reference.image.id === target.image.id) reference.blob = version.blob;
    }
  }
  return plan.targets.some(target => target.pending.size) ? plan : null;
}
