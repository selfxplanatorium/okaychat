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

export const appearanceSchema = z.object({
  theme: z.string().max(100),
  mode: z.enum(["system", "light", "dark"]),
  halves: z.object({ light: z.string().max(100).optional(), dark: z.string().max(100).optional() }).nullable(),
  customThemes: z.array(customTheme).max(100),
  glassOpacity: z.number().int().min(40).max(100),
  appearanceContrast: z.number().int().min(50).max(200),
  panelAnimationDurationMs: z.number().int().min(0).max(400),
  chatWidth: z.enum(["comfortable", "wide", "full"]),
  fontFamilySans: z.string().max(200),
  fontFamilyComposer: z.string().max(200),
  fontFamilyCode: z.string().max(200),
  fontSizeInterface: z.number().int().min(12).max(20),
  fontSizePrompt: z.number().int().min(12).max(20),
  fontSizeCode: z.number().int().min(10).max(18),
  fontSmoothing: z.boolean(),
  wordWrap: z.boolean(),
  typographyAdvanced: z.boolean(),
});

export type UserAppearance = z.infer<typeof appearanceSchema>;
export type AppearanceSettings = Omit<UserAppearance, "theme" | "mode" | "halves" | "customThemes">;
