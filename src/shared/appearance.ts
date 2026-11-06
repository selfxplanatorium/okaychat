import { z } from "zod";

const colors = z.record(z.string().max(80), z.string().max(256));
const customTheme = z.object({
  id: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  label: z.string().min(1).max(48),
  appearance: z.enum(["light", "dark"]),
  colors,
  variants: z.object({ light: colors.optional(), dark: colors.optional() }).optional(),
  collection: z.object({ id: z.string().max(100), label: z.string().max(100) }).optional(),
  managed: z.boolean().optional(),
});

/** Message presentation. `timeline` is the existing transcript; `bubbles` adds a reply surface. */
export const MESSAGE_LAYOUTS = ["timeline", "bubbles"] as const;
export type MessageLayout = (typeof MESSAGE_LAYOUTS)[number];
export const DEFAULT_MESSAGE_LAYOUT: MessageLayout = "timeline";
export const isMessageLayout = (value: unknown): value is MessageLayout =>
  typeof value === "string" && (MESSAGE_LAYOUTS as readonly string[]).includes(value);

/** Animation groups the user can switch off. Turning all of them off disables every animation. */
export const MOTION_GROUPS = ["icons", "interface", "transitions", "loading"] as const;
export type MotionGroup = (typeof MOTION_GROUPS)[number];

/** Surface families with their own Glass switch. */
export const GLASS_FAMILIES = ["sidebar", "composer", "overlays", "cards", "toolbars", "controls"] as const;
export type GlassFamily = (typeof GLASS_FAMILIES)[number];
export const GLASS_PRESETS = ["subtle", "standard", "bold"] as const;
export type GlassPresetName = (typeof GLASS_PRESETS)[number];
export const GLASS_PERFORMANCE = ["auto", "high", "balanced", "css", "off"] as const;
export type GlassPerformance = (typeof GLASS_PERFORMANCE)[number];

/** Numeric Glass properties, their wire keys, and inclusive ranges. Shared so client clamps and server validation agree. */
export const GLASS_RANGES = {
  glassBend: { min: 0, max: 0.6, step: 0.01 },
  glassDispersion: { min: 0, max: 0.6, step: 0.01 },
  glassFrost: { min: 0, max: 24, step: 1 },
  glassRimShine: { min: 0, max: 0.4, step: 0.01 },
  glassTint: { min: 0, max: 12, step: 1 },
} as const;
export type GlassNumericKey = keyof typeof GLASS_RANGES;
export const GLASS_NUMERIC_KEYS = Object.keys(GLASS_RANGES) as GlassNumericKey[];
export type GlassTuple = Record<GlassNumericKey, number>;

export const GLASS_PRESET_VALUES: Record<GlassPresetName, GlassTuple> = {
  subtle: { glassBend: 0.08, glassDispersion: 0.03, glassFrost: 16, glassRimShine: 0.06, glassTint: 1 },
  standard: { glassBend: 0.18, glassDispersion: 0.12, glassFrost: 12, glassRimShine: 0.12, glassTint: 3 },
  bold: { glassBend: 0.32, glassDispersion: 0.24, glassFrost: 8, glassRimShine: 0.2, glassTint: 5 },
};

export const GLASS_DEFAULTS = {
  glassPreset: "standard" as GlassPresetName | "custom",
  ...GLASS_PRESET_VALUES.standard,
  glassPerformance: "auto" as GlassPerformance,
  glassSidebar: true,
  glassComposer: true,
  glassOverlays: true,
  glassCards: true,
  glassToolbars: true,
  glassControls: true,
};
export type GlassPreferences = typeof GLASS_DEFAULTS;
export const GLASS_KEYS = Object.keys(GLASS_DEFAULTS) as Array<keyof GlassPreferences>;
export const GLASS_FAMILY_KEYS: Record<GlassFamily, "glassSidebar" | "glassComposer" | "glassOverlays" | "glassCards" | "glassToolbars" | "glassControls"> = {
  sidebar: "glassSidebar",
  composer: "glassComposer",
  overlays: "glassOverlays",
  cards: "glassCards",
  toolbars: "glassToolbars",
  controls: "glassControls",
};

