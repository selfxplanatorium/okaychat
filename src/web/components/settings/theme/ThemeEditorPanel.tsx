// Ported from T3Code (MIT, Copyright (c) 2026 T3 Tools Inc.). Source: apps/web/src/components/settings/ThemeEditorPanel.tsx
import { ChevronDownIcon, ChevronUpIcon, MousePointer2Icon, PaintbrushIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  applyThemeColorPreview,
  THEME_COLOR_ROLES,
  THEME_FILE_VERSION,
  createVividThemeColors,
  getCustomThemes,
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeModes,
  installCustomTheme,
  isThemeColor,
  parseThemeFile,
  removeCustomTheme,
  themeIdFromName,
  updateThemeColorFamily,
  updateCustomTheme,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeColorRole,
  type ThemeDefinition,
} from "@/theme/palette";
import { t, type PlainMessageKey } from "@/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { motionAllowed } from "@/state/appearance";
import { getThemeRoleLabel, ThemeColorField } from "./ThemeColorPicker";
import {
  clearThemeInspectorHover,
  clearThemeInspectorHighlights,
  highlightThemeRoleUsage,
  inspectThemeRoleAtElement,
  inspectThemeRoleFromUtilitiesAtElement,
  refreshThemeInspectorSpotlight,
  showThemeInspectorHover,
  type ThemeElementInspection,
} from "./themeInspector";

const THEME_EDITOR_SIMPLE_ROLES: ReadonlyArray<ThemeColorRole> = ["canvas", "accent"];

type ThemeEditorColorFamily = Readonly<{
  id: string;
  labelKey: PlainMessageKey;
  role: ThemeColorRole;
  roles: ReadonlyArray<ThemeColorRole>;
}>;

const THEME_EDITOR_ROLE_GROUPS: ReadonlyArray<{
  id: string;
  titleKey: PlainMessageKey;
  families: ReadonlyArray<ThemeEditorColorFamily>;
}> = [
  {
    id: "foundation",
    titleKey: "appearance.groupFoundation",
    families: [
      {
        id: "background",
        labelKey: "appearance.familyBackground",
        role: "canvas",
        roles: ["canvas", "chrome", "toolbar"],
      },
      { id: "surface", labelKey: "appearance.familySurface", role: "surface", roles: ["surface"] },
      {
        id: "raised-surface",
        labelKey: "appearance.familyRaisedSurface",
        role: "surfaceRaised",
        roles: ["surfaceRaised"],
      },
      {
        id: "overlay",
        labelKey: "appearance.familyOverlay",
        role: "surfaceOverlay",
        roles: ["surfaceOverlay"],
      },
      {
        id: "text",
        labelKey: "appearance.familyText",
        role: "text",
        roles: ["text", "toolbarForeground", "toolbarControlForeground"],
      },
      {
        id: "muted-text",
        labelKey: "appearance.familyMutedText",
        role: "mutedForeground",
        roles: [
          "textMuted",
          "mutedForeground",
          "placeholder",
          "secondaryLabel",
          "iconMuted",
          "sidebarMutedForeground",
        ],
      },
      {
        id: "border",
        labelKey: "appearance.familyBorder",
        role: "border",
        roles: ["border", "toolbarBorder", "sidebarBorder"],
      },
      { id: "input", labelKey: "appearance.familyInput", role: "input", roles: ["input"] },
    ],
  },
  {
    id: "brand-content",
    titleKey: "appearance.groupBrandContent",
    families: [
      {
        id: "subtle-surface",
        labelKey: "appearance.familySubtleSurface",
        role: "secondary",
        roles: ["secondary", "secondaryForeground", "muted", "toolbarControl"],
      },
      {
        id: "highlight-surface",
        labelKey: "appearance.familyHighlightSurface",
        role: "accentSurface",
        roles: ["accentSurface", "accentSurfaceForeground", "toolbarControlHover"],
      },
      {
        id: "accent",
        labelKey: "appearance.familyAccent",
        role: "accent",
        roles: [
          "accent",
          "accentForeground",
          "focus",
          "update",
          "updateForeground",
          "updateSurface",
          "terminalCursor",
        ],
      },
      {
        id: "action",
        labelKey: "appearance.familyAction",
        role: "messageAction",
        roles: ["messageAction", "messageActionForeground", "messageActionHover"],
      },
      {
        id: "message-surface",
        labelKey: "appearance.familyMessageSurface",
        role: "messageSurface",
        roles: ["messageSurface", "messageForeground"],
      },
      {
        id: "code-surface",
        labelKey: "appearance.familyCodeSurface",
        role: "codeBackground",
        roles: ["codeBackground", "codeForeground"],
      },
    ],
  },
  {
    id: "search",
    titleKey: "appearance.groupSearch",
    families: [
      {
        id: "search-matches",
        labelKey: "appearance.familySearchMatches",
        role: "searchMatchBackground",
        roles: ["searchMatchBackground", "searchMatchForeground"],
      },
      {
        id: "current-match",
        labelKey: "appearance.familyCurrentMatch",
        role: "searchMatchActiveBackground",
        roles: ["searchMatchActiveBackground", "searchMatchActiveForeground"],
      },
    ],
  },
  {
    id: "context",
    titleKey: "appearance.groupContext",
    families: [
      {
        id: "sidebar-background",
        labelKey: "appearance.familySidebarBackground",
        role: "sidebar",
        roles: ["sidebar", "sidebarForeground"],
      },
      {
        id: "sidebar-controls",
        labelKey: "appearance.familySidebarControls",
        role: "sidebarControlSurface",
        roles: ["sidebarControlSurface"],
      },
      {
        id: "sidebar-selection",
        labelKey: "appearance.familySidebarSelection",
        role: "sidebarRowSelected",
        roles: ["sidebarRowHover", "sidebarRowActive", "sidebarRowSelected"],
      },
      {
        id: "terminal-background",
        labelKey: "appearance.familyTerminalBackground",
        role: "terminalBackground",
        roles: [
          "terminalBackground",
          "terminalForeground",
          "terminalSelection",
          "terminalScrollbar",
          "terminalScrollbarHover",
        ],
      },
    ],
  },
  {
    id: "status",
    titleKey: "appearance.groupStatus",
    families: [
      {
        id: "error",
        labelKey: "appearance.familyError",
        role: "error",
        roles: ["error", "errorForeground", "errorSurface"],
      },
      {
        id: "warning",
        labelKey: "appearance.familyWarning",
        role: "warning",
        roles: ["warning", "warningForeground", "warningSurface"],
      },
    ],
  },
];

