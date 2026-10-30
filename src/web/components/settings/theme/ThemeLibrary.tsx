// Ported from T3Code (MIT, Copyright (c) 2026 T3 Tools Inc.).
// Sources: apps/web/src/components/settings/ThemeSettings.tsx (ThemeLibrary, ThemeLibraryCard,
// CustomThemeCollectionCard, remove dialog) and ThemeWireframe.tsx. Environment themes and toasts are left out.
import { CheckIcon, CopyIcon, MoonIcon, PaintbrushIcon, PenLineIcon, PlusIcon, SunIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useState, useSyncExternalStore, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { t, type PlainMessageKey } from "@/i18n";
import { useAppearance } from "@/state/appearance";
import {
  getCustomThemes,
  getThemeDefinition,
  getThemeModes,
  removeCustomThemes,
  serializeThemeFile,
  subscribeToCustomThemes,
  type ThemeAppearance,
  type ThemeDefinition,
  type ThemeHalves,
  type ThemePreferenceMode,
} from "@/theme/palette";
import { BUILT_IN_THEMES } from "@/theme/palettes";
import { EyesMark } from "./EyesMark";
import { useThemeEditorStore } from "./themeEditorStore";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  previewColorsOf,
  ThemePreviewCircle,
  ThemePreviewCircles,
  type ThemeCardDefinition,
  type ThemeCardPreviewColors,
  type ThemeMode,
} from "./ThemePreviewCircles";

const MODE_ARIA = {
  system: "appearance.followSystem",
  light: "appearance.useLightMode",
  dark: "appearance.useDarkMode",
} as const satisfies Record<"system" | "light" | "dark", PlainMessageKey>;

const MODE_LABEL = {
  system: "appearance.system",
  light: "appearance.light",
  dark: "appearance.dark",
} as const satisfies Record<"system" | "light" | "dark", PlainMessageKey>;

function useCustomThemes(): ReadonlyArray<ThemeDefinition> {
  return useSyncExternalStore(subscribeToCustomThemes, getCustomThemes, getCustomThemes);
}

function collectionVariantLabels(themes: ReadonlyArray<ThemeDefinition>): ReadonlyArray<string> {
  if (themes.length === 0) return [];
  const words = themes.map((theme) => theme.label.trim().split(/\s+/));
  const firstWords = words[0]!;
  const sharedWordCount = firstWords.findIndex((word, index) =>
    words.some((labelWords) => labelWords[index]?.toLocaleLowerCase() !== word.toLocaleLowerCase()),
  );
  const prefixLength = sharedWordCount === -1 ? firstWords.length - 1 : sharedWordCount;

  return themes.map((theme, index) => {
    const shortLabel = words[index]?.slice(Math.max(0, prefixLength)).join(" ").trim();
    return shortLabel || theme.label;
  });
}

function downloadThemeFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously can abort the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ---------------------------------------------------------------------------
// Wireframe (mode tiles)
// ---------------------------------------------------------------------------

const WIRE_LINE = "rgb(127 127 127 / 0.25)";

