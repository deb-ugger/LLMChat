type DocumentIdentity = { filePath: string; fileName: string };
export type RecentDocument<S> = S & { id: string; openedAt: number };

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

/** The PDF and EPUB databases share the same two stores and path-based keys. */
export function readingSessionStore<S extends DocumentIdentity>(
  name: string,
  version: number,
  migrate?: (db: IDBDatabase, oldVersion: number) => void,
) {
  type Entry = RecentDocument<S>;
  async function transaction<T>(
    stores: string[], mode: IDBTransactionMode, fallback: T,
    run: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    let db: IDBDatabase | undefined;
    try {
      const opening = indexedDB.open(name, version);
      opening.onupgradeneeded = event => {
        const database = opening.result;
        migrate?.(database, event.oldVersion);
        if (!database.objectStoreNames.contains("session")) database.createObjectStore("session");
        if (!database.objectStoreNames.contains("recent")) database.createObjectStore("recent", { keyPath: "id" });
      };
      db = await request(opening);
      const tx = db.transaction(stores, mode);
      const committed = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      const [result] = await Promise.all([run(tx).catch(error => { tx.abort(); throw error; }), committed]);
      return result;
    } catch {
      // Reading history is best-effort in private mode and when storage is full.
      return fallback;
    } finally {
      db?.close();
    }
  }

  function newestFirst(a: Entry, b: Entry) { return (b.openedAt || 0) - (a.openedAt || 0); }

  return {
    current: () => transaction<S | null>(["session"], "readonly", null, async tx => {
      const value = await request(tx.objectStore("session").get("current"));
      return value && typeof value.filePath === "string" && value.filePath && !("fileData" in value) ? value : null;
    }),
    list: () => transaction<Entry[]>(["recent"], "readonly", [], async tx => {
      const rows: Entry[] = await request(tx.objectStore("recent").getAll());
      return rows.filter(row => row?.filePath && row.fileName && !("fileData" in row)).sort(newestFirst);
    }),
    recent: (id: string) => transaction<Entry | null>(["recent"], "readonly", null, async tx => {
      const row = await request(tx.objectStore("recent").get(id));
      return row?.filePath && !("fileData" in row) ? row : null;
    }),
    async remove(filePath: string) {
      const path = (filePath || "").trim();
      if (path) await transaction(["recent"], "readwrite", undefined, tx => request(tx.objectStore("recent").delete(path)));
    },
    save: (session: S, previousPath?: string) => transaction(["session","recent"], "readwrite", undefined, async tx => {
      const recent = tx.objectStore("recent");
      if (previousPath) await request(recent.delete(previousPath));
      await request(tx.objectStore("session").put(session, "current"));
      const id = session.filePath;
      await request(recent.put({ ...session, id, openedAt: Date.now() }));
      const rows: Entry[] = await request(recent.getAll());
      for (const row of rows.sort(newestFirst).slice(12)) {
        if (row.id !== id) recent.delete(row.id);
      }
    }),
    update: (meta: S) => transaction(["session","recent"], "readwrite", undefined, async tx => {
      const current = tx.objectStore("session"), recent = tx.objectStore("recent");
      const saved: S | undefined = await request(current.get("current"));
      if (!saved?.filePath || saved.filePath !== meta.filePath || saved.fileName !== meta.fileName) return;
      const session = { ...saved, ...meta };
      await request(current.put(session, "current"));
      const previous: Entry | undefined = await request(recent.get(meta.filePath));
      if (previous) await request(recent.put({ ...session, id: previous.id, openedAt: previous.openedAt }));
    }),
  };
}
