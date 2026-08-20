import type { DocKind } from "./localDocFile";
import { listRecentEpubs, removeRecentEpub } from "./epubSession";
import { listRecentPdfs, removeRecentPdf } from "./pdfSession";

export type LitRecentItem = {
  kind: DocKind;
  id: string;
  filePath: string;
  fileName: string;
  openedAt: number;
  /** PDF page hint for subtitle */
  pageNumber?: number;
  /** PDF content fingerprint when known */
  contentHash?: string;
};

/** Merge PDF + EPUB recent lists, newest first. */
export async function listRecentDocuments(): Promise<LitRecentItem[]> {
  const [pdfs, epubs] = await Promise.all([
    listRecentPdfs(),
    listRecentEpubs(),
  ]);
  const items: LitRecentItem[] = [
    ...pdfs.map((p) => ({
      kind: "pdf" as const,
      id: `pdf:${p.id}`,
      filePath: p.filePath,
      fileName: p.fileName,
      openedAt: p.openedAt || 0,
      pageNumber: p.pageNumber,
      contentHash: p.contentHash,
    })),
    ...epubs.map((e) => ({
      kind: "epub" as const,
      id: `epub:${e.id}`,
      filePath: e.filePath,
      fileName: e.fileName,
      openedAt: e.openedAt || 0,
    })),
  ];
  items.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  return items;
}

export async function removeRecentDocument(
  item: Pick<LitRecentItem, "kind" | "filePath">,
): Promise<void> {
  if (item.kind === "epub") {
    await removeRecentEpub(item.filePath);
  } else {
    await removeRecentPdf(item.filePath);
  }
}

export function recentKindLabel(kind: DocKind): string {
  return kind === "pdf" ? "pdf" : "epub";
}
