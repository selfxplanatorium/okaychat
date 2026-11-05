import { create } from "zustand";
import type { ComparisonCreateInput, ComparisonGroupDetail, ComparisonGroupSummary, ComparisonPaneDetail } from "@shared/compare";
import type { ThreadSummary } from "@shared/types";
import type { PlainMessageKey } from "@/i18n";
import { api } from "@/lib/api";

/**
 * Comparison state. The page keeps each pane's live stream in its own `useChat`; this store holds only
 * the saved group, its panes as last read, and which panes have a turn running (for Stop all and the
 * shared composer).
 */

interface CompareState {
  group: ComparisonGroupDetail | null;
  groups: ComparisonGroupSummary[];
  running: Set<string>;
  /** Per-pane effort chosen for this session; the server stores none, so a reload falls back to the account default. */
  efforts: Record<string, string>;
  loading: boolean;
  error: PlainMessageKey | null;
  load: (id: string) => Promise<void>;
  create: (input: ComparisonCreateInput) => Promise<string>;
  promote: (threadId: string) => Promise<ThreadSummary>;
  remove: () => Promise<void>;
  refreshList: () => Promise<void>;
  setRunning: (threadId: string, running: boolean) => void;
  reset: () => void;
}

const detail = (group: ComparisonGroupSummary, panes: ComparisonPaneDetail[]): ComparisonGroupDetail => ({ ...group, panes });

// A slower answer for another group must not replace what is on screen.
let loadToken = 0;

export const useCompare = create<CompareState>((set, get) => ({
  group: null,
  groups: [],
  running: new Set(),
  efforts: {},
  loading: false,
  error: null,
  async load(id) {
    const token = ++loadToken;
    set({ loading: true, error: null });
    try {
      const result = await api<{ group: ComparisonGroupSummary; panes: ComparisonPaneDetail[] }>(`/compare/${id}`);
      if (token !== loadToken) return;
      set({ group: detail(result.group, result.panes), loading: false });
    } catch {
      if (token === loadToken) set({ loading: false, error: "compare.loadFailed" });
    }
  },
  async create(input) {
    const result = await api<{ group: ComparisonGroupSummary; panes: ComparisonPaneDetail[] }>("/compare", { method: "POST", json: input });
    const efforts: Record<string, string> = {};
    result.panes.forEach((pane, index) => {
      const effort = input.models[index]?.effort;
      if (effort) efforts[pane.threadId] = effort;
    });
    set({ group: detail(result.group, result.panes), efforts, error: null });
    void get().refreshList();
    return result.group.id;
  },
  async promote(threadId) {
    const group = get().group;
    if (!group) throw new Error("No comparison");
    const result = await api<{ thread: ThreadSummary; group: ComparisonGroupSummary | null }>(
      `/compare/${group.id}/panes/${threadId}/promote`,
      { method: "POST" },
    );
    const running = new Set(get().running);
    running.delete(threadId);
    if (result.group) {
      const panes = group.panes.filter((pane) => pane.threadId !== threadId);
      set({ group: { ...result.group, panes }, running });
    } else {
      set({ group: null, running });
    }
    void get().refreshList();
    return result.thread;
  },
  async remove() {
    const group = get().group;
    if (!group) return;
    await api(`/compare/${group.id}`, { method: "DELETE" });
    set({ group: null, running: new Set(), efforts: {}, error: null });
    void get().refreshList();
  },
  async refreshList() {
    try {
      const result = await api<{ groups: ComparisonGroupSummary[] }>("/compare");
      set({ groups: result.groups });
    } catch {
      // The recent menu simply stays as it was.
    }
  },
  setRunning(threadId, running) {
    // A pane reports its status on every streamed chunk; only a real change may notify subscribers.
    if (get().running.has(threadId) === running) return;
    const next = new Set(get().running);
    if (running) next.add(threadId);
    else next.delete(threadId);
    set({ running: next });
  },
  reset() {
    set({ group: null, running: new Set(), efforts: {}, error: null });
  },
}));
