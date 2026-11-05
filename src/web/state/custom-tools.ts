import { create } from "zustand";
import type { SelfPermissions } from "@shared/permissions";
import type { CleanupItem, ToolDetail, ToolSummary } from "@shared/custom-tools";
import { ApiError, api } from "@/lib/api";
import { t } from "@/i18n";

// Workspace data only. Drafts, secret plaintext and review tokens stay in components: no persisted
// middleware, no localStorage outbox, and no devtools serialization of credentials.

interface CustomToolsState {
  userId: string | null;
  generation: number;
  feature: boolean | null;
  items: ToolSummary[];
  cleanup: CleanupItem[];
  detail: ToolDetail | null;
  loading: boolean;
  error: string | null;
  begin: (userId: string) => void;
  load: (userId: string, options?: { detailId?: string | null }) => Promise<void>;
  loadDetail: (userId: string, id: string) => Promise<void>;
  refresh: (userId: string, detailId?: string | null) => Promise<void>;
  clear: () => void;
}

const empty = () => ({
  feature: null as boolean | null,
  items: [] as ToolSummary[],
  cleanup: [] as CleanupItem[],
  detail: null as ToolDetail | null,
  loading: false,
  error: null as string | null,
});

const message = (error: unknown) => (error instanceof ApiError ? error.message : error instanceof Error ? error.message : t("common.somethingWentWrong"));

export const useCustomTools = create<CustomToolsState>((set, get) => ({
  userId: null,
  generation: 0,
  ...empty(),
  begin(userId) {
    if (get().userId === userId) return;
    set({ userId, generation: get().generation + 1, ...empty() });
  },
  async load(userId, options) {
    get().begin(userId);
    const generation = get().generation;
    const current = () => get().userId === userId && get().generation === generation;
    set({ loading: true, error: null });
    try {
      const self = await api<SelfPermissions>("/permissions");
      if (!current()) return;
      const feature = self.features.customTools === true;
      if (!feature) {
        const cleanup = await api<{ items: CleanupItem[] }>("/custom-tools/cleanup");
        if (!current()) return;
        set({ feature, cleanup: cleanup.items, items: [], detail: null, loading: false });
        return;
      }
      const list = await api<{ items: ToolSummary[] }>("/custom-tools");
      if (!current()) return;
      const detail = options?.detailId ? await api<{ tool: ToolDetail }>(`/custom-tools/${encodeURIComponent(options.detailId)}`).then((value) => value.tool).catch(() => null) : null;
      if (!current()) return;
      set({ feature, items: list.items, cleanup: [], detail, loading: false });
    } catch (error) {
      if (!current()) return;
      set({ loading: false, error: message(error) });
    }
  },
  async loadDetail(userId, id) {
    get().begin(userId);
    const generation = get().generation;
    set({ loading: true, error: null });
    try {
      const detail = await api<{ tool: ToolDetail }>(`/custom-tools/${encodeURIComponent(id)}`);
      if (get().userId !== userId || get().generation !== generation) return;
      set({ detail: detail.tool, loading: false });
    } catch (error) {
      if (get().userId !== userId || get().generation !== generation) return;
      set({ loading: false, error: message(error), detail: null });
    }
  },
  async refresh(userId, detailId) {
    if (get().userId !== userId) return;
    await get().load(userId, { detailId });
  },
  clear() {
    set({ userId: null, generation: get().generation + 1, ...empty() });
  },
}));
