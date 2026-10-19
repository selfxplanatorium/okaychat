// Ported from T3Code (MIT, Copyright (c) 2026 T3 Tools Inc.). Source: apps/web/src/components/settings/themeEditorStore.ts
import { create } from "zustand";

import type { ThemeAppearance } from "@/theme/palette";

export type ThemeEditorSessionInput = {
  editingThemeId: string | null;
  seedThemeId: string | null;
  seedName: string | null;
  initialAppearance: ThemeAppearance;
};

export type ThemeEditorSession = ThemeEditorSessionInput & {
  id: number;
};

type ThemeEditorStore = {
  session: ThemeEditorSession | null;
  openThemeEditor: (session: ThemeEditorSessionInput) => void;
  closeThemeEditor: () => void;
};

let nextSessionId = 0;

export const useThemeEditorStore = create<ThemeEditorStore>((set) => ({
  session: null,
  openThemeEditor: (session) => set({ session: { ...session, id: ++nextSessionId } }),
  closeThemeEditor: () => set({ session: null }),
}));
