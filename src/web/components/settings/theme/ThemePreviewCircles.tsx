// Ported from T3Code (MIT, Copyright (c) 2026 T3 Tools Inc.).
// Sources: apps/web/src/components/settings/ThemePreviewCircles.tsx, packages/shared/src/themePreview.ts (render specs).
import { MoonIcon, SunIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  getThemeColorsForMode,
  getThemeModes,
  type ThemeAppearance,
  type ThemeDefinition,
} from "@/theme/palette";


type ThemePreviewColors = Readonly<{
  canvas: string;
  accent: string;
  messageAction: string;
}>;

const SHARED_STANDARD_THEME_PREVIEW_COLORS: Readonly<Record<ThemeAppearance, ThemePreviewColors>> =
  {
    light: {
      canvas: "#f9f7f5",
      accent: "#eeecea",
      messageAction: "#62691b",
    },
    dark: {
      canvas: "#181716",
      accent: "#262523",
      messageAction: "#b5c062",
    },
  };

type ThemePreviewRenderSpec = Readonly<{
  baseTarget: string;
  baseWeight: number;
  accent: Readonly<{
    center: readonly [x: number, y: number];
    middleOffset: number;
    middleOpacity: number;
    endOffset: number;
  }>;
  action: Readonly<{
    center: readonly [x: number, y: number];
    startOpacity: number;
    endOffset: number;
  }>;
  scale: number;
  blurAt56Px: number;
}>;

export const THEME_PREVIEW_RENDER_SPECS: Readonly<Record<ThemeAppearance, ThemePreviewRenderSpec>> =
  {
    light: {
      baseTarget: "#ffffff",
      baseWeight: 0.8,
      accent: {
        center: [0.72, 0.22],
        middleOffset: 0.28,
        middleOpacity: 0.72,
        endOffset: 0.58,
      },
      action: {
        center: [0.18, 0.82],
        startOpacity: 0.45,
        endOffset: 0.55,
      },
      scale: 1.1,
      blurAt56Px: 3,
    },
    dark: {
      baseTarget: "#09090b",
      baseWeight: 0.8,
      accent: {
        center: [0.28, 0.78],
        middleOffset: 0.28,
        middleOpacity: 0.62,
        endOffset: 0.58,
      },
      action: {
        center: [0.82, 0.18],
        startOpacity: 0.45,
        endOffset: 0.55,
      },
      scale: 1.1,
      blurAt56Px: 3,
    },
  };
const THEME_PREVIEW_ROLES = [
  "sidebar",
  "canvas",
  "surface",
  "accentSurface",
  "accent",
  "messageSurface",
  "messageAction",
] as const;
type ThemePreviewRole = (typeof THEME_PREVIEW_ROLES)[number];
type ThemeCardPreview = {
  mode: ThemeAppearance;
  colors: Readonly<Record<ThemePreviewRole, string>>;
};
export type ThemeCardDefinition = {
  id: string;
  label: string;
  previews: ReadonlyArray<ThemeCardPreview>;
};
export type ThemeMode = ThemeAppearance | "system";
export type ThemeCardPreviewColors = ThemeCardPreview["colors"];

const STANDARD_THEME_PREVIEW_COLORS: Record<
  ThemeAppearance,
  Readonly<Record<ThemePreviewRole, string>>
> = {
  light: {
    sidebar: "#f2f1ee",
    surface: "#fefdfc",
    accentSurface: "#eeecea",
    messageSurface: "#edebe7",
    ...SHARED_STANDARD_THEME_PREVIEW_COLORS.light,
  },
  dark: {
    sidebar: "#121110",
    surface: "#1f1e1c",
    accentSurface: "#262523",
    messageSurface: "#2a2926",
    ...SHARED_STANDARD_THEME_PREVIEW_COLORS.dark,
  },
};

export const STANDARD_THEME_CARDS: ReadonlyArray<ThemeCardDefinition> = [
  {
    id: "default",
    label: "Okaychat",
    previews: (["light", "dark"] as const).map((mode) => ({
      mode,
      colors: STANDARD_THEME_PREVIEW_COLORS[mode],
    })),
  },
];

export function previewColorsOf(
  card: ThemeCardDefinition,
  mode: ThemeAppearance,
): ThemeCardPreviewColors | null {
  return card.previews.find((preview) => preview.mode === mode)?.colors ?? null;
}

