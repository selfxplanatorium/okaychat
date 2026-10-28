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

/** Animation groups the user can switch off. Turning all of them off disables every animation. */
export const MOTION_GROUPS = ["icons", "interface", "transitions", "loading"] as const;
export type MotionGroup = (typeof MOTION_GROUPS)[number];

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
  fontFamilySans: z.string().max(200),
  fontFamilyComposer: z.string().max(200),
  fontFamilyCode: z.string().max(200),
  fontSizePrompt: z.number().int().min(12).max(20),
  fontSizeCode: z.number().int().min(10).max(18),
  fontSmoothing: z.boolean(),
  wordWrap: z.boolean(),
  typographyAdvanced: z.boolean(),
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
