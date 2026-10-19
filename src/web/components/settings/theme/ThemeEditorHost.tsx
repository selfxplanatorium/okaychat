// Ported from T3Code (MIT, Copyright (c) 2026 T3 Tools Inc.). Source: apps/web/src/components/settings/ThemeEditorHost.tsx
// Mounted by the shell, not the settings page, so the panel stays open while the inspector is used on the chat.
import { lazy, Suspense, useCallback, useSyncExternalStore } from "react";

import { useAppearance } from "@/state/appearance";
import {
  getThemeDefinition,
  subscribeToCustomThemes,
  type ThemeAppearance,
  type ThemeDefinition,
} from "@/theme/palette";
import { useThemeEditorStore } from "./themeEditorStore";

const ThemeEditorPanel = lazy(() =>
  import("./ThemeEditorPanel").then((module) => ({ default: module.ThemeEditorPanel })),
);

function useThemeDefinition(id: string | null | undefined) {
  return useSyncExternalStore(
    subscribeToCustomThemes,
    () => (id ? (getThemeDefinition(id) ?? null) : null),
    () => null,
  );
}

export function ThemeEditorHost() {
  const session = useThemeEditorStore((store) => store.session);
  const closeThemeEditor = useThemeEditorStore((store) => store.closeThemeEditor);
  const editingTheme = useThemeDefinition(session?.editingThemeId);
  const seedTheme = useThemeDefinition(session?.seedThemeId);
  // Re-applies the stored palette over the editor's live preview.
  const refreshTheme = useCallback(() => useAppearance.getState().bump(), []);

  const handleSaved = (
    savedTheme: ThemeDefinition,
    { created, mergedAppearance }: { created: boolean; mergedAppearance?: ThemeAppearance },
  ) => {
    const { theme, halves, setTheme } = useAppearance.getState();
    if (!created && !mergedAppearance) {
      // The edited theme may show through the base preference or either half;
      // the preference stays (setTheme would clear the mix), the palette is re-applied.
      const wasActive =
        getThemeDefinition(theme)?.id === savedTheme.id ||
        halves?.light === savedTheme.id ||
        halves?.dark === savedTheme.id;
      if (wasActive) refreshTheme();
      return true;
    }
    setTheme(savedTheme.id);
    return true;
  };

  if (!session) return null;

  return (
    <Suspense fallback={null}>
      <ThemeEditorPanel
        editingTheme={editingTheme}
        initialAppearance={session.initialAppearance}
        key={session.id}
        onOpenChange={(open) => {
          if (!open) closeThemeEditor();
        }}
        onSaved={handleSaved}
        open
        restoreTheme={refreshTheme}
        seedName={session.seedName ?? undefined}
        seedTheme={seedTheme}
      />
    </Suspense>
  );
}
