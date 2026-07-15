const DB_NAME = "llmchat-pdf-session";
const DB_VERSION = 2;
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
  fileName: string;
  fileSize: number;
  lastModified: number;
  viewMode: ViewMode;
  pageNumber: number;
  scale: number;
  scrollTop: number;
  scrollLeft: number;
  outlineOpen: boolean;
};

export type PdfSession = PdfSessionMeta & {
  fileData: ArrayBuffer;
};

export type PdfRecentSummary = {
  id: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  openedAt: number;
  pageNumber: number;
};

export type PdfRecentEntry = PdfSession & {
  id: string;
  openedAt: number;
};

export function makePdfId(
  fileName: string,
  fileSize: number,
  lastModified: number,
): string {
  return `${fileName}::${fileSize}::${lastModified}`;
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
  const all = (await idbReq(store.getAll())) as PdfRecentEntry[];
  all.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  for (let i = MAX_RECENT; i < all.length; i++) {
    if (keepId && all[i].id === keepId) continue;
    store.delete(all[i].id);
  }
}

export async function loadPdfSession(): Promise<PdfSession | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_CURRENT, "readonly");
    const raw = await idbReq(tx.objectStore(STORE_CURRENT).get(CURRENT_KEY));
    db.close();
    if (!raw || !(raw as PdfSession).fileData) return null;
    return raw as PdfSession;
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
      .filter((e) => e?.fileName && e.fileData)
      .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
      .map((e) => ({
        id: e.id,
        fileName: e.fileName,
        fileSize: e.fileSize,
        lastModified: e.lastModified,
        openedAt: e.openedAt,
        pageNumber: e.pageNumber || 1,
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
    if (!raw?.fileData) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function savePdfSession(session: PdfSession): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction([STORE_CURRENT, STORE_RECENT], "readwrite");
    const current = tx.objectStore(STORE_CURRENT);
    const recent = tx.objectStore(STORE_RECENT);
    await idbReq(current.put(session, CURRENT_KEY));

    const id = makePdfId(
      session.fileName,
      session.fileSize,
      session.lastModified,
    );
    const entry: PdfRecentEntry = {
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
      !existing?.fileData ||
      existing.fileName !== meta.fileName ||
      existing.fileSize !== meta.fileSize ||
      existing.lastModified !== meta.lastModified
    ) {
      db.close();
      return;
    }
    const next: PdfSession = { ...existing, ...meta };
    await idbReq(currentStore.put(next, CURRENT_KEY));

    const id = makePdfId(meta.fileName, meta.fileSize, meta.lastModified);
    const prevRecent = (await idbReq(
      recentStore.get(id),
    )) as PdfRecentEntry | undefined;
    const entry: PdfRecentEntry = {
      ...next,
      id,
      openedAt: prevRecent?.openedAt ?? Date.now(),
      fileData: prevRecent?.fileData ?? existing.fileData,
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
  keepUi: Pick<PdfSessionMeta, "viewMode" | "scale" | "outlineOpen">,
): Promise<void> {
  const session: PdfSession = {
    fileName: entry.fileName,
    fileSize: entry.fileSize,
    lastModified: entry.lastModified,
    fileData: entry.fileData,
    pageNumber: position.pageNumber,
    scrollTop: position.scrollTop,
    scrollLeft: position.scrollLeft,
    viewMode: keepUi.viewMode,
    scale: keepUi.scale,
    outlineOpen: keepUi.outlineOpen,
  };
  await savePdfSession(session);
}

export function fileToArrayBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}
