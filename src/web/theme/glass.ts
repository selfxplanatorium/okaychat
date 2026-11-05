// Glass material preferences: sanitizing, preset math, and the root tokens
// theme/glass.css reads. Pure apart from `applyGlassAppearance`, which only
// writes the values it is given.
import {
  GLASS_DEFAULTS,
  GLASS_FAMILIES,
  GLASS_FAMILY_KEYS,
  GLASS_NUMERIC_KEYS,
  GLASS_PERFORMANCE,
  GLASS_PRESET_VALUES,
  GLASS_PRESETS,
  GLASS_RANGES,
  glassPresetOf,
  type GlassFamily,
  type GlassNumericKey,
  type GlassPreferences,
  type GlassPresetName,
  type GlassTuple,
} from "../../shared/appearance";
import { DEFAULT_GLASS_OPACITY } from "./settings";

export type GlassTier = "high" | "balanced" | "css" | "solid";

/** Clamps a numeric Glass value into its range; non-finite input falls back to the default. */
export function clampGlassValue(key: GlassNumericKey, value: unknown): number {
  const { min, max } = GLASS_RANGES[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return GLASS_DEFAULTS[key];
  return Math.min(max, Math.max(min, value));
}

/**
 * Repairs Glass fields from the device's local store, which nothing validates:
 * a corrupted or older entry must never reach CSS as NaN or an unknown mode.
 */
export function sanitizeGlass(input: Partial<Record<keyof GlassPreferences, unknown>>): GlassPreferences {
  const tuple = Object.fromEntries(GLASS_NUMERIC_KEYS.map((key) => [key, clampGlassValue(key, input[key])])) as GlassTuple;
  const flag = (key: (typeof GLASS_FAMILY_KEYS)[GlassFamily]) => (typeof input[key] === "boolean" ? (input[key] as boolean) : GLASS_DEFAULTS[key]);
  const performance = (GLASS_PERFORMANCE as readonly unknown[]).includes(input.glassPerformance)
    ? (input.glassPerformance as GlassPreferences["glassPerformance"])
    : GLASS_DEFAULTS.glassPerformance;
  return {
    glassPreset: glassPresetOf(tuple),
    ...tuple,
    glassPerformance: performance,
    glassSidebar: flag("glassSidebar"),
    glassComposer: flag("glassComposer"),
    glassOverlays: flag("glassOverlays"),
    glassCards: flag("glassCards"),
    glassToolbars: flag("glassToolbars"),
    glassControls: flag("glassControls"),
  };
}

/** One update that switches to a named preset: its five values and its name, nothing else. */
export function glassPresetPatch(name: GlassPresetName): Pick<GlassPreferences, "glassPreset" | GlassNumericKey> {
  return { glassPreset: name, ...GLASS_PRESET_VALUES[name] };
}

/** Changing one value re-derives the preset from the whole tuple, so a matching tuple still reads as its preset. */
export function glassValuePatch(current: GlassTuple, key: GlassNumericKey, value: number): Partial<GlassPreferences> {
  const next = { ...pickTuple(current), [key]: clampGlassValue(key, value) };
  return { [key]: next[key], glassPreset: glassPresetOf(next) };
}

/** Resets every Glass field and the opacity; theme, fonts, and motion are untouched. */
export function glassResetPatch(): GlassPreferences & { glassOpacity: number } {
  return { ...GLASS_DEFAULTS, glassOpacity: DEFAULT_GLASS_OPACITY };
}

export function pickTuple(values: GlassTuple): GlassTuple {
  return Object.fromEntries(GLASS_NUMERIC_KEYS.map((key) => [key, values[key]])) as GlassTuple;
}

/** The preset shown in Settings. Concurrent devices can store a name that disagrees with the values; the values win. */
export function visibleGlassPreset(values: GlassTuple): GlassPresetName | "custom" {
  return glassPresetOf(pickTuple(values));
}

export { GLASS_PRESETS };

const round = (value: number) => String(Math.round(value * 1000) / 1000);

/** The root custom properties for a preference set. Family fills and alphas are derived in glass.css. */
export function glassTokens(prefs: GlassTuple): Record<string, string> {
  return {
    "--oc-glass-bend": round(clampGlassValue("glassBend", prefs.glassBend)),
    "--oc-glass-dispersion": round(clampGlassValue("glassDispersion", prefs.glassDispersion)),
    "--oc-glass-frost": `${round(clampGlassValue("glassFrost", prefs.glassFrost))}px`,
    "--oc-glass-rim": round(clampGlassValue("glassRimShine", prefs.glassRimShine)),
    "--oc-glass-tint": `${round(clampGlassValue("glassTint", prefs.glassTint))}%`,
  };
}

/** Frost after the dark-mode boost, capped like the stylesheet's `min(24px, frost + 4px)`. */
export function effectiveFrost(frost: number, dark: boolean): number {
  const value = clampGlassValue("glassFrost", frost);
  return dark ? Math.min(GLASS_RANGES.glassFrost.max, value + 4) : value;
}

/**
 * Family fill alphas, mirroring glass.css so tests and the engine agree with
 * the paint. Low opacity cannot defeat a family's readability minimum.
 */
export function familyAlpha(family: "sidebar" | "composer" | "overlay" | "toolbar" | "card" | "tooltip" | "auth", opacity: number): number {
  switch (family) {
    case "sidebar":
      return Math.min(100, opacity + 25);
    case "composer":
      return Math.min(100, opacity + 30);
    case "overlay":
      return Math.max(85, opacity);
    case "toolbar":
      return Math.max(80, opacity);
    case "card":
      return Math.max(90, opacity);
    case "tooltip":
    case "auth":
      return Math.max(92, opacity);
  }
}

/** Families switched off render solid; the attribute is a space-separated list matched with `~=`. */
export function solidFamilies(prefs: Pick<GlassPreferences, (typeof GLASS_FAMILY_KEYS)[GlassFamily]>): GlassFamily[] {
  return GLASS_FAMILIES.filter((family) => !prefs[GLASS_FAMILY_KEYS[family]]);
}

/** Writes the material tokens. Runs after `applyGlassOpacity`, so a solid tier always wins over its blur. */
export function applyGlassAppearance(root: HTMLElement, prefs: GlassPreferences, tier: GlassTier, reason: string): void {
  for (const [name, value] of Object.entries(glassTokens(prefs))) root.style.setProperty(name, value);
  const solid = solidFamilies(prefs);
  if (solid.length) root.dataset.glassSolid = solid.join(" ");
  else delete root.dataset.glassSolid;
  root.dataset.glassEffective = tier;
  root.dataset.glassReason = reason;
  if (tier === "solid") root.style.setProperty("--glass-blur", "0px");
}

// Palette and token writers call this explicitly instead of the engine
// observing every inline style mutation. Listeners coalesce per frame.
const invalidators = new Set<(reason: string) => void>();

export function invalidateGlass(reason: "theme" | "tokens" | "preview"): void {
  invalidators.forEach((listener) => listener(reason));
}

export function onGlassInvalidate(listener: (reason: string) => void): () => void {
  invalidators.add(listener);
  return () => invalidators.delete(listener);
}