const THEME_EDITOR_COLOR_FAMILIES = THEME_EDITOR_ROLE_GROUPS.flatMap((group) => group.families);
const THEME_EDITOR_COLOR_FAMILY_BY_ROLE = new Map(
  THEME_EDITOR_COLOR_FAMILIES.flatMap((family) =>
    family.roles.map((role) => [role, family] as const),
  ),
);

function getThemeEditorColorFamily(role: ThemeColorRole): ThemeEditorColorFamily | null {
  return THEME_EDITOR_COLOR_FAMILY_BY_ROLE.get(role) ?? null;
}

function modeWord(appearance: ThemeAppearance): string {
  return appearance === "light" ? t("appearance.lightLower") : t("appearance.darkLower");
}

function familyLabel(role: ThemeColorRole): string | null {
  const family = getThemeEditorColorFamily(role);
  return family ? t(family.labelKey) : null;
}

type ThemeEditorColors = ThemeColors;
type ThemeEditorColorsByAppearance = Record<ThemeAppearance, ThemeEditorColors>;

function getThemeEditorDefaults(appearance: ThemeAppearance): ThemeEditorColors {
  return { ...getStandardThemeColors(appearance) };
}

function getThemeEditorColorsByAppearance(): ThemeEditorColorsByAppearance {
  return {
    light: getThemeEditorDefaults("light"),
    dark: getThemeEditorDefaults("dark"),
  };
}

function isThemeEditorColor(value: string): boolean {
  return isThemeColor(value.trim());
}

function getManagedEditorColors(
  appearance: ThemeAppearance,
  colors: ThemeEditorColors,
): ThemeEditorColors {
  const defaults = getStandardThemeColors(appearance);
  return createVividThemeColors(
    appearance,
    isThemeEditorColor(colors.canvas) ? colors.canvas : defaults.canvas,
    isThemeEditorColor(colors.accent) ? colors.accent : defaults.accent,
  );
}

function clampPanelPosition(
  panel: HTMLElement | null,
  x: number,
  y: number,
  widthOverride?: number,
) {
  const margin = 8;
  // The caller passes a width when it has just shrunk the panel: the DOM
  // still reports the old one until React commits.
  const width = widthOverride ?? panel?.offsetWidth ?? 0;
  return {
    x: Math.min(Math.max(x, margin), Math.max(margin, window.innerWidth - width - margin)),
    y: Math.min(Math.max(y, margin), Math.max(margin, window.innerHeight - 48)),
  };
}

// Kept out of the component: the compiler cannot lower a throw inside try/catch.
function retireMergedTheme(retired: ThemeDefinition, mergeTarget: ThemeDefinition) {
  try {
    removeCustomTheme(retired.id);
  } catch (cause) {
    // The merge already persisted. Leaving it while the edited theme
    // survives would collide on every retry, so the target goes back to
    // its pre-merge palettes before the failure surfaces.
    try {
      updateCustomTheme(mergeTarget);
    } catch {}
    throw cause;
  }
}

