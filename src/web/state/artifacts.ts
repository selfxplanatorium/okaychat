import { create } from "zustand";

interface ArtifactPanelState {
  open: { threadId: string; id: string; version?: number } | null;
  /** Bumped on every show, so an open panel refetches and reselects. */
  revision: number;
  /** Omit `version` to show the latest. */
  show: (threadId: string, id: string, version?: number) => void;
  close: () => void;
}

export const useArtifactPanel = create<ArtifactPanelState>((set) => ({
  open: null,
  revision: 0,
  show: (threadId, id, version) => set((s) => ({ open: { threadId, id, version }, revision: s.revision + 1 })),
  close: () => set({ open: null }),
}));
