import { useSyncExternalStore, useState, type CSSProperties } from "react";
import { t, type PlainMessageKey } from "@/i18n";
import { formatPercent } from "@/i18n/format";
import { glassEffective, subscribeGlassEffective } from "@/components/glass/glass-environment";
import type { GlassTier } from "@/theme/glass";

const TIER_LABELS: Record<GlassTier, PlainMessageKey> = {
  high: "appearance.glassEffectiveHigh",
  balanced: "appearance.glassEffectiveBalanced",
  css: "appearance.glassEffectiveCss",
  solid: "appearance.glassEffectiveSolid",
};

const isTier = (value: string): value is GlassTier =>
  value === "high" || value === "balanced" || value === "css" || value === "solid";

/**
 * A small piece of real content behind two real surfaces. The material is the
 * app's own CSS (`data-glass-surface`); the Glass runtime may register the
 * marked source later, but nothing here depends on it, so the preview is
 * honest in CSS and solid modes too.
 *
 * The pane is a bounded sample: no screenshot, no image download, and no
 * animation of its own. Moving the sample is a deliberate keyboard-operable
 * action, so the user can watch content cross an edge.
 */
export function GlassPreview() {
  const effective = useSyncExternalStore(subscribeGlassEffective, glassEffective, glassEffective);
  const tier = isTier(effective.tier) ? effective.tier : "css";
  const [position, setPosition] = useState(50);
  const ratio = position / 100;

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{t("appearance.glassPreviewTitle")}</p>
        <p className="text-muted-foreground text-xs">{t("appearance.glassPreviewDescription")}</p>
      </div>

      <div
        role="img"
        aria-label={t("appearance.glassPreviewDescription")}
        className="bg-background relative h-[180px] w-full max-w-[320px] overflow-hidden rounded-xl border shadow-[var(--depth-highlight),var(--shadow-raised)]"
        style={{ "--glass-preview-shift": `${ratio * 48}px` } as CSSProperties}
      >
        {/*
          The marked source is real DOM, not a background image. It is
          decorative: the sample text is hidden from assistive technology, and
          the pane above is described once.
        */}
        <div
          data-glisse-backdrop="preview-content"
          data-glass-source="preview"
          aria-hidden="true"
          className="absolute inset-0 flex flex-col gap-2 p-3"
          style={{ translate: "0 calc(-1 * var(--glass-preview-shift, 24px))" }}
        >
          <div className="bg-message text-message-foreground ms-auto w-[70%] rounded-lg px-2 py-1 text-2xs leading-4">
            {t("appearance.glassPreviewSampleUser")}
          </div>
          <div className="text-foreground/85 w-[86%] text-2xs leading-4">
            {t("appearance.glassPreviewSampleReply")}
          </div>
          <div className="flex gap-2">
            <span className="bg-primary/20 h-6 w-10 rounded-md" />
            <span className="bg-primary/40 h-6 w-6 rounded-md" />
            <span className="bg-primary/10 h-6 flex-1 rounded-md" />
          </div>
          <div className="text-foreground/70 w-full text-2xs leading-4">
            {t("appearance.glassPreviewSampleReply")}
          </div>
          <div className="bg-primary/15 h-8 w-[55%] rounded-lg" />
        </div>

        {/* A popup shape over the sample content. */}
        <div
          data-glass-surface="overlay"
          data-glass-renderer="css"
          aria-hidden="true"
          className="absolute end-3 top-3 flex w-24 flex-col gap-1.5 rounded-lg border p-2"
        >
          <span className="bg-foreground/25 h-1.5 w-14 rounded-full" />
          <span className="bg-foreground/15 h-1.5 w-16 rounded-full" />
          <span className="bg-primary/40 h-1.5 w-10 rounded-full" />
        </div>

        {/* A composer shape at the bottom edge. */}
        <div
          data-glass-surface="composer"
          data-glass-renderer="css"
          aria-hidden="true"
          className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-xl border px-2 py-1.5"
        >
          <span className="bg-foreground/20 h-1.5 flex-1 rounded-full" />
          <span className="bg-primary size-4 rounded-full" />
        </div>
      </div>

      <div className="flex max-w-[320px] items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={position}
          aria-label={t("appearance.glassPreviewMove")}
          aria-valuetext={formatPercent(ratio)}
          className="settings-slider min-w-0 flex-1"
          style={
            {
              "--settings-slider-progress": `${position}%`,
              "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
            } as CSSProperties
          }
          onChange={(event) => setPosition(Number(event.currentTarget.value))}
        />
        <output className="text-muted-foreground w-10 shrink-0 text-right text-xs tabular-nums">
          {formatPercent(ratio)}
        </output>
      </div>

      {tier === "css" || tier === "solid" ? (
        <p className="text-muted-foreground text-xs" role="status">
          {t(TIER_LABELS[tier])}
        </p>
      ) : null}
    </div>
  );
}
