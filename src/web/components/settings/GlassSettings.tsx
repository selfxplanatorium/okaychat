import { useState, useSyncExternalStore, type CSSProperties } from "react";
import { ChevronDownIcon, RotateCcwIcon } from "lucide-react";
import { t, type PlainMessageKey } from "@/i18n";
import { formatNumber, formatPercent } from "@/i18n/format";
import { SettingsRow, SettingsSection } from "@/components/settings/SettingsUI";
import { GlassPreview } from "@/components/settings/GlassPreview";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useAppearance } from "@/state/appearance";
import { DEFAULT_GLASS_OPACITY, MAX_GLASS_OPACITY, MIN_GLASS_OPACITY } from "@/theme/settings";
import { glassEffective, subscribeGlassEffective } from "@/components/glass/glass-environment";
import type { GlassReason } from "@/components/glass/glass-policy";
import {
  glassPresetPatch,
  glassResetPatch,
  glassValuePatch,
  visibleGlassPreset,
  type GlassTier,
} from "@/theme/glass";
import {
  GLASS_DEFAULTS,
  GLASS_FAMILIES,
  GLASS_FAMILY_KEYS,
  GLASS_NUMERIC_KEYS,
  GLASS_PRESETS,
  GLASS_RANGES,
  type GlassFamily,
  type GlassNumericKey,
  type GlassPerformance,
  type GlassPresetName,
  type GlassTuple,
} from "@shared/appearance";

const PRESET_LABELS: Record<GlassPresetName, PlainMessageKey> = {
  subtle: "appearance.glassPresetSubtle",
  standard: "appearance.glassPresetStandard",
  bold: "appearance.glassPresetBold",
};

const PERFORMANCE_LABELS: Record<GlassPerformance, PlainMessageKey> = {
  auto: "appearance.glassPerformanceAuto",
  high: "appearance.glassPerformanceHigh",
  balanced: "appearance.glassPerformanceBalanced",
  css: "appearance.glassPerformanceCss",
  off: "appearance.glassPerformanceOff",
};

const FAMILY_LABELS: Record<GlassFamily, PlainMessageKey> = {
  sidebar: "appearance.glassSidebar",
  composer: "appearance.glassComposer",
  overlays: "appearance.glassOverlays",
  cards: "appearance.glassCards",
  toolbars: "appearance.glassToolbars",
  controls: "appearance.glassControls",
};

const TIER_LABELS: Record<GlassTier, PlainMessageKey> = {
  high: "appearance.glassEffectiveHigh",
  balanced: "appearance.glassEffectiveBalanced",
  css: "appearance.glassEffectiveCss",
  solid: "appearance.glassEffectiveSolid",
};

const REASON_LABELS: Record<GlassReason, PlainMessageKey | null> = {
  ok: null,
  "forced-colors": "appearance.glassReasonForcedColors",
  "reduced-transparency": "appearance.glassReasonReducedTransparency",
  opaque: "appearance.glassReasonOpaque",
  "reduced-motion": "appearance.glassReasonReducedMotion",
  "motion-off": "appearance.glassReasonMotionOff",
  "requested-off": "appearance.glassReasonRequestedOff",
  "requested-css": "appearance.glassReasonRequestedCss",
  unsupported: "appearance.glassReasonUnsupported",
  "low-end": "appearance.glassReasonLowEnd",
  downgraded: "appearance.glassReasonBudget",
  "load-failed": "appearance.glassReasonLoadFailed",
};

const NUMERIC_ROWS: Array<{ key: GlassNumericKey; label: PlainMessageKey; description: PlainMessageKey }> = [
  { key: "glassBend", label: "appearance.glassBend", description: "appearance.glassBendDescription" },
  { key: "glassDispersion", label: "appearance.glassDispersion", description: "appearance.glassDispersionDescription" },
  { key: "glassFrost", label: "appearance.glassFrost", description: "appearance.glassFrostDescription" },
  { key: "glassRimShine", label: "appearance.glassRimShine", description: "appearance.glassRimShineDescription" },
  { key: "glassTint", label: "appearance.glassTint", description: "appearance.glassTintDescription" },
];

