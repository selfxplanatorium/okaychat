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
  | "apiAccess"
  | "mcp"
  | "agents"
  | "projects"
  | "schedules"
  | "webhooks"
  | "usage"
  | "voice"
  | "appearance"
  | "keyboard"
  | "admin";

export interface SettingsDestination {
  section: SettingsSection;
  /** A row in the settings page, addressed by `id="setting-<anchor>"` and focused after the lazy page mounts. */
  anchor?: string;
  /** Fixed query state (e.g. which admin workspace tab a link opens). */
  query?: Readonly<Record<string, string>>;
}

/** Query values are omitted when null/empty so a clean destination stays a clean URL. */
export type SettingsQuery = Readonly<Record<string, string | null | undefined>>;

/** `focus` is the query key `SettingsLayout` reads once the section has rendered. */
export const SETTINGS_FOCUS_PARAM = "focus";

export const SETTINGS_ANCHOR_PREFIX = "setting-";

export const SETTINGS_DESTINATIONS = {
  videos: { section: "general", anchor: "video-generation" },
  compaction: { section: "general", anchor: "compaction" },
  notifications: { section: "general", anchor: "notifications" },
  channelActivity: { section: "general", anchor: "channel-activity" },
  webTools: { section: "general", anchor: "web-tools" },
  webSearchLimit: { section: "general", anchor: "web-search-limit" },
  providers: { section: "providers" },
  usage: { section: "usage" },
  apiAccess: { section: "apiAccess" },
  apiKeys: { section: "apiAccess", anchor: "api-keys" },
  apiUsage: { section: "apiAccess", anchor: "api-usage" },
  apiDocs: { section: "apiAccess", anchor: "api-docs" },
  account: { section: "account" },
  email: { section: "email" },
  memory: { section: "memory" },
  keyboard: { section: "keyboard" },
  voice: { section: "voice" },
  mcp: { section: "mcp" },
  agents: { section: "agents" },
  webhooks: { section: "webhooks" },
  webhookDeliveries: { section: "webhooks" },
  admin: { section: "admin" },
  /** The granular permissions workspace; `view` selects a section inside it. */
  permissions: { section: "admin", query: { view: "people" } },
} as const satisfies Record<string, SettingsDestination>;

export type SettingsDestinationId = keyof typeof SETTINGS_DESTINATIONS;

export const settingsHref = (id: SettingsDestinationId, query?: SettingsQuery): string => {
  const destination: SettingsDestination = SETTINGS_DESTINATIONS[id];
  const params = new URLSearchParams();
  if (destination.anchor) params.set(SETTINGS_FOCUS_PARAM, destination.anchor);
  for (const [key, value] of Object.entries({ ...destination.query, ...query })) {
    if (value !== null && value !== undefined && value !== "") params.set(key, value);
  }
  const entries = [...params];
  const suffix = entries.length ? `?${params.toString()}` : "";
  return `/settings/${destination.section}${suffix}`;
};

/** Every admin permissions link goes through here, so renamed query keys update in one place. */
export const permissionsHref = (query: SettingsQuery): string => settingsHref("permissions", query);

/** Scrolls a settings row into view and focuses it, after the section's lazy content has mounted. */
export function focusSettingAnchor(anchor: string): boolean {
  const target = document.getElementById(`${SETTINGS_ANCHOR_PREFIX}${anchor}`);
  if (!target) return false;
  target.scrollIntoView({ block: "center" });
  target.focus({ preventScroll: true });
  return true;
}
