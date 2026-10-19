import { DEFAULT_USER_SETTINGS, type UserSettings } from "../shared/types.js";
import { db } from "./db.js";

export function getSettings(userId: string): UserSettings {
  const row = db.prepare("SELECT json FROM user_settings WHERE user_id = ?").get(userId) as { json: string } | undefined;
  return { ...DEFAULT_USER_SETTINGS, ...(row ? (JSON.parse(row.json) as Partial<UserSettings>) : {}) };
}

export function updateSettings(userId: string, patch: Partial<UserSettings>): UserSettings {
  const next = { ...getSettings(userId), ...patch };
  db.prepare(
    "INSERT INTO user_settings (user_id, json) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET json = excluded.json",
  ).run(userId, JSON.stringify(next));
  return next;
}
