import { readingSessionStore, type RecentDocument } from "./readingSessionStore";

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

export type PdfRecentEntry = RecentDocument<PdfSession>;

const store = readingSessionStore<PdfSession>("llmchat-pdf-session", 3, (db, oldVersion) => {
  if (oldVersion < 3) {
    // Version 3 replaced full PDF blobs with path-only sessions.
    for (const name of ["session", "recent"]) if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
  }
});

function normalizedPage(session: PdfSession): PdfSession {
  return { ...session, pageNumber: Math.max(1, Math.floor(Number(session.pageNumber)) || 1) };
}
export function savePdfSession(session: PdfSession) { return store.save(normalizedPage(session)); }
export function savePdfSessionMeta(meta: PdfSessionMeta) { return store.update(normalizedPage(meta)); }
export function relocatePdfRecent(oldPath: string, next: PdfSession) { return store.save(next, (oldPath || "").trim()); }
export const loadPdfSession = store.current;
export const loadRecentPdf = store.recent;
export const removeRecentPdf = store.remove;

export async function listRecentPdfs(): Promise<PdfRecentSummary[]> {
  return (await store.list()).map((e) => ({
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
}

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
