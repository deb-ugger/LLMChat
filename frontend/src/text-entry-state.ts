import type { TransEntry } from "./textTranslate";

/** Mutable worker state; snapshots published to React never change afterward. */
export class IndexedTextEntries {
  private readonly entries: TransEntry[];
  private readonly indices = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private readonly counts = { done: 0, failed: 0, skipped: 0, pending: 0 };
  private count(entry: TransEntry, delta: number) {
    const key = entry.status === "done" ? "done" : entry.status === "error" ? "failed" : entry.status === "skipped" ? "skipped" : "pending";
    this.counts[key] += delta;
  }

  constructor(entries: readonly TransEntry[]) {
    this.entries = entries.slice();
    entries.forEach((entry, index) => { this.indices.set(entry.id, index); this.count(entry, 1); });
  }

  update(ids: Iterable<string>, change: (entry: TransEntry) => TransEntry) {
    for (const id of ids) {
      const index = this.indices.get(id);
      if (index !== undefined) {
        const previous = this.entries[index], next = change(previous);
        this.count(previous, -1); this.count(next, 1); this.entries[index] = next; this.dirty.add(id);
      }
    }
  }

  snapshot(): TransEntry[] {
    return this.entries.slice();
  }

  stats() { return { ...this.counts, total: this.entries.length, untranslated: this.counts.pending + this.counts.failed }; }
  changes() { return [...this.dirty].map(id => this.get(id)!); }
  acknowledge(changes: TransEntry[]) { for (const entry of changes) if (this.get(entry.id) === entry) this.dirty.delete(entry.id); }

  get(id: string): TransEntry | undefined {
    const index = this.indices.get(id);
    return index === undefined ? undefined : this.entries[index];
  }
}
