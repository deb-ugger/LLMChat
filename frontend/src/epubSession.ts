import { readingSessionStore, type RecentDocument } from "./readingSessionStore";

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

export type EpubRecentEntry = RecentDocument<EpubSession>;

const store = readingSessionStore<EpubSession>("llmchat-epub-session", 1);
export const saveEpubSession = store.save;
export const saveEpubSessionMeta = store.update;
export const loadEpubSession = store.current;
export const loadRecentEpub = store.recent;
export const removeRecentEpub = store.remove;

export async function listRecentEpubs(): Promise<EpubRecentSummary[]> {
  return (await store.list()).map((e) => ({
    id: e.id,
    filePath: e.filePath,
    fileName: e.fileName,
    fileSize: e.fileSize,
    lastModified: e.lastModified,
    openedAt: e.openedAt,
    cfi: e.cfi || "",
  }));
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
