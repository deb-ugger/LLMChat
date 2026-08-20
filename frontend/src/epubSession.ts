const DB_NAME = "llmchat-epub-session";
const DB_VERSION = 1;
const STORE_CURRENT = "session";
const STORE_RECENT = "recent";
const CURRENT_KEY = "current";
const MAX_RECENT = 12;

export type EpubSessionMeta = {
  filePath: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  /** EPUB CFI for reading position */
  cfi: string;
  outlineOpen: boolean;
};

export type EpubSession = EpubSessionMeta;

export type EpubRecentSummary = {
  id: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  openedAt: number;
  cfi: string;
};

export type EpubRecentEntry = EpubSession & {
  id: string;
  openedAt: number;
};

export function makeEpubId(filePath: string): string {
  return filePath;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CURRENT)) {
        db.createObjectStore(STORE_CURRENT);
      }
      if (!db.objectStoreNames.contains(STORE_RECENT)) {
        db.createObjectStore(STORE_RECENT, { keyPath: "id" });
      }
    };
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

async function pruneRecent(
  store: IDBObjectStore,
  keepId?: string,
): Promise<void> {
  const all = (await idbReq(store.getAll())) as EpubRecentEntry[];
  all.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  for (let i = MAX_RECENT; i < all.length; i++) {
    if (keepId && all[i].id === keepId) continue;
    store.delete(all[i].id);
  }
}

function isPathSession(raw: unknown): raw is EpubSession {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return typeof o.filePath === "string" && !!o.filePath && !("fileData" in o);
}

export async function loadEpubSession(): Promise<EpubSession | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_CURRENT, "readonly");
    const raw = await idbReq(tx.objectStore(STORE_CURRENT).get(CURRENT_KEY));
    db.close();
    if (!isPathSession(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function listRecentEpubs(): Promise<EpubRecentSummary[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_RECENT, "readonly");
    const all = (await idbReq(
      tx.objectStore(STORE_RECENT).getAll(),
    )) as EpubRecentEntry[];
    db.close();
    return all
      .filter((e) => e?.filePath && e?.fileName && !("fileData" in e))
      .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
      .map((e) => ({
        id: e.id,
        filePath: e.filePath,
        fileName: e.fileName,
        fileSize: e.fileSize,
        lastModified: e.lastModified,
        openedAt: e.openedAt,
        cfi: e.cfi || "",
      }));
  } catch {
    return [];
  }
}

export async function loadRecentEpub(
  id: string,
): Promise<EpubRecentEntry | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_RECENT, "readonly");
    const raw = (await idbReq(
      tx.objectStore(STORE_RECENT).get(id),
    )) as EpubRecentEntry | undefined;
    db.close();
    if (!raw?.filePath || "fileData" in raw) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Remove one entry from the recent list (does not clear the current session). */
export async function removeRecentEpub(filePath: string): Promise<void> {
  const path = (filePath || "").trim();
  if (!path) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_RECENT, "readwrite");
    await idbReq(tx.objectStore(STORE_RECENT).delete(makeEpubId(path)));
    db.close();
  } catch {
    // ignore
  }
}

export async function saveEpubSession(session: EpubSession): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction([STORE_CURRENT, STORE_RECENT], "readwrite");
    const current = tx.objectStore(STORE_CURRENT);
    const recent = tx.objectStore(STORE_RECENT);
    await idbReq(current.put(session, CURRENT_KEY));

    const id = makeEpubId(session.filePath);
    const entry: EpubRecentEntry = {
      ...session,
      id,
      openedAt: Date.now(),
    };
    await idbReq(recent.put(entry));
    await pruneRecent(recent, id);
    db.close();
  } catch {
    // ignore quota / private mode failures
  }
}

export async function saveEpubSessionMeta(
  meta: EpubSessionMeta,
): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction([STORE_CURRENT, STORE_RECENT], "readwrite");
    const currentStore = tx.objectStore(STORE_CURRENT);
    const recentStore = tx.objectStore(STORE_RECENT);
    const existing = (await idbReq(
      currentStore.get(CURRENT_KEY),
    )) as EpubSession | undefined;
    if (
      !existing?.filePath ||
      existing.filePath !== meta.filePath ||
      existing.fileName !== meta.fileName
    ) {
      db.close();
      return;
    }
    const next: EpubSession = { ...existing, ...meta };
    await idbReq(currentStore.put(next, CURRENT_KEY));

    const id = makeEpubId(meta.filePath);
    const prevRecent = (await idbReq(
      recentStore.get(id),
    )) as EpubRecentEntry | undefined;
    const entry: EpubRecentEntry = {
      ...next,
      id,
      openedAt: prevRecent?.openedAt ?? Date.now(),
    };
    await idbReq(recentStore.put(entry));
    db.close();
  } catch {
    // ignore
  }
}

export async function touchRecentEpubAsCurrent(
  entry: EpubRecentEntry,
  position: Pick<EpubSessionMeta, "cfi">,
  keepUi: Pick<EpubSessionMeta, "outlineOpen">,
): Promise<void> {
  const session: EpubSession = {
    filePath: entry.filePath,
    fileName: entry.fileName,
    fileSize: entry.fileSize,
    lastModified: entry.lastModified,
    cfi: position.cfi,
    outlineOpen: keepUi.outlineOpen,
  };
  await saveEpubSession(session);
}
