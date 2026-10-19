import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyAppearanceContrast } from "@/theme/contrast";
import { applyAppearanceFontVariables } from "@/theme/fonts";
import {
  applyThemePalette,
  parseThemeHalves,
  resolveThemeAppearance,
  resolveThemeHalf,
  subscribeToCustomThemes,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
  type ThemeHalves,
  type ThemePreferenceMode,
} from "@/theme/palette";
import {
  applyChatWidth,
  applyGlassOpacity,
  DEFAULT_APPEARANCE_CONTRAST,
  DEFAULT_CHAT_WIDTH,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_GLASS_OPACITY,
  DEFAULT_INTERFACE_FONT_SIZE,
  DEFAULT_PANEL_ANIMATION_DURATION_MS,
  DEFAULT_PROMPT_FONT_SIZE,
  type ChatWidth,
} from "@/theme/settings";

// The boot script in index.html reads these three keys before React mounts. Keep them as plain strings.
const THEME_KEY = "okaychat:theme";

export interface AppearanceSettings {
  glassOpacity: number;
  appearanceContrast: number;
  panelAnimationDurationMs: number;
  chatWidth: ChatWidth;
  fontFamilySans: string;
  fontFamilyComposer: string;
  fontFamilyCode: string;
  fontSizeInterface: number;
  fontSizePrompt: number;
  fontSizeCode: number;
  fontSmoothing: boolean;
  wordWrap: boolean;
  typographyAdvanced: boolean;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  glassOpacity: DEFAULT_GLASS_OPACITY,
  appearanceContrast: DEFAULT_APPEARANCE_CONTRAST,
  panelAnimationDurationMs: DEFAULT_PANEL_ANIMATION_DURATION_MS,
  chatWidth: DEFAULT_CHAT_WIDTH,
  fontFamilySans: "",
  fontFamilyComposer: "",
  fontFamilyCode: "",
  fontSizeInterface: DEFAULT_INTERFACE_FONT_SIZE,
  fontSizePrompt: DEFAULT_PROMPT_FONT_SIZE,
  fontSizeCode: DEFAULT_CODE_FONT_SIZE,
  fontSmoothing: true,
  wordWrap: true,
  typographyAdvanced: false,
};

interface AppearanceState extends AppearanceSettings {
  /** Theme id, or "" for the default T3 Code palette. */
  theme: string;
  mode: ThemePreferenceMode;
  halves: ThemeHalves | null;
  /** Bumped when custom themes change so subscribers re-resolve. */
  revision: number;
  update: (patch: Partial<AppearanceSettings>) => void;
  reset: (key: keyof AppearanceSettings) => void;
  setTheme: (theme: string) => void;
  setMode: (mode: ThemePreferenceMode) => void;
  setHalf: (appearance: "light" | "dark", themeId: string | null) => void;
  bump: () => void;
}

const readMode = (): ThemePreferenceMode => {
  const raw = localStorage.getItem(THEME_APPEARANCE_MODE_STORAGE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
};

export const useAppearance = create<AppearanceState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_APPEARANCE,
      theme: localStorage.getItem(THEME_KEY) ?? "",
      mode: readMode(),
      halves: parseThemeHalves(localStorage.getItem(THEME_HALVES_STORAGE_KEY)),
      revision: 0,
      update: (patch) => set(patch),
      reset: (key) => set({ [key]: DEFAULT_APPEARANCE[key] } as Partial<AppearanceSettings>),
      setTheme: (theme) => {
        localStorage.setItem(THEME_KEY, theme);
        // Picking a whole theme clears per-mode overrides, as in T3Code.
        localStorage.removeItem(THEME_HALVES_STORAGE_KEY);
        set({ theme, halves: null });
      },
      setMode: (mode) => {
        localStorage.setItem(THEME_APPEARANCE_MODE_STORAGE_KEY, mode);
        set({ mode });
      },
      setHalf: (appearance, themeId) => {
        const next = { ...(get().halves ?? {}) } as { light?: string; dark?: string };
        if (themeId) next[appearance] = themeId;
        else delete next[appearance];
        const halves = next.light || next.dark ? next : null;
        if (halves) localStorage.setItem(THEME_HALVES_STORAGE_KEY, JSON.stringify(halves));
        else localStorage.removeItem(THEME_HALVES_STORAGE_KEY);
        set({ halves });
      },
      bump: () => set({ revision: get().revision + 1 }),
    }),
    {
      name: "okaychat:appearance",
      partialize: (s) => Object.fromEntries(Object.keys(DEFAULT_APPEARANCE).map((k) => [k, s[k as keyof AppearanceSettings]])),
    },
  ),
);

const systemDarkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

/** The appearance currently on screen. */
export function resolvedAppearance(): "light" | "dark" {
  const s = useAppearance.getState();
  return resolveThemeAppearance(s.theme || "system", systemDarkQuery().matches, undefined, s.mode, s.halves);
}

function applyTheme() {
  const s = useAppearance.getState();
  const appearance = resolvedAppearance();
  const themeId = resolveThemeHalf(s.theme, s.halves, appearance);
  const root = document.documentElement;
  root.classList.toggle("dark", appearance === "dark");
  applyThemePalette(themeId, appearance);
  root.dataset.themeSelected = themeId ? "true" : "false";
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", getComputedStyle(root).getPropertyValue("--background").trim() || (appearance === "dark" ? "#0a0a0a" : "#ffffff"));
}

function applySettings(s: AppearanceSettings) {
  const root = document.documentElement;
  applyGlassOpacity(root, s.glassOpacity);
  applyAppearanceContrast(root, s.appearanceContrast);
  applyChatWidth(root, s.chatWidth);
  applyAppearanceFontVariables(root, {
    sans: s.fontFamilySans,
    code: s.fontFamilyCode,
    composer: s.fontFamilyComposer,
    sizeInterface: s.fontSizeInterface,
    sizePrompt: s.fontSizePrompt,
    sizeCode: s.fontSizeCode,
    smoothing: s.fontSmoothing,
  } as Parameters<typeof applyAppearanceFontVariables>[1]);
  root.style.setProperty("--panel-animation-duration", `${s.panelAnimationDurationMs}ms`);
  root.dataset.wordWrap = String(s.wordWrap);
}

/** Mount once at the app root. Keeps the DOM in sync with the store and the OS color scheme. */
export function useApplyAppearance() {
  useEffect(() => {
    applyTheme();
    applySettings(useAppearance.getState());
    const unsubStore = useAppearance.subscribe((s, prev) => {
      if (s.theme !== prev.theme || s.mode !== prev.mode || s.halves !== prev.halves || s.revision !== prev.revision) applyTheme();
      applySettings(s);
    });
    const query = systemDarkQuery();
    const onSystem = () => applyTheme();
    query.addEventListener("change", onSystem);
    const unsubThemes = subscribeToCustomThemes(() => useAppearance.getState().bump());
    return () => {
      unsubStore();
      unsubThemes();
      query.removeEventListener("change", onSystem);
    };
  }, []);
}
