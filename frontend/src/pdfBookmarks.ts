export type PdfBookmark = { page: number; title: string };
const DB_NAME = "llmchat-pdf-bookmarks";
async function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("documents");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
export async function loadPdfBookmarks(document: string): Promise<PdfBookmark[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("documents", "readonly");
    const request = transaction.objectStore("documents").get(document);
    transaction.oncomplete = () => { db.close(); resolve(request.result || []); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error("读取书签失败")); };
  });
}
export async function savePdfBookmarks(document: string, bookmarks: PdfBookmark[]): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("documents", "readwrite");
    transaction.objectStore("documents").put(bookmarks, document);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error("保存书签失败")); };
  });
}
export function addPdfBookmark(bookmarks: PdfBookmark[], page: number, label: string): PdfBookmark[] {
  if (bookmarks.some(bookmark => bookmark.page === page)) return bookmarks;
  return [...bookmarks, { page, title: label ? `第 ${label} 页` : `第 ${page} 页` }].sort((a, b) => a.page - b.page);
}
