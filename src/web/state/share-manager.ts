import { create } from "zustand";
import type { ShareCreateInput, ShareLink, ShareUpdateInput } from "@shared/share-links";
import { api } from "@/lib/api";
import type { PlainMessageKey } from "@/i18n";

/** The account-wide share manager. Its list is server-paginated; the pane's own list stays local. */

export type ShareFilter = "all" | "active" | "expired";

interface ShareManagerState {
  open: boolean;
  /** Null until the first answer, so the dialog can show a skeleton rather than "no links". */
  shares: ShareLink[] | null;
  cursor: string | null;
  filter: ShareFilter;
  sharingDisabled: boolean;
  busy: boolean;
  error: PlainMessageKey | null;
  openManager: () => void;
  close: () => void;
  load: (filter?: ShareFilter, reset?: boolean) => Promise<void>;
  more: () => Promise<void>;
  create: (threadId: string, input: ShareCreateInput) => Promise<ShareLink>;
  update: (token: string, input: ShareUpdateInput) => Promise<ShareLink>;
  revoke: (token: string) => Promise<void>;
}

const query = (filter: ShareFilter, cursor: string | null) =>
  `/shares?state=${filter}&limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

export const useShareManager = create<ShareManagerState>((set, get) => ({
  open: false,
  shares: null,
  cursor: null,
  filter: "all",
  sharingDisabled: false,
  busy: false,
  error: null,
  openManager() {
    set({ open: true });
    if (get().shares === null) void get().load(get().filter, true);
  },
  close() {
    set({ open: false, error: null });
  },
  async load(filter = get().filter, reset = true) {
    set({ busy: true, error: null, filter });
    try {
      const result = await api<{ shares: ShareLink[]; nextCursor: string | null; sharingDisabled: boolean }>(query(filter, reset ? null : get().cursor));
      set((state) => ({
        shares: reset ? result.shares : [...(state.shares ?? []), ...result.shares],
        cursor: result.nextCursor,
        sharingDisabled: result.sharingDisabled,
        busy: false,
      }));
    } catch {
      set({ busy: false, error: "share.loadFailed" });
    }
  },
  async more() {
    if (!get().cursor || get().busy) return;
    await get().load(get().filter, false);
  },
  async create(threadId, input) {
    const result = await api<{ share: ShareLink }>(`/threads/${threadId}/shares`, { method: "POST", json: input });
    set((state) => ({ shares: [result.share, ...(state.shares ?? [])] }));
    return result.share;
  },
  async update(token, input) {
    const result = await api<{ share: ShareLink }>(`/shares/${token}`, { method: "PATCH", json: input });
    set((state) => ({ shares: (state.shares ?? []).map((share) => (share.token === token ? result.share : share)) }));
    return result.share;
  },
  async revoke(token) {
    await api(`/shares/${token}`, { method: "DELETE" });
    set((state) => ({ shares: (state.shares ?? []).filter((share) => share.token !== token) }));
  },
}));

export const openShareManager = () => {
  useShareManager.getState().openManager();
};
