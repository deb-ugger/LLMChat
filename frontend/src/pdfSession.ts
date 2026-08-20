const DB_NAME = "llmchat-pdf-session";
/** v3: path-only sessions (no fileData blob). */
const DB_VERSION = 3;
const STORE_CURRENT = "session";
const STORE_RECENT = "recent";
const CURRENT_KEY = "current";
const MAX_RECENT = 12;

export type ViewMode =
  | "single"
  | "single-scroll"
  | "double"
  | "double-scroll";

export type PdfSessionMeta = {
  filePath: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  viewMode: ViewMode;
  pageNumber: number;
  scale: number;
  scrollTop: number;
  scrollLeft: number;
  outlineOpen: boolean;
  /** SHA-256 of file bytes; missing on legacy entries. */
  contentHash?: string;
};

export type PdfSession = PdfSessionMeta;

export type PdfRecentSummary = {
  id: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  openedAt: number;
  pageNumber: number;
  contentHash?: string;
};

export type PdfRecentEntry = PdfSession & {
  id: string;
  openedAt: number;
};

export function makePdfId(filePath: string): string {
  return filePath;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const oldVersion = ev.oldVersion;
      if (oldVersion < 3) {
        // Drop legacy stores that may contain full PDF blobs.
        if (db.objectStoreNames.contains(STORE_CURRENT)) {
          db.deleteObjectStore(STORE_CURRENT);
        }
        if (db.objectStoreNames.contains(STORE_RECENT)) {
          db.deleteObjectStore(STORE_RECENT);
        }
      }
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
  const all = (await idbReq(store.getAll())) as PdfRecentEntry[];
  all.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  for (let i = MAX_RECENT; i < all.length; i++) {
    if (keepId && all[i].id === keepId) continue;
    store.delete(all[i].id);
  }
}

function isPathSession(raw: unknown): raw is PdfSession {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return typeof o.filePath === "string" && !!o.filePath && !("fileData" in o);
}

export async function loadPdfSession(): Promise<PdfSession | null> {
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

export async function listRecentPdfs(): Promise<PdfRecentSummary[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_RECENT, "readonly");
    const all = (await idbReq(
      tx.objectStore(STORE_RECENT).getAll(),
    )) as PdfRecentEntry[];
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
        pageNumber: Math.max(
          1,
          Math.floor(Number(e.pageNumber)) || 1,
        ),
        contentHash: e.contentHash || undefined,
      }));
  } catch {
    return [];
  }
}

export async function loadRecentPdf(
  id: string,
): Promise<PdfRecentEntry | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_RECENT, "readonly");
    const raw = (await idbReq(
      tx.objectStore(STORE_RECENT).get(id),
    )) as PdfRecentEntry | undefined;
    db.close();
    if (!raw?.filePath || "fileData" in raw) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Remove one entry from the recent list (does not clear the current session). */
export async function removeRecentPdf(filePath: string): Promise<void> {
  const path = (filePath || "").trim();
  if (!path) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_RECENT, "readwrite");
    await idbReq(tx.objectStore(STORE_RECENT).delete(makePdfId(path)));
    db.close();
  } catch {
    // ignore
  }
}

export async function savePdfSession(session: PdfSession): Promise<void> {
  try {
    const normalized: PdfSession = {
      ...session,
      pageNumber: Math.max(1, Math.floor(Number(session.pageNumber)) || 1),
    };
    const db = await openDb();
    const tx = db.transaction([STORE_CURRENT, STORE_RECENT], "readwrite");
    const current = tx.objectStore(STORE_CURRENT);
    const recent = tx.objectStore(STORE_RECENT);
    await idbReq(current.put(normalized, CURRENT_KEY));

    const id = makePdfId(normalized.filePath);
    const entry: PdfRecentEntry = {
      ...normalized,
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

export async function savePdfSessionMeta(
  meta: PdfSessionMeta,
): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction([STORE_CURRENT, STORE_RECENT], "readwrite");
    const currentStore = tx.objectStore(STORE_CURRENT);
    const recentStore = tx.objectStore(STORE_RECENT);
    const existing = (await idbReq(
      currentStore.get(CURRENT_KEY),
    )) as PdfSession | undefined;
    if (
      !existing?.filePath ||
      existing.filePath !== meta.filePath ||
      existing.fileName !== meta.fileName
    ) {
      db.close();
      return;
    }
    const next: PdfSession = {
      ...existing,
      ...meta,
      pageNumber: Math.max(1, Math.floor(Number(meta.pageNumber)) || 1),
    };
    await idbReq(currentStore.put(next, CURRENT_KEY));

    const id = makePdfId(meta.filePath);
    const prevRecent = (await idbReq(
      recentStore.get(id),
    )) as PdfRecentEntry | undefined;
    const entry: PdfRecentEntry = {
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

/** Mark a recent entry as current and bump openedAt. */
export async function touchRecentAsCurrent(
  entry: PdfRecentEntry,
  position: Pick<PdfSessionMeta, "pageNumber" | "scrollTop" | "scrollLeft">,
  keepUi: Pick<
    PdfSessionMeta,
    "viewMode" | "scale" | "outlineOpen" | "contentHash"
  >,
): Promise<void> {
  const session: PdfSession = {
    filePath: entry.filePath,
    fileName: entry.fileName,
    fileSize: entry.fileSize,
    lastModified: entry.lastModified,
    pageNumber: position.pageNumber,
    scrollTop: position.scrollTop,
    scrollLeft: position.scrollLeft,
    viewMode: keepUi.viewMode,
    scale: keepUi.scale,
    outlineOpen: keepUi.outlineOpen,
    contentHash: keepUi.contentHash ?? entry.contentHash,
  };
  await savePdfSession(session);
}

/**
 * Move a recent/session entry from oldPath to a new path while keeping
 * reading progress (and optionally contentHash).
 */
export async function relocatePdfRecent(
  oldPath: string,
  next: PdfSession,
): Promise<void> {
  const from = (oldPath || "").trim();
  try {
    const db = await openDb();
    const tx = db.transaction([STORE_CURRENT, STORE_RECENT], "readwrite");
    const current = tx.objectStore(STORE_CURRENT);
    const recent = tx.objectStore(STORE_RECENT);
    if (from) {
      await idbReq(recent.delete(makePdfId(from)));
    }
    await idbReq(current.put(next, CURRENT_KEY));
    const id = makePdfId(next.filePath);
    const entry: PdfRecentEntry = {
      ...next,
      id,
      openedAt: Date.now(),
    };
    await idbReq(recent.put(entry));
    await pruneRecent(recent, id);
    db.close();
  } catch {
    // ignore
  }
}
