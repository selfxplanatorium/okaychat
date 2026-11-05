// Pure Glass policy: which renderer a device gets, who holds the few live
// lenses, and when a struggling device steps down. No DOM access here; the
// runtime reads the environment and passes it in.
import type { GlassPerformance } from "../../../shared/appearance";
import type { GlassTier } from "../../theme/glass";

/** Stable diagnostic ids written to `data-glass-reason`; Settings translates them. */
export type GlassReason =
  | "ok"
  | "forced-colors"
  | "reduced-transparency"
  | "opaque"
  | "reduced-motion"
  | "motion-off"
  | "requested-off"
  | "requested-css"
  | "unsupported"
  | "low-end"
  | "downgraded"
  | "load-failed";

export interface GlassEnvironment {
  forcedColors: boolean;
  reducedTransparency: boolean;
  reducedMotion: boolean;
  /** The account switched off interface or transition motion. */
  motionOff: boolean;
  backdropFilter: boolean;
  deviceMemory?: number;
  hardwareConcurrency?: number;
  saveData?: boolean;
  coarsePointer: boolean;
  /** This document's runtime downgrade; never persisted. */
  downgrade?: "balanced" | "css" | null;
  engineFailed?: boolean;
}

export interface GlassEffective {
  tier: GlassTier;
  reason: GlassReason;
}

const RANK: Record<GlassTier, number> = { solid: 0, css: 1, balanced: 2, high: 3 };
const lower = (a: GlassTier, b: GlassTier) => (RANK[a] <= RANK[b] ? a : b);

export function isLowEnd(env: Pick<GlassEnvironment, "deviceMemory" | "hardwareConcurrency" | "saveData">): boolean {
  return (env.deviceMemory !== undefined && env.deviceMemory <= 4)
    || (env.hardwareConcurrency !== undefined && env.hardwareConcurrency <= 4)
    || env.saveData === true;
}

/**
 * The effective tier: the lowest cap among every applicable rule. The reason
 * is the first rule in precedence order that imposes that cap, so an explicit
 * user choice is not blamed on hardware and vice versa.
 */
export function effectiveGlass(prefs: { glassPerformance: GlassPerformance; glassOpacity: number }, env: GlassEnvironment): GlassEffective {
  const caps: Array<[GlassTier, GlassReason]> = [];
  if (env.forcedColors) caps.push(["solid", "forced-colors"]);
  if (env.reducedTransparency) caps.push(["solid", "reduced-transparency"]);
  if (prefs.glassOpacity >= 100) caps.push(["solid", "opaque"]);
  if (env.reducedMotion) caps.push(["solid", "reduced-motion"]);
  if (env.motionOff) caps.push(["css", "motion-off"]);
  if (prefs.glassPerformance === "off") caps.push(["solid", "requested-off"]);
  if (prefs.glassPerformance === "css") caps.push(["css", "requested-css"]);
  if (!env.backdropFilter) caps.push(["solid", "unsupported"]);
  if (isLowEnd(env)) caps.push(["css", "low-end"]);
  if (env.engineFailed) caps.push(["css", "load-failed"]);
  if (env.downgrade) caps.push([env.downgrade, "downgraded"]);

  let requested: GlassTier;
  if (prefs.glassPerformance === "high") requested = "high";
  else if (prefs.glassPerformance === "balanced") requested = "balanced";
  else if (prefs.glassPerformance === "auto") {
    // Missing device APIs do not imply a powerful device.
    const unknown = env.deviceMemory === undefined && env.hardwareConcurrency === undefined;
    requested = env.coarsePointer || unknown ? "balanced" : "high";
  } else requested = "high";

  const tier = caps.reduce<GlassTier>((current, [cap]) => lower(current, cap), requested);
  const reason = caps.find(([cap]) => cap === tier)?.[1] ?? "ok";
  return { tier, reason };
}

/** Lens allowance per tier (section 4 of the Glass design). */
export const TIER_BUDGETS: Record<GlassTier, { large: number; controls: number; sources: number; mapDensity: number; mapPixels: number; sourcePixels: number; frameMs: number }> = {
  high: { large: 3, controls: 1, sources: 2, mapDensity: 1.5, mapPixels: 650_000, sourcePixels: 2_000_000, frameMs: 1000 / 60 },
  balanced: { large: 1, controls: 1, sources: 1, mapDensity: 1, mapPixels: 300_000, sourcePixels: 800_000, frameMs: 1000 / 30 },
  css: { large: 0, controls: 0, sources: 0, mapDensity: 0, mapPixels: 0, sourcePixels: 0, frameMs: Infinity },
  solid: { large: 0, controls: 0, sources: 0, mapDensity: 0, mapPixels: 0, sourcePixels: 0, frameMs: Infinity },
};