/** Bend, dispersion, rim, and tint are fractions; frost is a pixel length. */
function glassValueText(key: GlassNumericKey, value: number): string {
  if (key === "glassFrost") return t("appearance.glassPixels", { n: formatNumber(value) });
  if (key === "glassTint") return formatPercent(value / 100, { maximumFractionDigits: 2 });
  return formatPercent(value, { maximumFractionDigits: 2 });
}

/** Range input styled by the ported `.settings-slider` CSS, with a visible value and value text. */
function GlassSlider({
  label,
  value,
  min,
  max,
  step,
  valueText,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  valueText: string;
  onChange: (value: number) => void;
}) {
  const ratio = (value - min) / (max - min);
  return (
    <div className="flex w-full items-center gap-3 sm:w-56">
      <input
        type="range"
        aria-label={label}
        aria-valuetext={valueText}
        className="settings-slider min-w-0 flex-1"
        min={min}
        max={max}
        step={step}
        value={value}
        style={
          {
            "--settings-slider-progress": `${ratio * 100}%`,
            "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
          } as CSSProperties
        }
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <output className="text-foreground w-12 shrink-0 text-right font-sans text-sm tabular-nums">{valueText}</output>
    </div>
  );
}

/**
 * The Glass section: preset, the mode this device actually runs, a live
 * preview, then the values, performance, and family switches behind an
 * Advanced disclosure. Every change goes through the ordinary appearance
 * update, so it batches into one debounced account save.
 */
