// Ported from T3Code (MIT, Copyright (c) 2026 T3 Tools Inc.).
// Source: apps/web/src/appearanceContrast.ts

import { clampAppearanceContrast } from "./settings";

/**
 * Writes the three contrast variables read by the `--contrast-*` tokens in
 * theme.css. The base is capped at 100%. The boost is the amount above 100,
 * applied toward white (dark themes) or black (light themes). The border boost
 * is a quarter of that.
 */
export function applyAppearanceContrast(root: HTMLElement, contrast: number): void {
  const value = clampAppearanceContrast(contrast);
  root.style.setProperty("--appearance-contrast-base", `${Math.min(value, 100)}%`);
  root.style.setProperty("--appearance-contrast-boost", `${Math.max(value - 100, 0)}%`);
  root.style.setProperty(
    "--appearance-contrast-border-boost",
    `${Math.max(value - 100, 0) / 4}%`,
  );
}