function WireframePane({ colors, clip }: { colors: ThemeCardPreviewColors; clip?: "left" | "right" }) {
  const clipPath =
    clip === undefined
      ? undefined
      : clip === "left"
        ? "polygon(0 0, calc(50% - 1px) 0, calc(50% - 1px) 100%, 0 100%)"
        : "polygon(calc(50% + 1px) 0, 100% 0, 100% 100%, calc(50% + 1px) 100%)";
  return (
    <span className="absolute inset-0" style={{ clipPath }}>
      <span className="absolute inset-0" style={{ backgroundColor: colors.canvas }} />
      <span className="absolute inset-y-0 left-0 w-[22%]" style={{ backgroundColor: colors.sidebar, boxShadow: `inset -1px 0 0 ${WIRE_LINE}` }} />
      <span className="absolute top-[8%] left-[3%] h-[8%] w-[16%] rounded-md" style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${WIRE_LINE}` }} />
      <span className="absolute top-[22%] left-[3%] h-[7%] w-[16%] rounded-md" style={{ backgroundColor: colors.accentSurface }} />
      <span className="absolute top-[32%] left-[3%] h-[7%] w-[16%] rounded-md" style={{ backgroundColor: colors.messageSurface, opacity: 0.7 }} />
      <span className="absolute top-[42%] left-[3%] h-[7%] w-[16%] rounded-md" style={{ backgroundColor: colors.messageSurface, opacity: 0.5 }} />
      <span className="absolute top-[11%] right-[28%] h-[9%] w-[24%] rounded-lg" style={{ backgroundColor: colors.messageSurface }} />
      <span className="absolute top-[28%] left-[27%] h-[5%] w-[34%] rounded-sm" style={{ backgroundColor: WIRE_LINE }} />
      <span className="absolute top-[38%] left-[27%] h-[5%] w-[26%] rounded-sm" style={{ backgroundColor: WIRE_LINE }} />
      <span
        className="absolute right-[6%] bottom-[8%] left-[26%] flex h-[15%] items-center justify-between rounded-md px-1"
        style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${WIRE_LINE}` }}
      >
        <span className="block h-[26%] w-[34%] rounded-full" style={{ backgroundColor: WIRE_LINE, opacity: 0.7 }} />
        <span className="block aspect-square h-[58%] rounded-full" style={{ backgroundColor: colors.messageAction }} />
      </span>
      <span
        className="absolute top-[8%] right-[5%] h-[46%] w-[20%] rounded-lg"
        style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${WIRE_LINE}, 0 2px 5px rgb(0 0 0 / 0.14)` }}
      >
        {[0, 1, 2].map((row) => (
          <span key={row} className="absolute right-[11%] left-[11%] flex items-center gap-1" style={{ top: `${10 + row * 30}%`, height: "20%" }}>
            <span className="block aspect-square h-[26%] rounded-full" style={{ backgroundColor: row === 1 ? colors.messageAction : WIRE_LINE, opacity: 0.55 }} />
            <span className="block h-[30%] w-[52%] rounded-sm" style={{ backgroundColor: WIRE_LINE }} />
          </span>
        ))}
      </span>
    </span>
  );
}

function Wireframe({ panes, className }: { panes: ReadonlyArray<{ colors: ThemeCardPreviewColors; clip?: "left" | "right" }>; className?: string }) {
  return (
    <span aria-hidden className={cn("border-border/60 relative block w-full overflow-hidden rounded-lg border", className)}>
      {panes.map((pane) => (
        <WireframePane key={pane.clip ?? "pane"} colors={pane.colors} clip={pane.clip} />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function ThemeVariantTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function CardAction({ label, tooltip, destructive, onClick, children }: { label: string; tooltip: string; destructive?: boolean; onClick: () => void; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            size="icon-xs"
            variant="ghost"
            className={cn(destructive && "hover:text-destructive hover:bg-destructive/10 dark:hover:bg-destructive/20")}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

type VariantNavigation = {
  collectionLabel: string;
  options: ReadonlyArray<{
    themeIndex: number;
    label: string;
    activeModes: ReadonlyArray<ThemeMode>;
    preview: ThemeCardDefinition["previews"][number];
  }>;
  onSelectAndUse: (themeIndex: number, mode: ThemeAppearance) => void;
};

function ThemeLibraryCard({
  theme,
  onUse,
  onUseMode,
  activeModes,
  onEdit,
  onDuplicate,
  onDownload,
  onRemove,
  variantNavigation,
  mark,
}: {
  theme: ThemeCardDefinition;
  mark?: "eyes";
  onUse: () => void;
  onUseMode: (mode: ThemeMode) => void;
  activeModes: ReadonlyArray<ThemeMode>;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDownload?: () => void;
  onRemove?: () => void;
  variantNavigation?: VariantNavigation;
}) {
  const cardModes = theme.previews.map((preview) => preview.mode);
  const [radialModeOpen, setRadialModeOpen] = useState<ThemeAppearance | null>(null);
  const radialModeGroups = (["light", "dark"] as const).map((mode) => {
    const options =
      variantNavigation?.options.flatMap((option) => (option.preview.mode === mode ? [{ option, preview: option.preview }] : [])) ?? [];
    return {
      mode,
      options,
      selected: options.find(({ option }) => option.activeModes.includes(mode)) ?? options[0],
    };
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="bg-card hover:bg-accent/10 cursor-pointer overflow-hidden rounded-xl shadow-[var(--depth-highlight),var(--shadow-raised)] transition-[background-color,box-shadow,translate] duration-(--motion-fast) ease-out-quart hover:-translate-y-px"
            data-theme-library-card={theme.id}
            onClick={onUse}
          >
            <div className="relative">
              {variantNavigation ? (
                <div
                  aria-label={t("appearance.lightDarkVariants")}
                  className="relative h-20"
                  role="group"
                  onBlurCapture={(event) => {
                    const nextTarget = event.relatedTarget;
                    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setRadialModeOpen(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setRadialModeOpen(null);
                  }}
                  onMouseLeave={() => setRadialModeOpen(null)}
                >
                  {radialModeGroups.map(({ mode, options, selected }) => {
                    if (!selected) return null;
                    const rootOffsetX = mode === "light" ? -52 : 52;
                    const isOpen = radialModeOpen === mode;
                    const isActive = selected.option.activeModes.includes(mode);
                    const modeLabel = mode === "light" ? t("appearance.light") : t("appearance.dark");
                    return (
                      <div className="contents" key={mode}>
                        <ThemeVariantTooltip label={t("appearance.variantTooltip", { mode: modeLabel, name: selected.option.label })}>
                          <button
                            aria-label={
                              options.length > 1
                                ? t(mode === "light" ? "appearance.chooseLightVariant" : "appearance.chooseDarkVariant", { count: options.length, name: selected.option.label })
                                : t(mode === "light" ? "appearance.useLightVariant" : "appearance.useDarkVariant", { name: selected.option.label })
                            }
                            aria-pressed={isActive}
                            className="focus-visible:outline-ring absolute top-2 left-1/2 z-20 flex size-14 items-center justify-center rounded-full outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid"
                            style={{ transform: `translateX(calc(-50% + ${rootOffsetX}px))` }}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              variantNavigation.onSelectAndUse(selected.option.themeIndex, mode);
                            }}
                            onFocus={() => setRadialModeOpen(mode)}
                            onMouseEnter={() => setRadialModeOpen(mode)}
                          >
                            <ThemePreviewCircle colors={selected.preview.colors} mode={selected.preview.mode} />
                            {isActive ? <span aria-hidden className="ring-ring pointer-events-none absolute inset-0 rounded-full ring-2 ring-inset" /> : null}
                            {isActive ? (
                              <span className="border-border/70 bg-background text-foreground pointer-events-none absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full border shadow-sm">
                                {mode === "light" ? <SunIcon className="size-2.5" /> : <MoonIcon className="size-2.5" />}
                              </span>
                            ) : null}
                          </button>
                        </ThemeVariantTooltip>
                        <span
                          className="text-2xs text-foreground pointer-events-none absolute bottom-0 left-1/2 inline-flex max-w-24 -translate-x-1/2 items-center gap-1 font-medium"
                          style={{ marginLeft: rootOffsetX }}
                        >
                          <span className="truncate">{selected.option.label}</span>
                          {options.length > 1 ? (
                            <span className="bg-muted text-3xs text-muted-foreground shrink-0 rounded-full px-1">+{options.length - 1}</span>
                          ) : null}
                        </span>
                        {options.length > 1
                          ? options.map(({ option, preview }, optionIndex) => {
                              const progress = optionIndex / (options.length - 1) - 0.5;
                              const childOffsetX = rootOffsetX + progress * 68;
                              const childOffsetY = Math.abs(progress) * 10;
                              const optionIsActive = option.activeModes.includes(mode);
                              return (
                                <ThemeVariantTooltip key={option.label} label={t(mode === "light" ? "appearance.useForLightMode" : "appearance.useForDarkMode", { name: option.label })}>
                                  <button
                                    aria-label={t(
                                      mode === "light"
                                        ? optionIsActive ? "appearance.useForLightModeActive" : "appearance.useForLightMode"
                                        : optionIsActive ? "appearance.useForDarkModeActive" : "appearance.useForDarkMode",
                                      { name: option.label },
                                    )}
                                    aria-pressed={optionIsActive}
                                    className={cn(
                                      "bg-background focus-visible:ring-ring absolute top-1 left-1/2 z-30 flex size-7 items-center justify-center rounded-full shadow-sm outline-none transition-[opacity,transform] duration-200 ease-out focus-visible:ring-2 focus-visible:ring-inset motion-reduce:transition-none",
                                      optionIsActive ? "ring-ring ring-2 ring-inset" : "ring-border/70 ring-1",
                                    )}
                                    style={{
                                      opacity: isOpen ? 1 : 0,
                                      pointerEvents: isOpen ? "auto" : "none",
                                      transform: `translate(calc(-50% + ${isOpen ? childOffsetX : rootOffsetX}px), ${isOpen ? childOffsetY : 28}px) scale(${isOpen ? 1 : 0.55})`,
                                      transitionDelay: isOpen ? `${optionIndex * 35}ms` : "0ms",
                                    }}
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      variantNavigation.onSelectAndUse(option.themeIndex, mode);
                                    }}
                                    onFocus={() => setRadialModeOpen(mode)}
                                    onMouseEnter={() => setRadialModeOpen(mode)}
                                  >
                                    <span className="pointer-events-none scale-[0.43]">
                                      <ThemePreviewCircle colors={preview.colors} mode={preview.mode} />
                                    </span>
                                  </button>
                                </ThemeVariantTooltip>
                              );
                            })
                          : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <ThemePreviewCircles label={theme.label} activeModes={activeModes} onSelectMode={onUseMode} previews={theme.previews} />
              )}
            </div>
            <div className="flex items-center gap-2 px-3 pt-2 pb-3">
              <div className="min-w-0 flex-1">
                <button
                  aria-label={
                    variantNavigation
                      ? t("appearance.useVariant", { collection: variantNavigation.collectionLabel, name: theme.label })
                      : t("appearance.useTheme", { name: theme.label })
                  }
                  className="text-foreground focus-visible:ring-ring focus-visible:ring-offset-card min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-inset"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onUse();
                  }}
                >
                  <span className="inline-flex max-w-full items-center gap-1 align-middle">
                    <span className="truncate">{variantNavigation?.collectionLabel ?? theme.label}</span>
                    {mark && !variantNavigation ? <EyesMark className="size-[1.25em] shrink-0" /> : null}
                  </span>
                </button>
              </div>
              {onEdit || onDuplicate || onDownload || onRemove ? (
                <div className="flex shrink-0 items-center gap-1">
                  {onDuplicate ? (
                    <CardAction label={t("appearance.duplicateNamed", { name: theme.label })} tooltip={t("appearance.duplicateTheme")} onClick={onDuplicate}>
                      <CopyIcon />
                    </CardAction>
                  ) : null}
                  {onEdit ? (
                    <CardAction label={t("appearance.editNamed", { name: theme.label })} tooltip={t("appearance.editTheme")} onClick={onEdit}>
                      <PenLineIcon />
                    </CardAction>
                  ) : null}
                  {onDownload ? (
                    <CardAction label={t("appearance.exportNamed", { name: theme.label })} tooltip={t("appearance.exportThemeFile")} onClick={onDownload}>
                      <UploadIcon />
                    </CardAction>
                  ) : null}
                  {onRemove ? (
                    <CardAction
                      destructive
                      label={
                        variantNavigation
                          ? t("appearance.removeThemesFrom", { name: variantNavigation.collectionLabel })
                          : t("appearance.removeNamed", { name: theme.label })
                      }
                      tooltip={variantNavigation ? t("appearance.removeThemes") : t("appearance.removeTheme")}
                      onClick={onRemove}
                    >
                      <Trash2Icon />
                    </CardAction>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        }
      />
      <TooltipContent>
        {variantNavigation
          ? t("appearance.useFirstVariants")
          : cardModes.length > 1
            ? t("appearance.useForBoth")
            : t(cardModes[0] === "light" ? "appearance.useForLightOnly" : "appearance.useForDarkOnly")}
      </TooltipContent>
    </Tooltip>
  );
}

function CustomThemeCollectionCard({
  themes,
  activeModesFor,
  onUse,
  onUseMode,
  onDuplicate,
  onEdit,
  onDownload,
  onRemove,
}: {
  themes: ReadonlyArray<ThemeDefinition>;
  activeModesFor: (themeId: string) => ReadonlyArray<ThemeMode>;
  onUse: (theme: ThemeDefinition) => void;
  onUseMode: (theme: ThemeDefinition, mode: ThemeMode) => void;
  onDuplicate: (theme: ThemeDefinition) => void;
  onEdit: (theme: ThemeDefinition) => void;
  onDownload: (theme: ThemeDefinition) => void;
  onRemove: (theme: ThemeDefinition) => void;
}) {
  const [variantIndex, setVariantIndex] = useState(() => {
    const activeIndex = themes.findIndex((theme) => activeModesFor(theme.id).length > 0);
    return activeIndex < 0 ? 0 : activeIndex;
  });
  const safeIndex = Math.min(variantIndex, themes.length - 1);
  const theme = themes[safeIndex];

  if (variantIndex !== safeIndex) setVariantIndex(safeIndex);

  if (!theme) return null;
  const collectionLabel = theme.collection?.label ?? theme.label;
  const variantLabels = collectionVariantLabels(themes);
  const defaultLightTheme = themes.find((candidate) => getThemeModes(candidate).includes("light"));
  const defaultDarkTheme = themes.find((candidate) => getThemeModes(candidate).includes("dark"));
  const selectCollectionDefaults = () => {
    if (themes.length === 1) {
      onUse(theme);
      return;
    }
    if (defaultLightTheme) onUseMode(defaultLightTheme, "light");
    if (defaultDarkTheme) onUseMode(defaultDarkTheme, "dark");
    setVariantIndex(0);
  };

  return (
    <ThemeLibraryCard
      activeModes={activeModesFor(theme.id)}
      onDownload={() => onDownload(theme)}
      onDuplicate={() => onDuplicate(theme)}
      onEdit={() => onEdit(theme)}
      onRemove={() => onRemove(theme)}
      onUse={selectCollectionDefaults}
      onUseMode={(mode) => onUseMode(theme, mode)}
      theme={getThemeCardDefinition(theme)}
      {...(themes.length > 1
        ? {
            variantNavigation: {
              collectionLabel,
              options: themes.flatMap((variant, themeIndex) =>
                getThemeCardDefinition(variant).previews.map((preview) => ({
                  themeIndex,
                  label: variantLabels[themeIndex] ?? variant.label,
                  activeModes: activeModesFor(variant.id),
                  preview,
                })),
              ),
              onSelectAndUse: (themeIndex, mode) => {
                const selectedTheme = themes[themeIndex];
                if (!selectedTheme) return;
                setVariantIndex(themeIndex);
                onUseMode(selectedTheme, mode);
              },
            },
          }
        : {})}
    />
  );
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export function ThemeLibrary({
  theme,
  halves,
  appearanceMode,
  initialAppearance,
  onImport,
}: {
  /** Theme id, or "" for the default palette. */
  theme: string;
  halves: ThemeHalves | null;
  appearanceMode: ThemePreferenceMode;
  initialAppearance: ThemeAppearance;
  onImport: () => void;
}) {
  const openThemeEditor = useThemeEditorStore((store) => store.openThemeEditor);
  const customThemes = useCustomThemes();
  const [removalTarget, setRemovalTarget] = useState<{
    theme: ThemeDefinition;
    collectionThemes: ReadonlyArray<ThemeDefinition>;
  } | null>(null);
  // Separate from the target so the dialog keeps its content while it animates out.
  const [isRemovalOpen, setIsRemovalOpen] = useState(false);
  const [themeIdsToRemove, setThemeIdsToRemove] = useState<ReadonlyArray<string>>([]);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const themeIdsToRemoveSet = new Set(themeIdsToRemove);
  const removeDialogTheme = removalTarget?.theme;
  const removeDialogCollectionThemes = removalTarget?.collectionThemes ?? [];
  const canRemoveCollection = removeDialogCollectionThemes.length > 1;
  const removeDialogCollectionLabel = removeDialogTheme?.collection?.label ?? removeDialogTheme?.label;

  const store = () => useAppearance.getState();

  const handleRemoveTheme = (customTheme: ThemeDefinition, collectionThemes: ReadonlyArray<ThemeDefinition>) => {
    setRemovalTarget({ theme: customTheme, collectionThemes });
    setThemeIdsToRemove(collectionThemes.length > 1 ? [] : [customTheme.id]);
    setRemovalError(null);
    setIsRemovalOpen(true);
  };

  const baseCardId = getThemeDefinition(theme)?.id ?? null;
  const lightOwner = halves?.light ?? baseCardId;
  const darkOwner = halves?.dark ?? baseCardId;

  const handleConfirmRemoveTheme = () => {
    if (!removalTarget) return;
    const removedIds = new Set(themeIdsToRemove);
    if (removedIds.size === 0) return;
    const removesBase = removedIds.has(baseCardId ?? "");
    // Captured before setTheme clears the mix.
    const storedHalves = halves ?? {};
    if (removesBase) store().setTheme("");
    for (const appearance of ["light", "dark"] as const) {
      const half = storedHalves[appearance];
      if (half === undefined) continue;
      const next = half && removedIds.has(half) ? null : removesBase ? half : undefined;
      if (next !== undefined) store().setHalf(appearance, next);
    }
    try {
      removeCustomThemes([...removedIds]);
    } catch {
      setRemovalError(t("appearance.removeFailed"));
      return;
    }
    setIsRemovalOpen(false);
  };

  const assignHalf = (appearance: ThemeAppearance, cardId: string | null) => {
    const otherAppearance = appearance === "light" ? "dark" : "light";
    // Picking the default over a themed base cannot be stored as a half: the base
    // would still own that appearance. The base becomes an explicit half on the other side.
    if (cardId === null && baseCardId !== null) {
      const otherOwner = halves?.[otherAppearance] ?? baseCardId;
      store().setTheme("");
      store().setHalf(otherAppearance, otherOwner);
      return;
    }
    store().setHalf(appearance, cardId);
  };

  const activeThemeForAppearance = getThemeDefinition((initialAppearance === "light" ? lightOwner : darkOwner) ?? "") ?? null;

  const cardDefById = (id: string | null): ThemeCardDefinition => {
    if (id === null) return STANDARD_THEME_CARDS[0]!;
    const definition = getThemeDefinition(id);
    return definition ? getThemeCardDefinition(definition) : STANDARD_THEME_CARDS[0]!;
  };

  const pickColors = (id: string | null, appearance: ThemeAppearance) => {
    const card = cardDefById(id);
    return previewColorsOf(card, appearance) ?? card.previews[0]!.colors;
  };

  const handlePairPick = (cardId: string | null) => (mode: ThemeMode) => {
    if (mode === "system") return;
    assignHalf(mode, cardId);
  };

  const pickedModesFor = (cardId: string | null): ThemeMode[] => {
    const rings: ThemeMode[] = [];
    if (lightOwner === cardId) rings.push("light");
    if (darkOwner === cardId) rings.push("dark");
    return rings;
  };

  const duplicate = (seedThemeId: string | null, label: string) =>
    openThemeEditor({ editingThemeId: null, seedThemeId, seedName: t("appearance.themeCopyName", { name: label }), initialAppearance });

  const wireframeColors = (appearance: ThemeAppearance) => pickColors(appearance === "light" ? lightOwner : darkOwner, appearance);

  const customThemeCollections = [
    ...customThemes
      .reduce((groups, customTheme) => {
        const groupId = customTheme.collection ? `collection:${customTheme.collection.id}` : `theme:${customTheme.id}`;
        const group = groups.get(groupId);
        if (group) group.push(customTheme);
        else groups.set(groupId, [customTheme]);
        return groups;
      }, new Map<string, ThemeDefinition[]>())
      .entries(),
  ];

  return (
    <div className="space-y-3">
      <h3 className="text-foreground/70 text-sm font-normal">{t("appearance.colorScheme")}</h3>
      <div aria-label={t("appearance.appearanceMode")} className="grid w-full grid-cols-3 gap-3" role="group">
        {(["system", "light", "dark"] as const).map((mode) => {
          const isActive = appearanceMode === mode;
          return (
            <button
              aria-label={t(MODE_ARIA[mode])}
              aria-pressed={isActive}
              className={cn(
                "focus-visible:outline-ring bg-card flex cursor-pointer flex-col items-stretch gap-1.5 rounded-xl p-2 outline-none transition-[background-color,box-shadow] duration-(--motion-base) ease-out-quart focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid",
                !isActive && "hover:bg-accent/10",
              )}
              key={mode}
              // The selected mode gets the accent ring and halo used for focus elsewhere.
              style={{
                boxShadow: isActive
                  ? "var(--depth-highlight), 0 0 0 1.5px var(--ring), 0 0 0 5px var(--depth-glow), var(--shadow-raised)"
                  : "var(--depth-highlight), var(--shadow-raised)",
              }}
              onClick={() => store().setMode(mode)}
              type="button"
            >
              <Wireframe
                className="h-[8.75rem]"
                panes={
                  mode === "system"
                    ? [
                        { clip: "left", colors: wireframeColors("light") },
                        { clip: "right", colors: wireframeColors("dark") },
                      ]
                    : [{ colors: wireframeColors(mode) }]
                }
              />
              <span className={cn("flex items-center justify-center text-xs font-medium", isActive ? "text-foreground" : "text-muted-foreground")}>
                {t(MODE_LABEL[mode])}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3 pt-2">
        <h3 className="text-foreground/70 text-sm font-normal">{t("appearance.themes")}</h3>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              openThemeEditor({ editingThemeId: null, seedThemeId: activeThemeForAppearance?.id ?? null, seedName: null, initialAppearance })
            }
          >
            <PaintbrushIcon />
            {t("appearance.createTheme")}
          </Button>
          <Button size="xs" variant="outline" onClick={onImport}>
            <PlusIcon />
            {t("appearance.addTheme")}
          </Button>
        </div>
      </div>
      <div className="grid w-full gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 16rem), 1fr))" }}>
        {STANDARD_THEME_CARDS.map((standardTheme) => (
          <ThemeLibraryCard
            activeModes={pickedModesFor(null)}
            key={standardTheme.id}
            onDuplicate={() => duplicate(null, standardTheme.label)}
            onUse={() => store().setTheme("")}
            onUseMode={handlePairPick(null)}
            theme={standardTheme}
          />
        ))}
        {BUILT_IN_THEMES.map((builtIn) => (
          <ThemeLibraryCard
            activeModes={pickedModesFor(builtIn.id)}
            key={builtIn.id}
            onDuplicate={() => duplicate(builtIn.id, builtIn.label)}
            onUse={() => store().setTheme(builtIn.id)}
            mark={builtIn.mark}
            onUseMode={handlePairPick(builtIn.id)}
            theme={getThemeCardDefinition(builtIn)}
          />
        ))}
        {customThemeCollections.map(([collectionId, themes]) => (
          <CustomThemeCollectionCard
            activeModesFor={pickedModesFor}
            key={collectionId}
            onDownload={(customTheme) => downloadThemeFile(`${customTheme.id}.json`, serializeThemeFile(customTheme))}
            onDuplicate={(customTheme) => duplicate(customTheme.id, customTheme.label)}
            onEdit={(customTheme) => openThemeEditor({ editingThemeId: customTheme.id, seedThemeId: null, seedName: null, initialAppearance })}
            onRemove={(customTheme) => handleRemoveTheme(customTheme, themes)}
            onUse={(customTheme) => {
              const modes = getThemeModes(customTheme);
              if (modes.length === 1) assignHalf(modes[0]!, customTheme.id);
              else store().setTheme(customTheme.id);
            }}
            onUseMode={(customTheme, mode) => handlePairPick(customTheme.id)(mode)}
            themes={themes}
          />
        ))}
      </div>

      <Dialog open={isRemovalOpen} onOpenChange={setIsRemovalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {canRemoveCollection
                ? t("appearance.removeCollectionTitle", { name: removeDialogCollectionLabel ?? "" })
                : t("appearance.removeThemeTitle", { name: removeDialogTheme?.label ?? "" })}
            </DialogTitle>
            <DialogDescription>
              {canRemoveCollection
                ? t("appearance.removeCollectionBody")
                : t("appearance.removeThemeBody")}
            </DialogDescription>
          </DialogHeader>
          {canRemoveCollection ? (
            <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
              {removeDialogCollectionThemes.map((customTheme) => {
                const checked = themeIdsToRemoveSet.has(customTheme.id);
                const card = getThemeCardDefinition(customTheme);
                const checkboxId = `remove-theme-${customTheme.id}`;
                return (
                  <label
                    className="group border-border/70 bg-muted/25 has-checked:border-ring has-checked:bg-accent/20 hover:bg-muted/40 relative flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border p-3"
                    htmlFor={checkboxId}
                    key={customTheme.id}
                  >
                    <span className="absolute top-2 right-2 inline-grid size-4 grid-cols-1">
                      <input
                        checked={checked}
                        className="border-input bg-background checked:border-primary checked:bg-primary focus-visible:outline-ring col-start-1 row-start-1 size-full appearance-none rounded-sm border outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
                        id={checkboxId}
                        type="checkbox"
                        onChange={(event) => {
                          const shouldRemove = event.currentTarget.checked;
                          setThemeIdsToRemove((current) =>
                            shouldRemove ? [...current, customTheme.id] : current.filter((themeId) => themeId !== customTheme.id),
                          );
                        }}
                      />
                      <CheckIcon className="stroke-primary-foreground pointer-events-none col-start-1 row-start-1 size-3 shrink-0 self-center justify-self-center opacity-0 group-has-checked:opacity-100" />
                    </span>
                    <span className="flex min-h-12 items-center justify-center gap-1">
                      {card.previews.map((preview) => (
                        <span className="flex size-11 shrink-0 items-center justify-center" key={preview.mode}>
                          <span className="flex scale-75">
                            <ThemePreviewCircle colors={preview.colors} mode={preview.mode} />
                          </span>
                        </span>
                      ))}
                    </span>
                    <p className="text-foreground max-w-full truncate text-center text-sm font-medium">{customTheme.label}</p>
                  </label>
                );
              })}
            </div>
          ) : null}
          {removalError && (
            <p role="alert" className="text-destructive text-xs">
              {removalError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRemovalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={themeIdsToRemove.length === 0} variant="destructive" onClick={handleConfirmRemoveTheme}>
              {canRemoveCollection
                ? themeIdsToRemove.length > 0
                  ? t("appearance.removeSelectedCount", { count: themeIdsToRemove.length })
                  : t("appearance.removeSelected")
                : t("appearance.removeTheme")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