export function GlassSettings() {
  const update = useAppearance((state) => state.update);
  const preset = useAppearance((state) => state.glassPreset);
  const glassBend = useAppearance((state) => state.glassBend);
  const glassDispersion = useAppearance((state) => state.glassDispersion);
  const glassFrost = useAppearance((state) => state.glassFrost);
  const glassRimShine = useAppearance((state) => state.glassRimShine);
  const glassTint = useAppearance((state) => state.glassTint);
  const performance = useAppearance((state) => state.glassPerformance);
  const glassSidebar = useAppearance((state) => state.glassSidebar);
  const glassComposer = useAppearance((state) => state.glassComposer);
  const glassOverlays = useAppearance((state) => state.glassOverlays);
  const glassCards = useAppearance((state) => state.glassCards);
  const glassToolbars = useAppearance((state) => state.glassToolbars);
  const glassControls = useAppearance((state) => state.glassControls);
  const glassOpacity = useAppearance((state) => state.glassOpacity);

  const [advanced, setAdvanced] = useState(false);
  const advancedId = "glass-advanced-values";
  const effective = useSyncExternalStore(subscribeGlassEffective, glassEffective, glassEffective);

  const tuple: GlassTuple = { glassBend, glassDispersion, glassFrost, glassRimShine, glassTint };
  // The tuple is authoritative: concurrent devices can leave a stored name behind.
  const shownPreset = visibleGlassPreset(tuple);
  const tier: GlassTier =
    effective.tier === "high" || effective.tier === "balanced" || effective.tier === "css" || effective.tier === "solid"
      ? effective.tier
      : "css";
  const reasonLabel = Object.hasOwn(REASON_LABELS, effective.reason)
    ? REASON_LABELS[effective.reason as GlassReason]
    : null;

  const families: Record<GlassFamily, boolean> = {
    sidebar: glassSidebar,
    composer: glassComposer,
    overlays: glassOverlays,
    cards: glassCards,
    toolbars: glassToolbars,
    controls: glassControls,
  };

  const setFamily = (family: GlassFamily, checked: boolean) => {
    const patch: Partial<Record<(typeof GLASS_FAMILY_KEYS)[GlassFamily], boolean>> = {};
    patch[GLASS_FAMILY_KEYS[family]] = checked;
    update(patch);
  };

  const atDefaults =
    GLASS_NUMERIC_KEYS.every((key) => tuple[key] === GLASS_DEFAULTS[key]) &&
    preset === GLASS_DEFAULTS.glassPreset &&
    performance === GLASS_DEFAULTS.glassPerformance &&
    GLASS_FAMILIES.every((family) => families[family] === GLASS_DEFAULTS[GLASS_FAMILY_KEYS[family]]) &&
    glassOpacity === DEFAULT_GLASS_OPACITY;

  return (
    <SettingsSection title={t("appearance.glassTitle")} description={t("appearance.glassDescription")}>
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("appearance.glassPreset")}</p>
          <p className="text-muted-foreground text-xs">{t("appearance.glassPresetDescription")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            aria-label={t("appearance.glassPreset")}
            items={GLASS_PRESETS.map((value) => ({ value, label: t(PRESET_LABELS[value]) }))}
            value={shownPreset === "custom" ? "" : shownPreset}
            onValueChange={(value: string) => {
              const next = GLASS_PRESETS.find((name) => name === value);
              if (next) update(glassPresetPatch(next));
            }}
          />
          {shownPreset === "custom" && (
            <span className="text-muted-foreground text-xs">{t("appearance.glassPresetCustom")}</span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-0.5 px-4 pb-1 text-xs">
        <p className="text-foreground font-medium" role="status">
          {t(TIER_LABELS[tier])}
        </p>
        {reasonLabel && <p className="text-muted-foreground">{t(reasonLabel)}</p>}
      </div>

      <GlassPreview />

      <SettingsRow
        label={t("appearance.glassOpacity")}
        description={t("appearance.glassOpacityDescription")}
        reset={glassOpacity !== DEFAULT_GLASS_OPACITY ? () => update({ glassOpacity: DEFAULT_GLASS_OPACITY }) : null}
        control={
          <GlassSlider
            label={t("appearance.glassOpacity")}
            value={glassOpacity}
            min={MIN_GLASS_OPACITY}
            max={MAX_GLASS_OPACITY}
            step={5}
            valueText={formatPercent(glassOpacity / 100)}
            onChange={(glassOpacity) => update({ glassOpacity })}
          />
        }
      />

      <SettingsRow
        label={t("appearance.advanced")}
        description={t("appearance.glassAdvancedDescription")}
        control={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("appearance.advanced")}
            aria-expanded={advanced}
            aria-controls={advancedId}
            onClick={() => setAdvanced((value) => !value)}
          >
            <ChevronDownIcon className={cn("size-4 transition-transform duration-(--motion-fast)", advanced && "rotate-180")} />
          </Button>
        }
      />
      {advanced && (
        <div id={advancedId} className="settings-collapse">
          {NUMERIC_ROWS.map((row) => (
            <SettingsRow
              key={row.key}
              label={t(row.label)}
              description={t(row.description)}
              reset={tuple[row.key] !== GLASS_DEFAULTS[row.key] ? () => update(glassValuePatch(tuple, row.key, GLASS_DEFAULTS[row.key])) : null}
              control={
                <GlassSlider
                  label={t(row.label)}
                  value={tuple[row.key]}
                  min={GLASS_RANGES[row.key].min}
                  max={GLASS_RANGES[row.key].max}
                  step={GLASS_RANGES[row.key].step}
                  valueText={glassValueText(row.key, tuple[row.key])}
                  onChange={(value) => update(glassValuePatch(tuple, row.key, value))}
                />
              }
            />
          ))}
        </div>
      )}

      <SettingsRow
        label={t("appearance.glassPerformance")}
        description={t("appearance.glassPerformanceDescription")}
        reset={performance !== GLASS_DEFAULTS.glassPerformance ? () => update({ glassPerformance: GLASS_DEFAULTS.glassPerformance }) : null}
        control={
          <div className="w-full sm:w-48">
            <Select<GlassPerformance>
              aria-label={t("appearance.glassPerformance")}
              value={performance}
              options={(Object.keys(PERFORMANCE_LABELS) as GlassPerformance[]).map((value) => ({
                value,
                label: t(PERFORMANCE_LABELS[value]),
              }))}
              onValueChange={(glassPerformance) => update({ glassPerformance })}
            />
          </div>
        }
      />

      {GLASS_FAMILIES.map((family) => (
        <SettingsRow
          key={family}
          label={t(FAMILY_LABELS[family])}
          control={
            <Switch
              aria-label={t(FAMILY_LABELS[family])}
              checked={families[family]}
              onCheckedChange={(checked) => setFamily(family, checked)}
            />
          }
        />
      ))}

      <SettingsRow
        label={t("appearance.resetGlass")}
        description={t("appearance.resetGlassDescription")}
        control={
          <Button
            variant="outline"
            size="sm"
            data-command="appearance.resetGlass"
            disabled={atDefaults}
            onClick={() => update(glassResetPatch())}
          >
            <RotateCcwIcon />
            {t("settings.resetToDefault")}
          </Button>
        }
      />
    </SettingsSection>
  );
}
