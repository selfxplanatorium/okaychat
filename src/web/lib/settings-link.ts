/**
 * The one place that knows how to link to a settings section. Every deep link uses a numbered,
 * visible destination here instead of an ad-hoc URL, so a renamed section or anchor breaks typecheck
 * (and the test below checks the anchor ids) rather than silently dropping the user on General.
 */
export type SettingsSection =
  | "general"
  | "account"
  | "memory"
  | "email"
  | "providers"
  | "mcp"
  | "projects"
  | "schedules"
  | "usage"
  | "voice"
  | "appearance"
  | "keyboard"
  | "admin";

export interface SettingsDestination {
  section: SettingsSection;
  /** A row in the settings page, addressed by `id="setting-<anchor>"` and focused after the lazy page mounts. */
  anchor?: string;
}

/** `focus` is the query key `SettingsLayout` reads once the section has rendered. */
export const SETTINGS_FOCUS_PARAM = "focus";

export const SETTINGS_ANCHOR_PREFIX = "setting-";

export const SETTINGS_DESTINATIONS = {
  compaction: { section: "general", anchor: "compaction" },
  webTools: { section: "general", anchor: "web-tools" },
  webSearchLimit: { section: "general", anchor: "web-search-limit" },
  providers: { section: "providers" },
  account: { section: "account" },
  memory: { section: "memory" },
  keyboard: { section: "keyboard" },
  email: { section: "email" },
  voice: { section: "voice" },
  mcp: { section: "mcp" },
} as const satisfies Record<string, SettingsDestination>;

export type SettingsDestinationId = keyof typeof SETTINGS_DESTINATIONS;

export const settingsHref = (id: SettingsDestinationId): string => {
  const destination: SettingsDestination = SETTINGS_DESTINATIONS[id];
  const query = destination.anchor ? `?${SETTINGS_FOCUS_PARAM}=${encodeURIComponent(destination.anchor)}` : "";
  return `/settings/${destination.section}${query}`;
};

/** Scrolls a settings row into view and focuses it, after the section's lazy content has mounted. */
export function focusSettingAnchor(anchor: string): boolean {
  const target = document.getElementById(`${SETTINGS_ANCHOR_PREFIX}${anchor}`);
  if (!target) return false;
  target.scrollIntoView({ block: "center" });
  target.focus({ preventScroll: true });
  return true;
}
