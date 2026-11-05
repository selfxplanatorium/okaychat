import { create } from "zustand";
import {
  EMPTY_TAG_FILTER,
  parseTagFilter,
  type TagCount,
  type TagFilter,
  type TagFilterPreset,
} from "@shared/tags";
import { api } from "@/lib/api";
import type { PlainMessageKey } from "@/i18n";

export { matchesTagFilter } from "@shared/tags";

/**
 * The sidebar's tag filter. It combines with the project filter and the title search (all AND), lives in
 * localStorage per account, and syncs saved presets from the server so another device offers them too.
 */

const STORAGE_PREFIX = "okaychat:tag-filter:";
const key = (accountId: string) => `${STORAGE_PREFIX}${accountId}`;

/** A missing or malformed entry reads as "no filter" rather than breaking the sidebar. */
export function readStoredTagFilter(accountId: string): TagFilter {
  try {
    const raw = localStorage.getItem(key(accountId));
    if (!raw) return EMPTY_TAG_FILTER;
    return parseTagFilter(JSON.parse(raw) as unknown) ?? EMPTY_TAG_FILTER;
  } catch {
    return EMPTY_TAG_FILTER;
  }
}

export function writeStoredTagFilter(accountId: string, filter: TagFilter): void {
  try {
    localStorage.setItem(key(accountId), JSON.stringify(filter));
  } catch {
    // Storage may be unavailable; the filter then only lasts until reload.
  }
}

interface TagFilterState {
  accountId: string | null;
  tags: TagCount[];
  presets: TagFilterPreset[];
  filter: TagFilter;
  busy: boolean;
  error: PlainMessageKey | null;
  load: (accountId: string) => Promise<void>;
  refreshTags: () => Promise<void>;
  setFilter: (next: Partial<TagFilter>) => void;
  clear: () => void;
  applyPreset: (id: string) => void;
  savePreset: (name: string) => Promise<void>;
  renamePreset: (id: string, name: string) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
}

// Answers for a previous account must never land in the current one's store.
let generation = 0;

export const useTagFilter = create<TagFilterState>((set, get) => {
  const commit = (filter: TagFilter) => {
    const accountId = get().accountId;
    if (accountId) writeStoredTagFilter(accountId, filter);
    set({ filter });
  };
  return {
    accountId: null,
    tags: [],
    presets: [],
    filter: EMPTY_TAG_FILTER,
    busy: false,
    error: null,
    async load(accountId) {
      if (get().accountId === accountId) return;
      const token = ++generation;
      set({ accountId, tags: [], presets: [], filter: readStoredTagFilter(accountId), busy: true, error: null });
      try {
        const [tags, presets] = await Promise.all([
          api<{ tags: TagCount[] }>("/tags"),
          api<{ presets: TagFilterPreset[] }>("/tag-filters"),
        ]);
        if (token !== generation) return;
        set({ tags: tags.tags, presets: presets.presets, busy: false });
      } catch {
        if (token !== generation) return;
        set({ busy: false, error: "tags.loadFailed" });
      }
    },
    async refreshTags() {
      const token = generation;
      try {
        const { tags } = await api<{ tags: TagCount[] }>("/tags");
        if (token === generation) set({ tags });
      } catch {
        if (token === generation) set({ error: "tags.loadFailed" });
      }
    },
    setFilter(next) {
      commit({ tags: next.tags ?? get().filter.tags, match: next.match ?? get().filter.match });
    },
    clear() {
      commit(EMPTY_TAG_FILTER);
    },
    applyPreset(id) {
      const preset = get().presets.find((item) => item.id === id);
      if (preset) commit(preset.filter);
    },
    async savePreset(name) {
      set({ error: null });
      try {
        const { preset } = await api<{ preset: TagFilterPreset }>("/tag-filters", {
          method: "POST",
          json: { name, filter: get().filter },
        });
        set((state) => ({ presets: [preset, ...state.presets] }));
      } catch (cause) {
        const message = (cause as { message?: string }).message ?? "";
        set({ error: message.includes("exists") ? "tags.filterNameTaken" : "tags.filterSaveFailed" });
        throw cause;
      }
    },
    async renamePreset(id, name) {
      set({ error: null });
      try {
        const { preset } = await api<{ preset: TagFilterPreset }>(`/tag-filters/${id}`, { method: "PATCH", json: { name } });
        set((state) => ({ presets: state.presets.map((item) => (item.id === id ? preset : item)) }));
      } catch (cause) {
        const message = (cause as { message?: string }).message ?? "";
        set({ error: message.includes("exists") ? "tags.filterNameTaken" : "tags.filterSaveFailed" });
        throw cause;
      }
    },
    async deletePreset(id) {
      set({ error: null });
      try {
        await api(`/tag-filters/${id}`, { method: "DELETE" });
        set((state) => ({ presets: state.presets.filter((item) => item.id !== id) }));
      } catch (cause) {
        set({ error: "tags.filterSaveFailed" });
        throw cause;
      }
    },
  };
});
