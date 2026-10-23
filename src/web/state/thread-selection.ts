import { create } from "zustand";
import { pruneSelection, toggleSelection } from "@/lib/selection";

/**
 * Sidebar multi-selection. Rows render deep inside assistant-ui's list, so the state lives here.
 * `order` is the visible row order (local thread ids), published by the list for Shift ranges and
 * Select all; ids that leave it (deleted, archived, filtered out) drop from the selection.
 */
type ThreadSelectionState = {
  active: boolean;
  ids: ReadonlySet<string>;
  anchor: string | null;
  order: readonly string[];
  start: (id: string) => void;
  toggle: (id: string, range: boolean) => void;
  selectAll: () => void;
  clear: () => void;
  exit: () => void;
  setOrder: (order: readonly string[]) => void;
};

export const useThreadSelection = create<ThreadSelectionState>((set, get) => ({
  active: false,
  ids: new Set(),
  anchor: null,
  order: [],
  start: (id) => set({ active: true, ids: new Set([id]), anchor: id }),
  toggle: (id, range) => {
    const { ids, order, anchor } = get();
    set({ ids: toggleSelection(ids, order, id, anchor, range), anchor: id });
  },
  selectAll: () => set({ ids: new Set(get().order) }),
  clear: () => set({ ids: new Set(), anchor: null }),
  exit: () => set({ active: false, ids: new Set(), anchor: null }),
  setOrder: (order) => set({ order, ids: pruneSelection(get().ids, order) }),
}));
