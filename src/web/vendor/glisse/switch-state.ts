// Adapted from Glisse 0.5.0 (MIT, Copyright (c) 2026 Kelvin Zhang), sections
// src/switch.tsx (drag thresholds, settle/commit) and
// src/internal/controllable.ts (controlled/uncontrolled resolution).
// Pure control state: no React, no DOM. See UPSTREAM.md for every change.

/** A press must travel this far horizontally before it counts as a drag. */
export const DRAG_THRESHOLD = 4;
/** A press that moves this far vertically, mostly vertically, gives the page its scroll. */
export const VERTICAL_SLOP = 10;
/** Upstream's rubber band beyond either end of the track. */
const OVERSHOOT = 22;

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The value shown before any interaction: the controlled prop wins, then defaultChecked. */
export function initialChecked(controlled: boolean | undefined, fallback: boolean | undefined): boolean {
  return controlled ?? fallback ?? false;
}

export interface ToggleInput {
  checked: boolean;
  controlled: boolean;
  disabled: boolean;
  loading: boolean;
}

export interface ToggleDecision {
  requested: boolean;
  /** Uncontrolled switches apply the value themselves; a controlled one waits for its parent. */
  applyLocally: boolean;
}

/** One accepted action's outcome, or null when the switch cannot change at all. */
export function toggleDecision({ checked, controlled, disabled, loading }: ToggleInput): ToggleDecision | null {
  if (disabled || loading) return null;
  return { requested: !checked, applyLocally: !controlled };
}

export interface DragInput {
  /** The checked value the drag started from. */
  from: boolean;
  /** Pointer movement in physical CSS px. */
  dx: number;
  /** Distance between the two thumb rests, measured from the rendered control. */
  travel: number;
  rtl: boolean;
}

/**
 * A drag's position along the track in logical order: in RTL the track's
 * checked end is the physical start, so the same rightward movement lowers the
 * value instead of raising it.
 */
export function dragPosition({ from, dx, travel, rtl }: DragInput): number {
  const start = from ? 1 : 0;
  if (!(travel > 0)) return start;
  const logical = start + (rtl ? -dx : dx) / travel;
  const overshoot = logical < 0 ? logical : logical > 1 ? logical - 1 : 0;
  return clamp01(logical) + overshoot / OVERSHOOT;
}

/** A drag's progress across the track, clamped to it. */
export function dragFraction({ from, dx, travel, rtl }: DragInput): number {
  const start = from ? 1 : 0;
  if (!(travel > 0)) return start;
  return clamp01(start + (rtl ? -dx : dx) / travel);
}

/** The committed value of a drag that has crossed the halfway point. */
export function dragTarget(input: DragInput): boolean {
  if (!(input.travel > 0)) return input.from;
  return dragFraction(input) > 0.5;
}

/** A press that moved mostly vertically leaves the value alone so the page can scroll. */
export function isVerticalEscape(dx: number, dy: number): boolean {
  return Math.abs(dy) > VERTICAL_SLOP && Math.abs(dy) > Math.abs(dx) + DRAG_THRESHOLD;
}

/**
 * The value a release commits, or null when it changes nothing: a cancelled
 * gesture and a press that never became a drag both settle back to the value
 * the switch had, and only the following click (if any) toggles it.
 */
export function releaseTarget(input: DragInput & { moved: boolean; cancelled: boolean }): boolean | null {
  if (input.cancelled || !input.moved) return null;
  return dragTarget(input);
}

export type SwitchAttributes = Record<string, unknown>;

const RESERVED = ["role", "type", "aria-checked", "aria-busy", "disabled", "data-checked", "data-disabled"] as const;

export interface SwitchAttributeInput {
  checked: boolean;
  disabled: boolean;
  loading: boolean;
  /** Everything the caller forwarded, including name/id/aria/className/style. */
  attributes?: object;
}

/**
 * The button's semantics, built after the caller's attributes so none of them
 * can break them: one native button, role=switch, a boolean aria-checked, and
 * disabled (including loading) forced from state. data-checked and
 * data-disabled stay present/absent for the app's existing selectors.
 */
export function switchAttributes({ checked, disabled, loading, attributes = {} }: SwitchAttributeInput): SwitchAttributes {
  const rest: SwitchAttributes = { ...attributes };
  for (const key of RESERVED) delete rest[key];
  const off = disabled || loading;
  return {
    ...rest,
    type: "button",
    role: "switch",
    "aria-checked": checked,
    ...(off ? { disabled: true, "data-disabled": "" } : {}),
    ...(checked ? { "data-checked": "" } : {}),
    ...(loading ? { "aria-busy": true } : {}),
  };
}
