import { REASONING_EFFORTS } from "../shared/reasoning.js";
import { imageServiceDef } from "../shared/image-services.js";
import { DEFAULT_USER_SETTINGS, SIDEBAR_ITEMS, type UserSettings } from "../shared/types.js";
import { HTTPException } from "hono/http-exception";
import { db } from "./db.js";
import { validSpeechSettings } from "./speech/config.js";

export function getSettings(userId: string): UserSettings {
  const row = db.prepare("SELECT json FROM user_settings WHERE user_id = ?").get(userId) as { json: string } | undefined;
  const settings = { ...DEFAULT_USER_SETTINGS, ...(row ? (JSON.parse(row.json) as Partial<UserSettings>) : {}) };
  // Older clients could persist arbitrary values through the generic settings endpoint.
  for (const [key, min] of [["maxSteps", 1], ["maxSearches", 0]] as const) {
    if (!validLimit(settings[key], min)) settings[key] = DEFAULT_USER_SETTINGS[key];
  }
  if (!REASONING_EFFORTS.includes(settings.defaultReasoningEffort)) settings.defaultReasoningEffort = DEFAULT_USER_SETTINGS.defaultReasoningEffort;
  if (settings.sidebarItems !== undefined && !validSidebarItems(settings.sidebarItems)) delete settings.sidebarItems;
  // A saved list from before team channels gets the new item once; removing it later is not undone.
  if (settings.sidebarItems !== undefined && settings.sidebarChannelsSeen !== true) {
    settings.sidebarItems = [...settings.sidebarItems, ...(settings.sidebarItems.includes("channels") ? [] : (["channels"] as const))];
    settings.sidebarChannelsSeen = true;
    db.prepare(
      "INSERT INTO user_settings (user_id, json) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET json = excluded.json",
    ).run(userId, JSON.stringify(settings));
  }
  if (settings.imageServices !== undefined && !validImageServices(settings.imageServices)) delete settings.imageServices;
  if (settings.speech !== undefined && !validSpeechSettings(settings.speech)) delete settings.speech;
  if (settings.notifications !== undefined && !validNotificationSettings(settings.notifications)) delete settings.notifications;
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
  if (Object.hasOwn(patch, "imageServices") && !validImageServices(patch.imageServices)) {
    throw new HTTPException(400, { message: "imageServices must map known image services to { enabled, model }" });
  }
  if (Object.hasOwn(patch, "speech") && !validSpeechSettings(patch.speech)) {
    throw new HTTPException(400, { message: "speech has an unknown engine or value" });
  }
  if (Object.hasOwn(patch, "defaultReasoningEffort") && !REASONING_EFFORTS.includes(patch.defaultReasoningEffort!)) {
    throw new HTTPException(400, { message: "defaultReasoningEffort must be a known reasoning level" });
  }
  if (Object.hasOwn(patch, "notifications") && !validNotificationSettings(patch.notifications)) {
    throw new HTTPException(400, { message: "notifications must set browser and scheduleSuccess to true or false" });
  }
  const current = getSettings(userId);
  const next = { ...current, ...patch, instructionsRevision: current.instructionsRevision };
  // Personal instructions share one revision with per-model rules (prompt-policy.ts) for compare-and-set.
  if (Object.hasOwn(patch, "systemPrompt") && patch.systemPrompt !== current.systemPrompt) next.instructionsRevision = (current.instructionsRevision ?? 0) + 1;
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

function validNotificationSettings(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { browser, scheduleSuccess, ...rest } = value as { browser?: unknown; scheduleSuccess?: unknown };
  return Object.keys(rest).length === 0 && typeof browser === "boolean" && typeof scheduleSuccess === "boolean";
}

function validImageServices(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([id, entry]) => {
    if (!imageServiceDef(id) || !entry || typeof entry !== "object") return false;
    const { enabled, model, ...rest } = entry as { enabled?: unknown; model?: unknown };
    return Object.keys(rest).length === 0
      && (enabled === undefined || typeof enabled === "boolean")
      && (model === undefined || (typeof model === "string" && model.length > 0 && model.length <= 200));
  });
}
