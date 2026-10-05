/* Polyphony caps for files mode: a cap per sound id and a global cap, oldest voice stopped first. */

interface Entry<T> {
  id: string;
  voice: T;
}

export class VoiceCap<T> {
  private entries: Entry<T>[] = [];
  private readonly perId: number;
  private readonly total: number;

  constructor(opts: { perId: number; total: number }) {
    this.perId = Math.max(1, Math.floor(opts.perId));
    this.total = Math.max(1, Math.floor(opts.total));
  }

  get size(): number {
    return this.entries.length;
  }

  /** The voices that must stop so that one more of `id` fits, oldest first. They are already forgotten here. */
  evictFor(id: string): T[] {
    const evicted: T[] = [];
    const take = (match: (e: Entry<T>) => boolean) => {
      const index = this.entries.findIndex(match);
      const entry = this.entries[index];
      if (entry) {
        this.entries.splice(index, 1);
        evicted.push(entry.voice);
      }
      return entry !== undefined;
    };
    while (this.countOf(id) >= this.perId && take((e) => e.id === id)) {
      // keep taking the oldest of this id
    }
    while (this.entries.length >= this.total && take(() => true)) {
      // keep taking the oldest overall
    }
    return evicted;
  }

  add(id: string, voice: T): void {
    this.entries.push({ id, voice });
  }

  remove(voice: T): void {
    this.entries = this.entries.filter((e) => e.voice !== voice);
  }

  countOf(id: string): number {
    let n = 0;
    for (const e of this.entries) {
      if (e.id === id) {
        n += 1;
      }
    }
    return n;
  }

  /** Forget every voice and return them. */
  clear(): T[] {
    const all = this.entries.map((e) => e.voice);
    this.entries = [];
    return all;
  }
}