export function getThemeCardDefinition(theme: ThemeDefinition): ThemeCardDefinition {
  return {
    id: theme.id,
    label: theme.label,
    previews: getThemeModes(theme).map((mode) => {
      const colors = getThemeColorsForMode(theme, mode) ?? theme.colors;
      return {
        mode,
        colors: {
          sidebar: colors.sidebar,
          canvas: colors.canvas,
          surface: colors.surface,
          accentSurface: colors.accentSurface,
          accent: colors.accent,
          messageSurface: colors.messageSurface,
          messageAction: colors.messageAction,
        },
      };
    }),
  };
}

function getThemePreviewStyle(
  colors: ThemeCardPreviewColors,
  mode: ThemeAppearance,
): CSSProperties {
  const spec = THEME_PREVIEW_RENDER_SPECS[mode];
  const modeBase = `color-mix(in oklab, ${colors.canvas} ${spec.baseWeight * 100}%, ${spec.baseTarget})`;
  const accentPosition = `${spec.accent.center[0] * 100}% ${spec.accent.center[1] * 100}%`;
  const actionPosition = `${spec.action.center[0] * 100}% ${spec.action.center[1] * 100}%`;
  return {
    backgroundColor: modeBase,
    backgroundImage: [
      `radial-gradient(circle at ${accentPosition} in oklab, ${colors.accent} 0%, color-mix(in oklab, ${colors.accent} ${spec.accent.middleOpacity * 100}%, transparent) ${spec.accent.middleOffset * 100}%, transparent ${spec.accent.endOffset * 100}%)`,
      `radial-gradient(circle at ${actionPosition} in oklab, color-mix(in oklab, ${colors.messageAction} ${spec.action.startOpacity * 100}%, transparent) 0%, transparent ${spec.action.endOffset * 100}%)`,
    ].join(", "),
  };
}

function themePreviewEdgeShadow(mode: ThemeAppearance): string {
  return mode === "dark"
    ? "inset 0 0 0 1px rgb(255 255 255 / 0.14), 0 1px 2px rgb(0 0 0 / 0.18)"
    : "inset 0 0 0 1px rgb(0 0 0 / 0.10), 0 1px 2px rgb(0 0 0 / 0.08)";
}

export function ThemePreviewCircle({
  colors,
  mode,
  className,
}: {
  colors: ThemeCardPreviewColors;
  mode: ThemeAppearance;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative block size-14 shrink-0 overflow-hidden rounded-full border-2 border-background",
        className,
      )}
      style={{ boxShadow: themePreviewEdgeShadow(mode) }}
    >
      <span
        className="absolute inset-0 rounded-full"
        style={{
          ...getThemePreviewStyle(colors, mode),
          filter: `blur(${THEME_PREVIEW_RENDER_SPECS[mode].blurAt56Px}px)`,
          transform: `scale(${THEME_PREVIEW_RENDER_SPECS[mode].scale})`,
        }}
      />
    </span>
  );
}

export function ThemePreviewCircles({
  label,
  activeModes,
  onSelectMode,
  previews,
}: {
  label: string;
  activeModes: ReadonlyArray<ThemeMode>;
  onSelectMode: (mode: ThemeMode) => void;
  previews: ThemeCardDefinition["previews"];
}) {
  return (
    <div className="flex min-h-16 items-center justify-center gap-2.5 px-3 pt-3">
      {previews.map((preview) => {
        const mode = preview.mode;
        const isPicked = activeModes.includes(mode);
        return (
          <Tooltip key={mode}>
            <TooltipTrigger
              render={
                <button
                  aria-label={`Use ${label} ${mode} mode`}
                  aria-pressed={isPicked}
                  className={cn(
                    "relative flex size-[68px] shrink-0 transform-gpu cursor-pointer items-center justify-center rounded-full p-1 outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                    isPicked && "hover:scale-100",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectMode(mode);
                  }}
                  type="button"
                >
                  <ThemePreviewCircle colors={preview.colors} mode={mode} />
                  {isPicked ? (
                    <>
                      <span
                        aria-hidden
                        className="pointer-events-none absolute inset-0 rounded-full"
                        style={{ boxShadow: "inset 0 0 0 2px var(--ring)" }}
                      />
                      <span
                        aria-hidden
                        className="pointer-events-none absolute bottom-0.5 right-0.5 flex size-5 items-center justify-center rounded-full border border-border/70 bg-background text-foreground shadow-sm"
                      >
                        {mode === "light" ? (
                          <SunIcon className="size-3" />
                        ) : (
                          <MoonIcon className="size-3" />
                        )}
                      </span>
                    </>
                  ) : null}
                </button>
              }
            />
            <TooltipContent>
              {mode === "light" ? "Use for light mode only" : "Use for dark mode only"}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
