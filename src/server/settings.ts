import { DEFAULT_USER_SETTINGS, SIDEBAR_ITEMS, type UserSettings } from "../shared/types.js";
import { HTTPException } from "hono/http-exception";
import { db } from "./db.js";

export function getSettings(userId: string): UserSettings {
  const row = db.prepare("SELECT json FROM user_settings WHERE user_id = ?").get(userId) as { json: string } | undefined;
  const settings = { ...DEFAULT_USER_SETTINGS, ...(row ? (JSON.parse(row.json) as Partial<UserSettings>) : {}) };
  // Older clients could persist arbitrary values through the generic settings endpoint.
  for (const [key, min] of [["maxSteps", 1], ["maxSearches", 0]] as const) {
    if (!validLimit(settings[key], min)) settings[key] = DEFAULT_USER_SETTINGS[key];
  }
  if (settings.sidebarItems !== undefined && !validSidebarItems(settings.sidebarItems)) delete settings.sidebarItems;
  return settings;
}

export function updateSettings(userId: string, patch: Partial<UserSettings>): UserSettings {
  for (const [key, min] of [["maxSteps", 1], ["maxSearches", 0]] as const) {
    if (Object.hasOwn(patch, key) && !validLimit(patch[key], min)) {
      throw new HTTPException(400, { message: `${key} must be an integer between ${min} and 50` });
    }
  }
  if (Object.hasOwn(patch, "sidebarItems") && !validSidebarItems(patch.sidebarItems)) {
    throw new HTTPException(400, { message: "sidebarItems must contain unique sidebar shortcut names" });
  }
  const next = { ...getSettings(userId), ...patch };
  db.prepare(
    "INSERT INTO user_settings (user_id, json) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET json = excluded.json",
  ).run(userId, JSON.stringify(next));
  return next;
}

function validLimit(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= 50;
}

/** Preferred delegate first; the utility and chat models remain available alternatives. */
export function subagentModelRefs(settings: UserSettings, chatModel: string): string[] {
  const preferred = settings.subagentModel === "chat" ? chatModel : settings.subagentModel;
  return [...new Set([preferred, settings.utilityModel, chatModel].filter((ref): ref is string => !!ref))];
}

function validSidebarItems(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => SIDEBAR_ITEMS.includes(item)) && new Set(value).size === value.length;
}
