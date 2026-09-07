import type { TransEntry } from "./textTranslate";

/** Mutable worker state; snapshots published to React never change afterward. */
export class IndexedTextEntries {
  private readonly entries: TransEntry[];
  private readonly indices = new Map<string, number>();

  constructor(entries: readonly TransEntry[]) {
    this.entries = entries.slice();
    entries.forEach((entry, index) => this.indices.set(entry.id, index));
  }

  update(ids: Iterable<string>, change: (entry: TransEntry) => TransEntry) {
    for (const id of ids) {
      const index = this.indices.get(id);
      if (index !== undefined) this.entries[index] = change(this.entries[index]);
    }
  }

  snapshot(): TransEntry[] {
    return this.entries.slice();
  }
}
