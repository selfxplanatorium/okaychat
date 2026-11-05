// Device signals for the Glass policy. Device-local and ephemeral: nothing
// here is synced or persisted, including a runtime downgrade.
import type { MotionGroup } from "@shared/appearance";
import type { GlassEnvironment } from "./glass-policy";

const QUERIES = [
  "(forced-colors: active)",
  "(prefers-reduced-transparency: reduce)",
  "(prefers-reduced-motion: reduce)",
  "(pointer: coarse)",
] as const;

let downgrade: GlassEnvironment["downgrade"] = null;
let engineFailed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

const matches = (query: string) => typeof matchMedia === "function" && matchMedia(query).matches;

function supportsBackdrop(): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return false;
  return CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)");
}

export function readGlassEnvironment(motionOff: readonly MotionGroup[]): GlassEnvironment {
  const nav = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } });
  return {
    forcedColors: matches(QUERIES[0]),
    reducedTransparency: matches(QUERIES[1]),
    reducedMotion: matches(QUERIES[2]),
    coarsePointer: matches(QUERIES[3]),
    motionOff: motionOff.includes("interface") || motionOff.includes("transitions"),
    backdropFilter: supportsBackdrop(),
    deviceMemory: typeof nav?.deviceMemory === "number" ? nav.deviceMemory : undefined,
    hardwareConcurrency: typeof nav?.hardwareConcurrency === "number" && nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : undefined,
    saveData: nav?.connection?.saveData === true ? true : undefined,
    downgrade,
    engineFailed,
  };
}

/** Calls back when an OS preference or this document's runtime state changes. */
export function watchGlassEnvironment(callback: () => void): () => void {
  listeners.add(callback);
  const lists = typeof matchMedia === "function" ? QUERIES.map((query) => matchMedia(query)) : [];
  for (const list of lists) list.addEventListener("change", callback);
  return () => {
    listeners.delete(callback);
    for (const list of lists) list.removeEventListener("change", callback);
  };
}

/** Lowers the tier until the next document load. Never raised again in this document. */
export function setGlassDowngrade(next: "balanced" | "css") {
  if (downgrade === "css" || downgrade === next) return;
  downgrade = next;
  notify();
}

export function setGlassEngineFailed() {
  if (engineFailed) return;
  engineFailed = true;
  notify();
}

// The applied result, for Settings' notice and the runtime. Primitives only, so selectors stay stable.
let effective: { tier: string; reason: string } = { tier: "css", reason: "ok" };
const effectiveListeners = new Set<() => void>();

export function publishGlassEffective(tier: string, reason: string) {
  if (effective.tier === tier && effective.reason === reason) return;
  effective = { tier, reason };
  effectiveListeners.forEach((listener) => listener());
}

export function glassEffective() {
  return effective;
}

export function subscribeGlassEffective(listener: () => void): () => void {
  effectiveListeners.add(listener);
  return () => effectiveListeners.delete(listener);
}