/** The named preset whose tuple matches exactly, else custom. The tuple is authoritative, the stored name only a hint. */
export function glassPresetOf(values: GlassTuple): GlassPresetName | "custom" {
  for (const name of GLASS_PRESETS) {
    const preset = GLASS_PRESET_VALUES[name];
    if (GLASS_NUMERIC_KEYS.every((key) => Math.abs(preset[key] - values[key]) < 1e-9)) return name;
  }
  return "custom";
}

// Zod 4 numbers already refuse NaN and Infinity.
const glassNumber = (key: GlassNumericKey) => z.number().min(GLASS_RANGES[key].min).max(GLASS_RANGES[key].max).default(GLASS_DEFAULTS[key]);

export const appearanceSchema = z.object({
  theme: z.string().max(100),
  mode: z.enum(["system", "light", "dark"]),
  halves: z.object({ light: z.string().max(100).optional(), dark: z.string().max(100).optional() }).nullable(),
  customThemes: z.array(customTheme).max(100),
  glassOpacity: z.number().int().min(40).max(100),
  appearanceContrast: z.number().int().min(50).max(200),
  panelAnimationDurationMs: z.number().int().min(0).max(400),
  // Defaults keep snapshots and caches written before these fields valid.
  motionOff: z.array(z.enum(MOTION_GROUPS)).max(MOTION_GROUPS.length).default([]),
  squareCorners: z.boolean().default(false),
  sidebarStyle: z.enum(["floating", "docked"]).default("floating"),
  chatWidth: z.enum(["comfortable", "wide", "full"]),
  messageLayout: z.enum(MESSAGE_LAYOUTS).default(DEFAULT_MESSAGE_LAYOUT),
  fontFamilySans: z.string().max(200),
  fontFamilyComposer: z.string().max(200),
  fontFamilyCode: z.string().max(200),
  fontSizePrompt: z.number().int().min(12).max(20),
  fontSizeCode: z.number().int().min(10).max(18),
  fontSmoothing: z.boolean(),
  wordWrap: z.boolean(),
  typographyAdvanced: z.boolean(),
  // Flat, because PATCH merges top-level fields only; a nested object would let one device overwrite another's unrelated change.
  glassPreset: z.enum([...GLASS_PRESETS, "custom"]).default(GLASS_DEFAULTS.glassPreset),
  glassBend: glassNumber("glassBend"),
  glassDispersion: glassNumber("glassDispersion"),
  glassFrost: glassNumber("glassFrost"),
  glassRimShine: glassNumber("glassRimShine"),
  glassTint: glassNumber("glassTint"),
  glassPerformance: z.enum(GLASS_PERFORMANCE).default(GLASS_DEFAULTS.glassPerformance),
  glassSidebar: z.boolean().default(true),
  glassComposer: z.boolean().default(true),
  glassOverlays: z.boolean().default(true),
  glassCards: z.boolean().default(true),
  glassToolbars: z.boolean().default(true),
  glassControls: z.boolean().default(true),
});

export type UserAppearance = z.infer<typeof appearanceSchema>;

/**
 * Parses a partial update. Zod 4 still fills `.default()` fields under `.partial()`, which would reset
 * fields the sender never touched (the sidebar style flipped back to floating on every edit), so only sent keys survive.
 */
export function parseAppearancePatch(input: unknown): { success: true; data: Partial<UserAppearance> } | { success: false } {
  const parsed = appearanceSchema.partial().safeParse(input);
  if (!parsed.success || typeof input !== "object" || input === null) return { success: false };
  const data = Object.fromEntries(Object.entries(parsed.data).filter(([key]) => key in input)) as Partial<UserAppearance>;
  return { success: true, data };
}
/**
 * Never synced: the interface size scales the whole UI, so a size that suits a desktop is too big on a phone.
 * Kept only in the device's local appearance store.
 */
export type DeviceAppearance = { fontSizeInterface: number };
export type AppearanceSettings = Omit<UserAppearance, "theme" | "mode" | "halves" | "customThemes"> & DeviceAppearance;
