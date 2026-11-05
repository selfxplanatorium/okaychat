/**
 * Monotonic process time for ephemeral leases and fixed windows. Wall time is never trusted here:
 * a clock jump must not extend a typing lease or a presence grace period. Tests replace the source
 * instead of sleeping.
 */

let source: () => number = () => performance.now();

export const activityNow = (): number => Math.floor(source());

/** Test seam: pass a function returning monotonic milliseconds. */
export function setActivityClock(clock: (() => number) | null): void {
  source = clock ?? (() => performance.now());
}