export function ThemeEditorPanel({
  open,
  onOpenChange,
  onSaved,
  editingTheme,
  initialAppearance,
  seedTheme,
  seedName,
  restoreTheme,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (
    theme: ThemeDefinition,
    context: {
      created: boolean;
      mergedAppearance?: ThemeAppearance;
    },
  ) => boolean;
  editingTheme: ThemeDefinition | null;
  initialAppearance: ThemeAppearance;
  seedTheme?: ThemeDefinition | null;
  seedName?: string | undefined;
  restoreTheme: () => void;
}) {
  const isEditing = editingTheme !== null;
  const [name, setName] = useState("");
  const [activeAppearance, setActiveAppearance] = useState<ThemeAppearance>(initialAppearance);
  const [isAdvanced, setIsAdvanced] = useState(false);
  const [colorsByAppearance, setColorsByAppearance] = useState<ThemeEditorColorsByAppearance>(() =>
    getThemeEditorColorsByAppearance(),
  );
  const [simpleColorsDirtyByAppearance, setSimpleColorsDirtyByAppearance] = useState<
    Record<ThemeAppearance, boolean>
  >({ light: false, dark: false });
  const [shouldRegenerateGuidedColors, setShouldRegenerateGuidedColors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [roleQuery, setRoleQuery] = useState("");
  const [isInspecting, setIsInspecting] = useState(false);
  const [selectedRole, setSelectedRole] = useState<ThemeColorRole | null>(null);
  const [usageCount, setUsageCount] = useState<number | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const resizeStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  useEffect(() => {
    if (!open) return;
    const clamp = () => {
      const margin = 8;
      let clampedWidth: number | undefined;
      let clampedHeight: number | undefined;
      setSize((current) => {
        if (!current) return current;
        clampedWidth = Math.max(280, Math.min(current.width, window.innerWidth - margin * 2));
        clampedHeight = Math.max(220, Math.min(current.height, window.innerHeight - margin * 2));
        return { width: clampedWidth, height: clampedHeight };
      });
      setPosition((current) => {
        if (!current) return current;
        const clamped = clampPanelPosition(panelRef.current, current.x, current.y, clampedWidth);
        const height = isMinimized
          ? (panelRef.current?.offsetHeight ?? 0)
          : (clampedHeight ?? panelRef.current?.offsetHeight ?? 0);
        const maxY = Math.max(margin, window.innerHeight - height - margin);
        return { x: clamped.x, y: Math.min(clamped.y, maxY) };
      });
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [isMinimized, open]);

  // Seeded during render so the first open commit already holds this
  // session's draft; seeding in an effect would preview the previous
  // session's colors for a frame.
  const [seededOpen, setSeededOpen] = useState(false);
  if (seededOpen !== open) {
    setSeededOpen(open);
    if (open) {
      const sourceTheme = editingTheme ?? seedTheme ?? null;
      const nextColors = getThemeEditorColorsByAppearance();
      const nextAppearance = sourceTheme
        ? getThemeColorsForMode(sourceTheme, initialAppearance)
          ? initialAppearance
          : sourceTheme.appearance
        : initialAppearance;
      if (sourceTheme) {
        nextColors[sourceTheme.appearance] = { ...sourceTheme.colors };
        for (const appearance of ["light", "dark"] as const) {
          const variantColors = sourceTheme.variants?.[appearance];
          if (variantColors) nextColors[appearance] = { ...variantColors };
        }
      }

      setName(editingTheme?.label ?? seedName ?? "");
      setActiveAppearance(nextAppearance);
      // Themes saved by the guided editor carry the managed flag; anything else
      // (imports, hand-edited files, older saves) opens in advanced mode so
      // guided regeneration cannot silently discard hand-tuned colors.
      setIsAdvanced(sourceTheme !== null && sourceTheme.managed !== true);
      setSimpleColorsDirtyByAppearance({ light: false, dark: false });
      setShouldRegenerateGuidedColors(sourceTheme !== null && sourceTheme.managed !== true);
      setColorsByAppearance(nextColors);
      setSelectedRole(null);
      setUsageCount(null);
      setIsInspecting(false);
      setError(null);
    }
  }

  const nameTargetId = themeIdFromName(name);
  const normalizedName = name.trim().toLowerCase();
  const mergeTarget =
    normalizedName === ""
      ? null
      : (getCustomThemes().find(
          (theme) =>
            theme.id !== editingTheme?.id &&
            (theme.id === nameTargetId || theme.label.trim().toLowerCase() === normalizedName),
        ) ?? null);
  const takenAppearances = mergeTarget ? getThemeModes(mergeTarget) : [];
  const editableAppearances = editingTheme ? getThemeModes(editingTheme) : null;

  const appearanceLockReason = (appearance: ThemeAppearance): string | null => {
    if (editableAppearances && !editableAppearances.includes(appearance)) {
      return t("appearance.noPaletteFor", { name: editingTheme?.label ?? "", mode: modeWord(appearance) });
    }
    if (!isEditing && takenAppearances.includes(appearance)) {
      return t("appearance.hasPalette", { name: mergeTarget?.label ?? "", mode: modeWord(appearance) });
    }
    return null;
  };

  // Moves off a palette the merge target already has, once per target change.
  const mergeKey =
    isEditing || mergeTarget === null ? null : `${mergeTarget.id}:${takenAppearances.join(",")}`;
  const [appliedMergeKey, setAppliedMergeKey] = useState<string | null>(null);
  if (appliedMergeKey !== mergeKey) {
    setAppliedMergeKey(mergeKey);
    if (
      mergeKey !== null &&
      takenAppearances.length === 1 &&
      takenAppearances.includes(activeAppearance)
    ) {
      setActiveAppearance(takenAppearances[0] === "light" ? "dark" : "light");
    }
  }

  useEffect(() => {
    if (!open) return;
    applyThemeColorPreview(colorsByAppearance[activeAppearance], activeAppearance);
  }, [activeAppearance, colorsByAppearance, open]);

  useEffect(() => {
    if (!open) return;
    return () => {
      restoreTheme();
    };
  }, [open, restoreTheme]);

  const updateColor = (role: ThemeColorRole, value: string) => {
    setColorsByAppearance((current) => {
      const nextColors = { ...current[activeAppearance], [role]: value };
      const shouldManageColors =
        !isAdvanced && THEME_EDITOR_SIMPLE_ROLES.includes(role) && isThemeEditorColor(value);

      return {
        ...current,
        [activeAppearance]: isAdvanced
          ? updateThemeColorFamily(activeAppearance, current[activeAppearance], role, value)
          : shouldManageColors
            ? getManagedEditorColors(activeAppearance, nextColors)
            : nextColors,
      };
    });
    if (!isAdvanced && THEME_EDITOR_SIMPLE_ROLES.includes(role) && isThemeEditorColor(value)) {
      setSimpleColorsDirtyByAppearance((current) => ({
        ...current,
        [activeAppearance]: true,
      }));
    }
    if (isAdvanced) setShouldRegenerateGuidedColors(true);
  };

  const selectThemeRole = (role: ThemeColorRole, reveal = false) => {
    const visibleRole = getThemeEditorColorFamily(role)?.role ?? role;
    setSelectedRole(visibleRole);
    if (!THEME_EDITOR_SIMPLE_ROLES.includes(visibleRole)) {
      setIsAdvanced(true);
      setRoleQuery("");
    }
    if (!reveal) return;

    requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector(`[data-theme-color-role="${visibleRole}"]`)
        ?.scrollIntoView({ behavior: motionAllowed("interface") ? "smooth" : "auto", block: "nearest" });
    });
  };

  const toggleThemeRole = (role: ThemeColorRole) => {
    setSelectedRole((current) => (current === role ? null : role));
  };

  const clearInspectorSelection = () => {
    setSelectedRole(null);
    setUsageCount(null);
    setIsInspecting(false);
  };

  const selectedHighlightRoles = selectedRole
    ? isAdvanced
      ? (getThemeEditorColorFamily(selectedRole)?.roles ?? [selectedRole])
      : THEME_EDITOR_SIMPLE_ROLES.includes(selectedRole)
        ? THEME_COLOR_ROLES.filter(
            (role) =>
              colorsByAppearance[activeAppearance][role].trim().toLowerCase() ===
              colorsByAppearance[activeAppearance][selectedRole].trim().toLowerCase(),
          )
        : [selectedRole]
    : [];
  const selectedHighlightRolesKey = selectedHighlightRoles.join(",");

  useEffect(() => {
    clearThemeInspectorHighlights();
    if (!open || selectedRole === null || isInspecting) return;

    const highlightedRoles = selectedHighlightRolesKey.split(",") as Array<ThemeColorRole>;
    const refreshHighlights = () => setUsageCount(highlightThemeRoleUsage(highlightedRoles));
    refreshHighlights();
    // A refresh snapshots computed styles for the whole tree twice, so it is
    // throttled rather than run per frame: a streaming reply or a virtualized
    // list mutates the DOM continuously and would otherwise stall the main
    // thread for as long as the inspector is open.
    const MIN_REFRESH_INTERVAL_MS = 500;
    let refreshFrame: number | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = performance.now();
    const scheduleRefresh = () => {
      if (refreshFrame !== null || refreshTimer !== null) return;
      const wait = Math.max(0, MIN_REFRESH_INTERVAL_MS - (performance.now() - lastRefreshAt));
      const run = () => {
        refreshFrame = null;
        refreshTimer = null;
        lastRefreshAt = performance.now();
        refreshHighlights();
      };
      if (wait === 0) refreshFrame = requestAnimationFrame(run);
      else refreshTimer = setTimeout(run, wait);
    };
    const observer = new MutationObserver((mutations) => {
      if (
        mutations.every(
          (mutation) =>
            mutation.target instanceof Element &&
            (mutation.target.closest("#theme-inspector-spotlight") ||
              mutation.target.closest("[data-theme-editor-panel]")),
        )
      ) {
        return;
      }
      scheduleRefresh();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    let spotlightFrame: number | null = null;
    const scheduleSpotlightRefresh = () => {
      if (spotlightFrame !== null) return;
      spotlightFrame = requestAnimationFrame(() => {
        spotlightFrame = null;
        refreshThemeInspectorSpotlight();
      });
    };
    window.addEventListener("resize", scheduleSpotlightRefresh);
    window.addEventListener("scroll", scheduleSpotlightRefresh, true);
    return () => {
      observer.disconnect();
      if (refreshFrame !== null) cancelAnimationFrame(refreshFrame);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      if (spotlightFrame !== null) cancelAnimationFrame(spotlightFrame);
      window.removeEventListener("resize", scheduleSpotlightRefresh);
      window.removeEventListener("scroll", scheduleSpotlightRefresh, true);
      clearThemeInspectorHighlights();
      setUsageCount(null);
    };
  }, [isInspecting, open, selectedHighlightRolesKey, selectedRole]);

  useEffect(() => {
    if (!open || !isInspecting) {
      clearThemeInspectorHover();
      return;
    }

    let shouldDisarmAfterClick = false;
    let hoverTarget: Element | null = null;
    let hoverInspection: ThemeElementInspection | null = null;
    let hoverTimer: number | null = null;
    let hoverFrame: number | null = null;
    const clearHoverTimer = () => {
      if (hoverTimer === null) return;
      window.clearTimeout(hoverTimer);
      hoverTimer = null;
    };
    const clearHover = () => {
      clearHoverTimer();
      hoverTarget = null;
      hoverInspection = null;
      clearThemeInspectorHover();
    };
    const showInspection = (inspection: ThemeElementInspection) => {
      hoverInspection = inspection;
      showThemeInspectorHover(
        inspection,
        familyLabel(inspection.role) ?? getThemeRoleLabel(inspection.role),
      );
    };
    const handlePointerOver = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) {
        clearHover();
        return;
      }

      clearHoverTimer();
      hoverTarget = target;
      hoverInspection = null;
      const utilityInspection = inspectThemeRoleFromUtilitiesAtElement(target);
      if (utilityInspection) {
        showInspection(utilityInspection);
        return;
      }

      clearThemeInspectorHover();
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        if (hoverTarget !== target || !target.isConnected) return;
        const inspection = inspectThemeRoleAtElement(target);
        if (inspection) showInspection(inspection);
      }, 140);
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) clearHover();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();
      clearHoverTimer();
      const inspection =
        hoverTarget === target && hoverInspection
          ? hoverInspection
          : inspectThemeRoleAtElement(target);
      if (!inspection) return;
      clearHover();
      selectThemeRole(inspection.role, true);
      shouldDisarmAfterClick = true;
    };
    const blockInspectedClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (shouldDisarmAfterClick) setIsInspecting(false);
      shouldDisarmAfterClick = false;
    };
    const cancelInspection = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      clearHover();
      clearInspectorSelection();
    };
    const refreshHover = () => {
      if (!hoverInspection || hoverFrame !== null) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = null;
        if (hoverInspection) {
          showThemeInspectorHover(
            hoverInspection,
            familyLabel(hoverInspection.role) ??
              getThemeRoleLabel(hoverInspection.role),
          );
        }
      });
    };
    const clearHoverOnScroll = () => clearHover();

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("click", blockInspectedClick, true);
    document.addEventListener("keydown", cancelInspection, true);
    window.addEventListener("resize", refreshHover);
    window.addEventListener("scroll", clearHoverOnScroll, true);
    return () => {
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("click", blockInspectedClick, true);
      document.removeEventListener("keydown", cancelInspection, true);
      window.removeEventListener("resize", refreshHover);
      window.removeEventListener("scroll", clearHoverOnScroll, true);
      clearHoverTimer();
      if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
      clearThemeInspectorHover();
    };
  }, [clearInspectorSelection, isInspecting, open, selectThemeRole]);

  const handleAdvancedChange = (checked: boolean) => {
    setIsAdvanced(checked);
    if (checked) return;
    if (selectedRole && !THEME_EDITOR_SIMPLE_ROLES.includes(selectedRole)) {
      setSelectedRole(null);
    }
    if (!shouldRegenerateGuidedColors) return;

    const managedAppearances: ReadonlyArray<ThemeAppearance> =
      editingTheme && getThemeModes(editingTheme).length > 1
        ? ["light", "dark"]
        : [activeAppearance];
    setSimpleColorsDirtyByAppearance((current) => {
      const next = { ...current };
      for (const appearance of managedAppearances) next[appearance] = true;
      return next;
    });
    setColorsByAppearance((current) => {
      const next = { ...current };
      for (const appearance of managedAppearances) {
        next[appearance] = getManagedEditorColors(appearance, current[appearance]);
      }
      return next;
    });
    setShouldRegenerateGuidedColors(false);
  };

  const handleSubmit = () => {
    if (!name.trim()) {
      setError(t("appearance.nameFirst"));
      return;
    }

    try {
      const colorsForSave = !isAdvanced
        ? {
            light: simpleColorsDirtyByAppearance.light
              ? getManagedEditorColors("light", colorsByAppearance.light)
              : colorsByAppearance.light,
            dark: simpleColorsDirtyByAppearance.dark
              ? getManagedEditorColors("dark", colorsByAppearance.dark)
              : colorsByAppearance.dark,
          }
        : colorsByAppearance;

      let savedTheme: ThemeDefinition;
      let mergedAppearance: ThemeAppearance | null = null;
      let retiredTheme: ThemeDefinition | null = null;
      if (editingTheme && mergeTarget) {
        const editedModes = getThemeModes(editingTheme);
        const collision = editedModes.find((mode) => takenAppearances.includes(mode));
        if (collision) {
          setError(t("appearance.hasPalettePickName", { name: mergeTarget.label, mode: modeWord(collision) }));
          return;
        }
        mergedAppearance = editedModes[0] ?? null;
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: mergeTarget.id,
            name: mergeTarget.label,
            appearance: mergeTarget.appearance,
            colors: mergeTarget.colors,
            variants: {
              ...mergeTarget.variants,
              ...Object.fromEntries(editedModes.map((mode) => [mode, colorsForSave[mode]])),
            },
            ...(mergeTarget.managed === true && !isAdvanced ? { managed: true } : {}),
          }),
          ...(mergeTarget.collection ? { collection: mergeTarget.collection } : {}),
        });
        retiredTheme = editingTheme;
        retireMergedTheme(editingTheme, mergeTarget);
      } else if (editingTheme) {
        const baseAppearance = editingTheme.appearance;
        const variantAppearance = baseAppearance === "light" ? "dark" : "light";
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: editingTheme.id,
            name,
            appearance: baseAppearance,
            colors: colorsForSave[baseAppearance],
            ...(getThemeModes(editingTheme).length > 1
              ? { variants: { [variantAppearance]: colorsForSave[variantAppearance] } }
              : {}),
            ...(isAdvanced ? {} : { managed: true }),
          }),
          ...(editingTheme.collection ? { collection: editingTheme.collection } : {}),
        });
      } else if (mergeTarget) {
        if (takenAppearances.includes(activeAppearance)) {
          setError(
            t("appearance.hasBothPalettes", { name: mergeTarget.label }),
          );
          return;
        }
        mergedAppearance = activeAppearance;
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: mergeTarget.id,
            name: mergeTarget.label,
            appearance: mergeTarget.appearance,
            colors: mergeTarget.colors,
            variants: {
              ...mergeTarget.variants,
              [activeAppearance]: colorsForSave[activeAppearance],
            },
            ...(mergeTarget.managed === true && !isAdvanced ? { managed: true } : {}),
          }),
          ...(mergeTarget.collection ? { collection: mergeTarget.collection } : {}),
        });
      } else {
        savedTheme = installCustomTheme(
          parseThemeFile({
            version: THEME_FILE_VERSION,
            name,
            appearance: activeAppearance,
            colors: colorsForSave[activeAppearance],
            ...(isAdvanced ? {} : { managed: true }),
          }),
        );
      }
      if (
        !onSaved(savedTheme, {
          created: editingTheme === null && mergedAppearance === null,
          ...(mergedAppearance ? { mergedAppearance } : {}),
        })
      ) {
        if (!editingTheme && mergedAppearance === null) {
          try {
            removeCustomTheme(savedTheme.id);
          } catch {}
        } else if (mergeTarget && mergedAppearance !== null) {
          try {
            updateCustomTheme(mergeTarget);
            if (retiredTheme) installCustomTheme(retiredTheme);
          } catch {}
        }
        setError(t("appearance.savedNotActive"));
        return;
      }
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : isEditing
            ? t("appearance.saveThemeFailed")
            : t("appearance.createThemeFailed"),
      );
    }
  };

  const renderNameField = () => (
    <label className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
      <span className="text-sm font-medium">{t("appearance.themeName")}</span>
      <Input
        autoFocus
        className="h-8"
        onChange={(event) => {
          setName(event.currentTarget.value);
          setError(null);
        }}
        placeholder={isEditing ? t("appearance.themeName") : t("appearance.themeNameExample")}
        value={name}
      />
    </label>
  );

  const renderAppearanceButtons = () => (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
      <span className="text-sm font-medium">{t("appearance.themeAppearance")}</span>
      <SegmentedControl
        aria-label={t("appearance.themeAppearanceGroup")}
        className="w-fit"
        items={(["light", "dark"] as const).map((appearance) => ({
          value: appearance,
          label: appearance === "light" ? t("appearance.light") : t("appearance.dark"),
          // A locked mode stays reachable so its tooltip can say why it is off.
          disabled: appearanceLockReason(appearance) !== null,
          reason: appearanceLockReason(appearance) ?? undefined,
        }))}
        onValueChange={(next) => {
          if (next === "light" || next === "dark") setActiveAppearance(next);
        }}
        value={activeAppearance}
      />
    </div>
  );

  const renderColorsHeader = () => (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-3">
      <div>
        <h3 className="text-sm font-medium">{t("appearance.colors")}</h3>
        {isAdvanced ? null : (
          <p className="text-xs text-muted-foreground">{t("appearance.twoColors")}</p>
        )}
      </div>
      <div className="flex min-w-0 items-start gap-3">
        {isAdvanced ? (
          <Input
            aria-label={t("appearance.filterColors")}
            className="h-8 min-w-0 flex-1"
            onChange={(event) => setRoleQuery(event.currentTarget.value)}
            placeholder={t("appearance.filterColors")}
            value={roleQuery}
          />
        ) : null}
        <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-2 pt-0.5 text-sm font-medium">
          <span>{t("appearance.advanced")}</span>
          <Switch
            aria-label={t("appearance.useAdvancedColors")}
            checked={isAdvanced}
            onCheckedChange={(checked) => handleAdvancedChange(Boolean(checked))}
          />
        </label>
      </div>
    </div>
  );

  const renderRoleFields = (
    families: ReadonlyArray<ThemeEditorColorFamily>,
    gridClassName = "grid gap-2 sm:grid-cols-2",
  ) => (
    <div className={gridClassName}>
      {families.map((family) => (
        <ThemeColorField
          key={family.id}
          label={t(family.labelKey)}
          onChange={updateColor}
          onSelect={selectThemeRole}
          onToggleSelected={toggleThemeRole}
          role={family.role}
          selected={selectedRole === family.role}
          value={colorsByAppearance[activeAppearance][family.role]}
        />
      ))}
    </div>
  );

  const renderColorFields = () => {
    const query = roleQuery.trim().toLowerCase();
    const groups = THEME_EDITOR_ROLE_GROUPS.map((group) => ({
      ...group,
      families: group.families.filter(
        (family) =>
          !query ||
          [t(family.labelKey), ...family.roles.map((role) => getThemeRoleLabel(role))]
            .join(" ")
            .toLowerCase()
            .includes(query),
      ),
    })).filter((group) => group.families.length > 0);
    return isAdvanced ? (
      <div className="space-y-5">
        {groups.map((group) => (
          <section className="space-y-2" key={group.id}>
            <h4 className="text-sm font-medium text-foreground">{t(group.titleKey)}</h4>
            {renderRoleFields(group.families, "grid gap-1")}
          </section>
        ))}
        {groups.length === 0 ? <p className="text-xs text-muted-foreground">{t("appearance.noMatches")}</p> : null}
      </div>
    ) : (
      <div className="grid gap-1">
        {THEME_EDITOR_SIMPLE_ROLES.map((role) => (
          <ThemeColorField
            key={role}
            onChange={updateColor}
            onSelect={selectThemeRole}
            onToggleSelected={toggleThemeRole}
            role={role}
            label={role === "canvas" ? t("appearance.familyBackground") : t("appearance.familyAccent")}
            selected={selectedRole === role}
            value={colorsByAppearance[activeAppearance][role]}
          />
        ))}
      </div>
    );
  };

  const clampPosition = (x: number, y: number) => clampPanelPosition(panelRef.current, x, y);

  const handleDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, input, a")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = { dx: event.clientX - rect.x, dy: event.clientY - rect.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDragPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const offset = dragOffsetRef.current;
    if (!offset) return;
    setPosition(clampPosition(event.clientX - offset.dx, event.clientY - offset.dy));
  };

  const endDrag = () => {
    dragOffsetRef.current = null;
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    // The grip drags the bottom-right corner, so the top-left must hold
    // still; the default parking spot is anchored bottom-right and would
    // slide, so it converts to an explicit position first.
    if (position === null) setPosition(clampPosition(rect.x, rect.y));
    resizeStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    const margin = 8;
    const MIN_WIDTH = 280;
    const MIN_HEIGHT = 220;
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - margin - start.left);
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - margin - start.top);
    setSize({
      width: Math.min(Math.max(start.width + event.clientX - start.pointerX, MIN_WIDTH), maxWidth),
      height: Math.min(
        Math.max(start.height + event.clientY - start.pointerY, MIN_HEIGHT),
        maxHeight,
      ),
    });
  };

  const endResize = () => {
    resizeStartRef.current = null;
  };

  return (
    <div
      aria-label={isEditing ? t("appearance.editTheme") : t("appearance.createTheme")}
      className={cn(
        "dialog-glass fixed z-[110] flex max-h-[min(42rem,calc(100dvh-6rem))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border text-popover-foreground",
        position === null && "bottom-4 right-4",
        isMinimized && "max-h-none",
      )}
      data-theme-editor-panel
      ref={panelRef}
      role="dialog"
      style={{
        ...(position ? { left: position.x, top: position.y } : {}),
        ...(size ? { width: size.width } : {}),
        ...(size && !isMinimized ? { height: size.height, maxHeight: "calc(100dvh - 1rem)" } : {}),
      }}
    >
      <div
        className="flex cursor-grab touch-none select-none items-center gap-1 border-b border-border/70 px-3 py-2 active:cursor-grabbing"
        onPointerCancel={endDrag}
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={endDrag}
      >
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="shrink-0 truncate text-sm font-medium">
            {isEditing ? t("appearance.editTheme") : t("appearance.createTheme")}
          </h2>
          {isMinimized ? null : (
            <p className="truncate text-xs text-muted-foreground">
              {isInspecting
                ? t("appearance.selectElement")
                : selectedRole
                  ? t("appearance.roleUses", {
                      name: isAdvanced ? (familyLabel(selectedRole) ?? getThemeRoleLabel(selectedRole)) : getThemeRoleLabel(selectedRole),
                      count: usageCount ?? 0,
                    })
                  : t("appearance.selectColorBelow")}
            </p>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={isInspecting ? t("appearance.cancelInspecting") : t("appearance.inspectColors")}
                aria-pressed={isInspecting}
                size="xs"
                variant={isInspecting ? "secondary" : "ghost"}
                onClick={() => {
                  if (isInspecting) {
                    clearInspectorSelection();
                    return;
                  }
                  setIsInspecting(true);
                }}
              >
                <MousePointer2Icon />
                {isInspecting ? t("common.cancel") : t("appearance.inspect")}
              </Button>
            }
          />
          <TooltipContent data-theme-editor-panel="">
            {isInspecting ? t("appearance.cancelClearSelection") : t("appearance.pickFromApp")}
          </TooltipContent>
        </Tooltip>
        <Button
          aria-label={isMinimized ? t("appearance.expandEditor") : t("appearance.minimizeEditor")}
          size="icon-xs"
          variant="ghost"
          onClick={() => setIsMinimized(!isMinimized)}
        >
          {isMinimized ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
        <Button
          aria-label={t("appearance.closeEditor")}
          size="icon-xs"
          variant="ghost"
          onClick={() => onOpenChange(false)}
        >
          <XIcon />
        </Button>
      </div>

      {isMinimized ? null : (
        <>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto py-3 pl-3 pr-1.5">
            {renderNameField()}
            {error ? (
              <p aria-live="polite" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {renderAppearanceButtons()}
            <div className="space-y-3">
              {renderColorsHeader()}
              {renderColorFields()}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border/70 px-3 py-2">
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!name.trim()} size="sm" onClick={handleSubmit}>
              {isEditing ? (
                mergeTarget ? (
                  t("appearance.mergeInto", { name: mergeTarget.label })
                ) : (
                  t("appearance.saveChanges")
                )
              ) : mergeTarget ? (
                <>
                  <PlusIcon />
                  {t("appearance.addPalette", { mode: modeWord(activeAppearance) })}
                </>
              ) : (
                <>
                  <PaintbrushIcon />
                  {t("appearance.createTheme")}
                </>
              )}
            </Button>
          </div>
          <div
            aria-hidden
            className="absolute bottom-0 right-0 z-10 flex size-5 cursor-se-resize touch-none select-none items-end justify-end p-1 text-muted-foreground/70"
            onPointerCancel={endResize}
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={endResize}
          >
            <svg
              className="size-2.5"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.2"
              viewBox="0 0 8 8"
            >
              <path d="M7 1 1 7M7 4.5 4.5 7" />
            </svg>
          </div>
        </>
      )}
    </div>
  );
}