export const GLASS_PRIORITY = {
  modal: 100,
  heldControl: 90,
  focusedComposer: 80,
  composer: 70,
  sidebar: 60,
  toolbar: 50,
  editorPanel: 40,
  card: 10,
  preview: 0,
} as const;

export interface LeaseCandidate {
  id: string;
  priority: number;
  /** Registration order; equal priorities keep it. */
  order: number;
  control: boolean;
  /** Source the lens bends; controls bend their own track. */
  sourceId: string | null;
  /** Visible source area in CSS px, clipped to its scroll root. */
  sourcePixels: number;
  visible: boolean;
  /** Blocked by a modal above it, a resize in progress, or a failed source check. */
  suspended: boolean;
}

/** Picks which hosts get a live lens. Everyone else keeps CSS material. */
export function assignLeases(candidates: readonly LeaseCandidate[], tier: GlassTier): Set<string> {
  const budget = TIER_BUDGETS[tier];
  const granted = new Set<string>();
  if (!budget.large && !budget.controls) return granted;
  const ordered = candidates
    .filter((candidate) => candidate.visible && !candidate.suspended)
    .sort((a, b) => b.priority - a.priority || a.order - b.order);
  let large = 0;
  let controls = 0;
  const sources = new Map<string, number>();
  let pixels = 0;
  for (const candidate of ordered) {
    if (candidate.control) {
      if (controls < budget.controls) {
        granted.add(candidate.id);
        controls++;
      }
      continue;
    }
    if (large >= budget.large || !candidate.sourceId) continue;
    const known = sources.has(candidate.sourceId);
    if (!known) {
      if (sources.size >= budget.sources || pixels + candidate.sourcePixels > budget.sourcePixels) continue;
      sources.set(candidate.sourceId, candidate.sourcePixels);
      pixels += candidate.sourcePixels;
    }
    granted.add(candidate.id);
    large++;
  }
  return granted;
}

/**
 * Map resolution for a lens of this size, scaled down to fit the tier's
 * pixel cap. Null when it would drop below half resolution: that host stays CSS.
 */
export function mapDensity(width: number, height: number, devicePixelRatio: number, tier: GlassTier): number | null {
  const budget = TIER_BUDGETS[tier];
  if (!budget.mapDensity || width <= 0 || height <= 0) return null;
  const wanted = Math.min(Math.max(devicePixelRatio, 1), budget.mapDensity);
  const fits = Math.sqrt(budget.mapPixels / (width * height));
  const density = Math.min(wanted, fits);
  return density / wanted < 0.5 ? null : density;
}

/** Engine work allowed per one-second window, before the tier steps down. */
export const ENGINE_WINDOW_BUDGET_MS: Record<GlassTier, number> = { high: 180, balanced: 60, css: 0, solid: 0 };
const SLOW_FRAME_MS = 24;
const SLOW_FRAMES = 10;

/**
 * Runtime downgrade for Auto: ten consecutive slow frames, or engine work over
 * budget in two one-second windows, steps high to balanced to CSS. Samples
 * count only during visible, active interaction; it never steps back up.
 */
export function createDowngradeMonitor(start: GlassTier) {
  let tier: GlassTier = start;
  let slow = 0;
  let overWindows = 0;
  const step = (): GlassTier | null => {
    const next: GlassTier | null = tier === "high" ? "balanced" : tier === "balanced" ? "css" : null;
    if (!next) return null;
    tier = next;
    slow = 0;
    overWindows = 0;
    return next;
  };
  return {
    get tier() {
      return tier;
    },
    /** Returns the new tier when this sample caused a downgrade. */
    frame(durationMs: number, context: { active: boolean; visible: boolean }): GlassTier | null {
      if (!context.active || !context.visible || (tier !== "high" && tier !== "balanced")) return null;
      slow = durationMs > SLOW_FRAME_MS ? slow + 1 : 0;
      return slow >= SLOW_FRAMES ? step() : null;
    },
    window(engineMs: number, context: { active: boolean; visible: boolean }): GlassTier | null {
      if (!context.active || !context.visible || (tier !== "high" && tier !== "balanced")) return null;
      if (engineMs > ENGINE_WINDOW_BUDGET_MS[tier]) overWindows++;
      else overWindows = 0;
      return overWindows >= 2 ? step() : null;
    },
  };
}
