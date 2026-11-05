/**
 * A one-way notification from the settings write path to the ephemeral activity service.
 *
 * `settings.ts` must not import the activity registry (the registry reads preferences, so that would be
 * a cycle), and the registry must not be initialized by importing settings. This tiny listener module
 * keeps the dependency direction settings → hook ← activity.
 */

type Listener = (userId: string) => void;

const listeners = new Set<Listener>();

export function onChannelActivitySettingsChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyChannelActivitySettingsChange(userId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(userId);
    } catch (error) {
      console.error("[channels] activity settings listener failed:", (error as Error).message);
    }
  }
}
