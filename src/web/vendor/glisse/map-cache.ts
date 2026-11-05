// Bounded, reference-counted cache for encoded lens and rim maps. Upstream
// kept unbounded Maps; this one holds at most 24 entries and 12 MiB, counting
// both the decoded pixels (width * height * 4 per image) and data URL bytes.

export const MAP_CACHE_ENTRIES = 24;
export const MAP_CACHE_BYTES = 12 * 1024 * 1024;

interface Entry<T> {
  value: T;
  bytes: number;
  refs: number;
}

export interface MapCache<T> {
  /** Takes a reference to a cached value, or builds one; null when every slot is in use. */
  acquire(key: string, estimate: number, build: () => { value: T; bytes: number } | null): T | null;
  release(key: string): void;
  clear(): void;
  stats(): { entries: number; bytes: number; live: number };
}

export function createMapCache<T>(limits = { entries: MAP_CACHE_ENTRIES, bytes: MAP_CACHE_BYTES }): MapCache<T> {
  // Map iteration order is insertion order; re-inserting on use keeps it least-recently-used first.
  const entries = new Map<string, Entry<T>>();
  let total = 0;
  const evictFor = (bytes: number) => {
    for (const [key, entry] of entries) {
      if (entries.size < limits.entries && total + bytes <= limits.bytes) return true;
      if (entry.refs > 0) continue;
      entries.delete(key);
      total -= entry.bytes;
    }
    return entries.size < limits.entries && total + bytes <= limits.bytes;
  };
  return {
    acquire(key, estimate, build) {
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
        hit.refs++;
        return hit.value;
      }
      if (estimate > limits.bytes || !evictFor(estimate)) return null;
      const built = build();
      if (!built) return null;
      if (!evictFor(built.bytes)) return null;
      entries.set(key, { value: built.value, bytes: built.bytes, refs: 1 });
      total += built.bytes;
      return built.value;
    },
    release(key) {
      const entry = entries.get(key);
      if (entry && entry.refs > 0) entry.refs--;
    },
    clear() {
      entries.clear();
      total = 0;
    },
    stats() {
      let live = 0;
      for (const entry of entries.values()) if (entry.refs > 0) live++;
      return { entries: entries.size, bytes: total, live };
    },
  };
}
