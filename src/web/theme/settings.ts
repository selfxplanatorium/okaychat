// Ported from T3Code (MIT, Copyright (c) 2026 T3 Tools Inc.).
// Source: packages/contracts/src/settings.ts (ranges and defaults for the
// Appearance settings) and apps/web/src/routes/__root.tsx (glass and chat
// width DOM writes). Effect Schema replaced with plain range checks.

// Glass (translucent surfaces: dialogs, dropdowns, alerts).
export const MIN_GLASS_OPACITY = 40;
export const MAX_GLASS_OPACITY = 100;
export const DEFAULT_GLASS_OPACITY = 80;

// Contrast multiplier for text and borders (100 = theme as designed).
export const MIN_APPEARANCE_CONTRAST = 50;
export const MAX_APPEARANCE_CONTRAST = 200;
export const DEFAULT_APPEARANCE_CONTRAST = 100;

// Panel open/close animation length. 0 disables animation.
export const MIN_PANEL_ANIMATION_DURATION_MS = 0;
export const MAX_PANEL_ANIMATION_DURATION_MS = 400;
export const DEFAULT_PANEL_ANIMATION_DURATION_MS = 0;

// Chat content column width.
export const CHAT_WIDTHS = ["comfortable", "wide", "full"] as const;
export type ChatWidth = (typeof CHAT_WIDTHS)[number];
export const DEFAULT_CHAT_WIDTH: ChatWidth = "comfortable";

// Font sizes in px.
export const MIN_INTERFACE_FONT_SIZE = 12;
export const MAX_INTERFACE_FONT_SIZE = 20;
export const DEFAULT_INTERFACE_FONT_SIZE = 16;

export const MIN_PROMPT_FONT_SIZE = 12;
export const MAX_PROMPT_FONT_SIZE = 20;
export const DEFAULT_PROMPT_FONT_SIZE = 14;

export const MIN_CODE_FONT_SIZE = 10;
export const MAX_CODE_FONT_SIZE = 18;
export const DEFAULT_CODE_FONT_SIZE = 13;

export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 20;
export const DEFAULT_TERMINAL_FONT_SIZE = 12;

// Font family strings are free text, capped at this length.
export const FONT_FAMILY_MAX_LENGTH = 200;

/** Rounds to an integer inside [min, max]. Non-finite input yields the fallback. */
export function clampToRange(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampGlassOpacity(value: number): number {
  return clampToRange(value, MIN_GLASS_OPACITY, MAX_GLASS_OPACITY, DEFAULT_GLASS_OPACITY);
}

export function clampAppearanceContrast(value: number): number {
  return clampToRange(
    value,
    MIN_APPEARANCE_CONTRAST,
    MAX_APPEARANCE_CONTRAST,
    DEFAULT_APPEARANCE_CONTRAST,
  );
}

export function clampPanelAnimationDurationMs(value: number): number {
  return clampToRange(
    value,
    MIN_PANEL_ANIMATION_DURATION_MS,
    MAX_PANEL_ANIMATION_DURATION_MS,
    DEFAULT_PANEL_ANIMATION_DURATION_MS,
  );
}

export function isChatWidth(value: unknown): value is ChatWidth {
  return typeof value === "string" && (CHAT_WIDTHS as readonly string[]).includes(value);
}

/**
 * Sets `--glass-opacity`. At 100 the blur is removed too, since an opaque
 * surface has nothing to blur. Below 100, the stylesheet's blur value applies.
 */
export function applyGlassOpacity(root: HTMLElement, opacity: number): void {
  const value = clampGlassOpacity(opacity);
  root.style.setProperty("--glass-opacity", `${value}%`);
  if (value === 100) {
    root.style.setProperty("--glass-blur", "0px");
  } else {
    root.style.removeProperty("--glass-blur");
  }
}

/** Sets `data-chat-width`, which the stylesheet maps to `--chat-content-max-width`. */
export function applyChatWidth(root: HTMLElement, width: ChatWidth): void {
  root.dataset.chatWidth = isChatWidth(width) ? width : DEFAULT_CHAT_WIDTH;
}
