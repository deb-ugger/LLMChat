import type { PaddleOcrLine } from "./ocr/paddleOcr";
import { logRuntimeError } from "./runtimeLog";

type Data = {
  ocr: { lines: [number, PaddleOcrLine][]; checked: number[] };
  redraw: Blob;
};
type CacheEntry<T> = { key: string; value: T; savedAt: number; bytes: number };
const limits = { ocr: { entries: 128, bytes: 2 * 1024 ** 2 }, redraw: { entries: 32, bytes: 64 * 1024 ** 2 } };

async function storage<T>(kind: keyof Data, mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>) {
  let db: IDBDatabase | undefined;
  try {
    const request = indexedDB.open("llmchat-game-image-checkpoints", 1);
    request.onupgradeneeded = () => {
      for (const name of ["ocr", "redraw"])
        request.result.createObjectStore(name, { keyPath: "key" }).createIndex("age", ["savedAt", "bytes"]);
    };
    db = await result(request);
    const transaction = db.transaction(kind, mode);
    const complete = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    const [value] = await Promise.all([run(transaction.objectStore(kind)), complete]);
    return value;
  } catch (error) {
    logRuntimeError("game-image-checkpoint", error);
  } finally {
    db?.close();
  }
}

function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function gameImageDigest(bytes: BufferSource) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

export function readImageCheckpoint<K extends keyof Data>(kind: K, key: string) {
  return storage(kind, "readonly", async store => {
    const entry: CacheEntry<Data[K]> | undefined = await result(store.get(key));
    return entry?.value;
  });
}

export function saveImageCheckpoint<K extends keyof Data>(kind: K, key: string, value: Data[K]) {
  const limit = limits[kind];
  const bytes = value instanceof Blob ? value.size : JSON.stringify(value).length * 2;
  if (bytes > limit.bytes) return;
  return storage(kind, "readwrite", async store => {
    await result(store.put({ key, value, savedAt: Date.now(), bytes }));
    await new Promise<void>((resolve, reject) => {
      const cursor = store.index("age").openKeyCursor(null, "prev");
      let count = 0, total = 0;
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) { resolve(); return; }
        const [, size] = entry.key as [number, number];
        total += size;
        if (++count > limit.entries || total > limit.bytes) store.delete(entry.primaryKey);
        entry.continue();
      };
    });
  });
}

export function removeImageCheckpoint(kind: keyof Data, key: string) {
  return storage(kind, "readwrite", store => result(store.delete(key)));
}
