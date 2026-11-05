/**
 * Cross-feature revocation hooks. Group edits, granular permission commits, and admin account cleanup
 * call this after their transaction commits. Channel listeners abort live AI work and publish a generic
 * sync; a rolled-back transaction produces neither.
 */

const listeners = new Set<() => void>();

export function onChannelRevocation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function requestChannelRevocation(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error("[channels] revocation listener failed:", (error as Error).message);
    }
  }
}
