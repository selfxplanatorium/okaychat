import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type {
  AssistantPreset,
  AssistantSnapshot,
  PresetConfig,
  PresetInput,
  PresetOptions,
  PresetVisibility,
  ThreadAssistant,
} from "../shared/assistant-presets.js";
import {
  ASSISTANT_ICONS,
  DEFAULT_ASSISTANT_ICON,
  MAX_PRESET_CONFIG_BYTES,
  MAX_PRESETS_PER_ACCOUNT,
  PUBLISHED_PAGE_CAP,
  PUBLISHED_PAGE_SIZE,
  publishabilityError,
  snapshotOf,
  validatePresetConfig,
  validatePresetInput,
} from "../shared/assistant-presets.js";
import type { ThreadAssistantSummary, ThreadSummary } from "../shared/types.js";
import type { AppEnv } from "./auth.js";
import { accessibleCollections } from "./knowledge/store.js";
import { listModels } from "./catalog/providers.js";
import { newId } from "./crypto.js";
import { db, tx } from "./db.js";
import { AppError } from "./errors.js";
import { serverInfo } from "./mcp/manager.js";
import { visibleServers } from "./mcp/store.js";
import { featureAllowed } from "./permissions/guard.js";
import { assertStorage } from "./quota.js";
import { getSettings } from "./settings.js";
import { getThread } from "./threads.js";
import { threadBusy } from "./thread-runs.js";

/**
 * Named assistant presets. A library row is private by default; publishing exposes the full body to
 * signed-in users (they must read instructions before copying), but selecting always copies a snapshot
 * into the chat, so later edits or deletion cannot change an existing conversation.
 */

interface PresetRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  icon: string;
  config_json: string;
  visibility: PresetVisibility;
  revision: number;
  created_at: number;
  updated_at: number;
  owner_name: string | null;
}

const SELECT_PRESET = `SELECT p.*, u.name AS owner_name FROM assistant_presets p JOIN users u ON u.id = p.user_id`;

const presetBytes = (name: string, description: string, configJson: string) =>
  Buffer.byteLength(name) + Buffer.byteLength(description) + Buffer.byteLength(configJson);

function parseConfig(row: PresetRow): PresetConfig {
  try {
    const parsed = validatePresetConfig(JSON.parse(row.config_json) as unknown);
    if (parsed.ok) return parsed.value;
  } catch {
    // A corrupt row must not break the picker; it degrades to an empty assistant.
  }
  return { modelRef: null, instructions: "", sampling: {}, tools: { mode: "inherit", builtins: [], mcpTools: [] }, knowledge: { mode: "inherit", ids: [] } };
}

function toPreset(row: PresetRow, userId: string): AssistantPreset {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: (ASSISTANT_ICONS as readonly string[]).includes(row.icon) ? (row.icon as AssistantPreset["icon"]) : DEFAULT_ASSISTANT_ICON,
    config: parseConfig(row),
    visibility: row.visibility,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    owner: { id: row.user_id, name: row.owner_name ?? "" },
    owned: row.user_id === userId,
  };
}

interface Cursor {
  updatedAt: number;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.updatedAt}:${cursor.id}`, "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): Cursor | null | "invalid" {
  if (!value) return null;
  try {
    const text = Buffer.from(value, "base64url").toString("utf8");
    const match = /^(\d{1,16}):([A-Za-z0-9_-]{1,200})$/.exec(text);
    if (!match) return "invalid";
    return { updatedAt: Number(match[1]), id: match[2]! };
  } catch {
    return "invalid";
  }
}

export function listPresets(userId: string, scope: "mine" | "published", cursorRaw?: string): { items: AssistantPreset[]; nextCursor: string | null } {
  const cursor = decodeCursor(cursorRaw);
  if (cursor === "invalid") throw new AppError({ code: "validation", message: "Invalid page cursor." });
  const where = [scope === "mine" ? "p.user_id = ?" : "p.visibility = 'published'"];
  const values: Array<string | number> = scope === "mine" ? [userId] : [];
  if (cursor) {
    where.push("(p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))");
    values.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }
  const limit = scope === "mine" ? MAX_PRESETS_PER_ACCOUNT : PUBLISHED_PAGE_SIZE;
  const rows = db
    .prepare(`${SELECT_PRESET} WHERE ${where.join(" AND ")} ORDER BY p.updated_at DESC, p.id DESC LIMIT ?`)
    .all(...values, limit + 1) as unknown as PresetRow[];
  const page = rows.slice(0, limit);
  const next = rows.length > limit && page.length ? encodeCursor({ updatedAt: page.at(-1)!.updated_at, id: page.at(-1)!.id }) : null;
  return { items: page.map((row) => toPreset(row, userId)), nextCursor: next };
}

/** Own row or a currently published one; a foreign private id answers exactly like a missing one. */
export function getPreset(userId: string, id: string): AssistantPreset | null {
  const row = db.prepare(`${SELECT_PRESET} WHERE p.id = ? AND (p.user_id = ? OR p.visibility = 'published')`).get(id, userId) as unknown as PresetRow | undefined;
  return row ? toPreset(row, userId) : null;
}

function ownedRow(userId: string, id: string): PresetRow | undefined {
  return db.prepare(`${SELECT_PRESET} WHERE p.id = ? AND p.user_id = ?`).get(id, userId) as unknown as PresetRow | undefined;
}

export function createPreset(userId: string, input: PresetInput): AssistantPreset {
  const parsed = validatePresetInput(input);
  if (!parsed.ok) throw new AppError({ code: "validation", message: parsed.message });
  const { name, description, icon, config, visibility } = parsed.value;
  if (visibility === "published") {
    const blocked = publishabilityError(config);
    if (blocked) throw new AppError({ code: "validation", message: blocked });
  }
  const count = (db.prepare("SELECT COUNT(*) AS n FROM assistant_presets WHERE user_id = ?").get(userId) as { n: number }).n;
  if (count >= MAX_PRESETS_PER_ACCOUNT) throw new AppError({ code: "validation", message: `You can keep up to ${MAX_PRESETS_PER_ACCOUNT} assistants.` });
  const configJson = JSON.stringify(config);
  assertStorage(userId, presetBytes(name, description, configJson));
  const id = newId("preset");
  const now = Date.now();
  db.prepare(
    `INSERT INTO assistant_presets (id, user_id, name, description, icon, config_json, visibility, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, userId, name, description, icon, configJson, visibility, now, now);
  return getPreset(userId, id)!;
}

export function updatePreset(userId: string, id: string, input: PresetInput, expectedRevision: number): AssistantPreset {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new AppError({ code: "validation", message: "Choose the version you edited." });
  const parsed = validatePresetInput(input);
  if (!parsed.ok) throw new AppError({ code: "validation", message: parsed.message });
  const { name, description, icon, config, visibility } = parsed.value;
  if (visibility === "published") {
    const blocked = publishabilityError(config);
    if (blocked) throw new AppError({ code: "validation", message: blocked });
  }
  return tx(() => {
    const row = ownedRow(userId, id);
    if (!row) throw new AppError({ code: "not_found", message: "Assistant not found." });
    if (row.revision !== expectedRevision) throw new AppError({ code: "conflict", message: "This assistant changed elsewhere. Reload it to see the stored version." });
    const configJson = JSON.stringify(config);
    const before = presetBytes(row.name, row.description, row.config_json);
    const after = presetBytes(name, description, configJson);
    // Replacement writes charge only growth, so shrinking over quota is always possible.
    assertStorage(userId, after - before);
    db.prepare(
      `UPDATE assistant_presets SET name = ?, description = ?, icon = ?, config_json = ?, visibility = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND user_id = ? AND revision = ?`,
    ).run(name, description, icon, configJson, visibility, Date.now(), id, userId, expectedRevision);
    return getPreset(userId, id)!;
  });
}

export function deletePreset(userId: string, id: string, expectedRevision: number): void {
  const result = db.prepare("DELETE FROM assistant_presets WHERE id = ? AND user_id = ? AND revision = ?").run(id, userId, expectedRevision);
  if (!result.changes) {
    const exists = ownedRow(userId, id);
    if (!exists) throw new AppError({ code: "not_found", message: "Assistant not found." });
    throw new AppError({ code: "conflict", message: "This assistant changed elsewhere. Reload it first." });
  }
}

/** Whole-body copy for a "clone" action: the client POSTs this reviewed DTO back. */
export function cloneBody(preset: AssistantPreset): PresetInput {
  return { name: preset.name, description: preset.description, icon: preset.icon, config: preset.config, visibility: "private" };
}

export const MAX_PUBLISHED_PAGE_TRAVERSAL = PUBLISHED_PAGE_CAP;

// ---------------------------------------------------------------------------------------------------
// Builder options: what this account may actually grant. Never connects to a disabled MCP server.
// ---------------------------------------------------------------------------------------------------

const BUILTIN_OPTIONS: Array<{ id: string; labelKey: string; feature?: "webSearch" | "memory" | "knowledge" | "skills" | "email" | "artifacts" | "images" | "videos" | "code" | "generativeUI" | "delegation" | "research"; setting?: keyof ReturnType<typeof getSettings> }> = [
  { id: "web", labelKey: "assistants.familyWeb", feature: "webSearch", setting: "webTools" },
  { id: "memory", labelKey: "assistants.familyMemory", feature: "memory" },
  { id: "knowledge", labelKey: "assistants.familyKnowledge", feature: "knowledge" },
  { id: "skills", labelKey: "assistants.familySkills", feature: "skills" },
  { id: "email-read", labelKey: "assistants.familyEmailRead", feature: "email" },
  { id: "email-write", labelKey: "assistants.familyEmailWrite", feature: "email" },
  { id: "drafts", labelKey: "assistants.familyDrafts", feature: "email" },
  { id: "artifacts", labelKey: "assistants.familyArtifacts", feature: "artifacts", setting: "artifacts" },
  { id: "videos", labelKey: "assistants.familyVideos", feature: "videos" },
  { id: "images", labelKey: "assistants.familyImages", feature: "images" },
  { id: "code", labelKey: "assistants.familyCode", feature: "code", setting: "codeExecution" },
  { id: "widgets", labelKey: "assistants.familyWidgets", feature: "generativeUI", setting: "generativeUI" },
  { id: "delegate", labelKey: "assistants.familyDelegate", feature: "delegation", setting: "subagents" },
  { id: "research", labelKey: "assistants.familyResearch", feature: "research" },
  { id: "attachments", labelKey: "assistants.familyAttachments" },
];

export async function presetOptions(userId: string, threadId?: string): Promise<PresetOptions> {
  const settings = getSettings(userId);
  const models = await listModels(userId);
  const builtins = BUILTIN_OPTIONS.map((entry) => {
    const allowed = !entry.feature || featureAllowed(userId, entry.feature);
    const enabled = !entry.setting || settings[entry.setting] !== false;
    return allowed && enabled
      ? { id: entry.id, labelKey: entry.labelKey, available: true }
      : { id: entry.id, labelKey: entry.labelKey, available: false, reasonKey: "assistants.unavailable" };
  });
  const mcpAvailable = featureAllowed(userId, "mcp");
  const mcpTools: PresetOptions["mcpTools"] = [];
  if (mcpAvailable) {
    for (const record of visibleServers(userId)) {
      // Cached descriptors only: choosing tools for a preset never opens a connection or runs anything.
      const info = serverInfo(record);
      for (const tool of info.tools) {
        mcpTools.push({ serverId: record.id, serverName: record.name, toolName: tool.name, available: record.enabled && tool.enabled });
      }
    }
  }
  const thread = threadId ? getThread(userId, threadId) : null;
  const collections = accessibleCollections(userId, (thread?.knowledgeIds ?? []).concat(listAllCollectionIds(userId)), thread?.projectId ?? null).map((row) => ({
    id: row.id,
    name: row.name,
    available: true,
  }));
  const unique = new Map(collections.map((entry) => [entry.id, entry]));
  return { models, builtins, mcpTools, collections: [...unique.values()] };
}

function listAllCollectionIds(userId: string): string[] {
  const rows = db.prepare("SELECT id FROM knowledge_collections WHERE user_id = ? ORDER BY name COLLATE NOCASE, id").all(userId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------------------------------
// Thread snapshots
// ---------------------------------------------------------------------------------------------------

export function parseSnapshot(value: string | null): AssistantSnapshot | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as unknown;
    const config = validatePresetConfig(raw);
    if (!config.ok) return null;
    const record = raw as Record<string, unknown>;
    return {
      ...config.value,
      sourceId: typeof record.sourceId === "string" ? record.sourceId : "",
      sourceRevision: typeof record.sourceRevision === "number" ? record.sourceRevision : 0,
      name: typeof record.name === "string" ? record.name : "",
      icon: (ASSISTANT_ICONS as readonly string[]).includes(String(record.icon)) ? (record.icon as AssistantPreset["icon"]) : DEFAULT_ASSISTANT_ICON,
      origin: record.origin === "published" ? "published" : "private",
    };
  } catch {
    return null;
  }
}

export function threadAssistant(userId: string, threadId: string): ThreadAssistant {
  const row = db.prepare("SELECT assistant_json, assistant_revision FROM threads WHERE user_id = ? AND id = ?").get(userId, threadId) as
    | { assistant_json: string | null; assistant_revision: number }
    | undefined;
  if (!row) throw new AppError({ code: "not_found", message: "Thread not found." });
  return { snapshot: parseSnapshot(row.assistant_json), revision: row.assistant_revision };
}

export function assistantSummary(value: string | null): ThreadAssistantSummary | null {
  const snapshot = parseSnapshot(value);
  return snapshot ? { name: snapshot.name, icon: snapshot.icon, revision: snapshot.sourceRevision, modelRef: snapshot.modelRef } : null;
}

/** Snapshot replacement charges only growth; clearing always works, also over quota. */
function writeSnapshot(userId: string, threadId: string, snapshotJson: string | null, expectedRevision: number, modelRef?: string | null): ThreadAssistant {
  return tx(() => {
    const row = db.prepare("SELECT assistant_json, assistant_revision FROM threads WHERE user_id = ? AND id = ?").get(userId, threadId) as
      | { assistant_json: string | null; assistant_revision: number }
      | undefined;
    if (!row) throw new AppError({ code: "not_found", message: "Thread not found." });
    if (row.assistant_revision !== expectedRevision) throw new AppError({ code: "conflict", message: "This chat's assistant changed. Reload the chat." });
    const before = row.assistant_json ? Buffer.byteLength(row.assistant_json) : 0;
    const after = snapshotJson ? Buffer.byteLength(snapshotJson) : 0;
    assertStorage(userId, after - before);
    db.prepare("UPDATE threads SET assistant_json = ?, assistant_revision = assistant_revision + 1 WHERE id = ?").run(snapshotJson, threadId);
    // Applying a preset with a model sets the chat model; `null` keeps the current one. Never bumps activity.
    if (modelRef) db.prepare("UPDATE threads SET model_ref = ? WHERE id = ?").run(modelRef, threadId);
    return { snapshot: parseSnapshot(snapshotJson), revision: expectedRevision + 1 };
  });
}

export async function selectThreadAssistant(
  userId: string,
  threadId: string,
  expectedRevision: number,
  selection: { presetId: string; presetRevision: number } | null,
): Promise<ThreadAssistant> {
  if (!getThread(userId, threadId)) throw new AppError({ code: "not_found", message: "Thread not found." });
  if (selection === null) return writeSnapshot(userId, threadId, null, expectedRevision);
  const preset = getPreset(userId, selection.presetId);
  if (!preset) throw new AppError({ code: "not_found", message: "Assistant not found." });
  if (preset.revision !== selection.presetRevision) {
    throw new AppError({ code: "conflict", message: "This assistant changed. Review the new version before applying it." });
  }
  // The snapshot grants no entitlement: a model removed from this account cannot be applied.
  if (preset.config.modelRef) {
    const models = await listModels(userId);
    if (!models.some((model) => model.ref === preset.config.modelRef)) {
      throw new AppError({ code: "forbidden", message: "This assistant's model is not available for this account." });
    }
  }
  return writeSnapshot(userId, threadId, JSON.stringify(snapshotOf(preset)), expectedRevision, preset.config.modelRef);
}

/** Applies or clears the revision guard for a thread config change made through PATCH. */
export function assertAssistantRevision(userId: string, threadId: string, provided: number | undefined): number {
  const current = threadAssistant(userId, threadId);
  if (!current.snapshot && current.revision === 0) return current.revision;
  if (provided !== current.revision) {
    throw new AppError({ code: "conflict", message: "This chat's assistant changed. Reload the chat and try again." });
  }
  return current.revision + 1;
}

export function bumpAssistantRevision(threadId: string): void {
  db.prepare("UPDATE threads SET assistant_revision = assistant_revision + 1 WHERE id = ?").run(threadId);
}

/** Everything a turn needs to know about its assistant, before any provider request. */
export interface TurnAssistant {
  snapshot: AssistantSnapshot | null;
  revision: number;
  /** Temporary chats supply their own config; it is validated and always treated as untrusted. */
  temporary: boolean;
}

export function resolveAssistantForTurn(userId: string, threadId: string, temporaryConfig?: unknown): TurnAssistant {
  if (threadId.startsWith("tmp_")) {
    if (temporaryConfig === undefined || temporaryConfig === null) return { snapshot: null, revision: 0, temporary: true };
    const raw = temporaryConfig as Record<string, unknown>;
    const parsed = validatePresetConfig(raw);
    if (!parsed.ok) throw new AppError({ code: "validation", message: parsed.message });
    const name = typeof raw.name === "string" ? raw.name.slice(0, 80) : "";
    return {
      snapshot: {
        ...parsed.value,
        sourceId: "",
        sourceRevision: 0,
        name: name || "Assistant",
        icon: (ASSISTANT_ICONS as readonly string[]).includes(String(raw.icon)) ? (raw.icon as AssistantPreset["icon"]) : DEFAULT_ASSISTANT_ICON,
        // Supplied by the browser, so its instructions are always external data, never trusted input.
        origin: "published",
      },
      revision: 0,
      temporary: true,
    };
  }
  const thread = threadAssistant(userId, threadId);
  return { snapshot: thread.snapshot, revision: thread.revision, temporary: false };
}

/** The same shape a thread detail row exposes. */
export function detailAssistant(thread: ThreadSummary & { assistantJson?: string | null }): ThreadAssistantSummary | null {
  return assistantSummary(thread.assistantJson ?? null);
}

/** A missing or foreign preset is a 404, never a hint that someone else's row exists. */
export const presetNotFound = () => new HTTPException(404, { message: "Assistant not found" });

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------

const selectionBody = z.object({
  expectedRevision: z.number().int().min(0),
  selection: z
    .object({ presetId: z.string().min(1).max(200), presetRevision: z.number().int().min(1) })
    .nullable(),
});

const presetBody = z.object({ expectedRevision: z.number().int().min(1).optional() }).passthrough();

/** Mounted under the authenticated `/api` tree. Static `options` is registered before `:id`. */
export const assistantPresetRoutes = new Hono<AppEnv>()
  .get("/assistant-presets/options", async (c) => {
    const threadId = c.req.query("threadId");
    if (threadId && !getThread(c.get("user").id, threadId)) return c.json({ error: "Thread not found" }, 404);
    return c.json(await presetOptions(c.get("user").id, threadId));
  })
  .get("/assistant-presets", (c) => {
    const scope = c.req.query("scope") ?? "mine";
    if (scope !== "mine" && scope !== "published") return c.json({ error: "Invalid scope" }, 400);
    return c.json(listPresets(c.get("user").id, scope, c.req.query("cursor")));
  })
  .get("/assistant-presets/:id", (c) => {
    const preset = getPreset(c.get("user").id, c.req.param("id"));
    return preset ? c.json(preset) : c.json({ error: "Assistant not found" }, 404);
  })
  .post("/assistant-presets", async (c) => {
    const body = presetBody.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "Invalid assistant" }, 400);
    const preset = createPreset(c.get("user").id, body.data as unknown as PresetInput);
    return c.json(preset, 201);
  })
  .put("/assistant-presets/:id", async (c) => {
    const body = presetBody.safeParse(await c.req.json());
    if (!body.success || typeof body.data.expectedRevision !== "number") return c.json({ error: "Invalid assistant" }, 400);
    return c.json(updatePreset(c.get("user").id, c.req.param("id"), body.data as unknown as PresetInput, body.data.expectedRevision));
  })
  .delete("/assistant-presets/:id", async (c) => {
    const body = z.object({ expectedRevision: z.number().int().min(1) }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Choose the version to delete." }, 400);
    deletePreset(c.get("user").id, c.req.param("id"), body.data.expectedRevision);
    return c.json({ ok: true });
  })
  .get("/threads/:id/assistant", (c) => {
    const userId = c.get("user").id;
    if (!getThread(userId, c.req.param("id"))) return c.json({ error: "Thread not found" }, 404);
    return c.json(threadAssistant(userId, c.req.param("id")));
  })
  .put("/threads/:id/assistant", async (c) => {
    const userId = c.get("user").id;
    const threadId = c.req.param("id");
    const body = selectionBody.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "Invalid assistant selection" }, 400);
    if (!getThread(userId, threadId)) return c.json({ error: "Thread not found" }, 404);
    // Applying to a running turn (or one waiting for an approval) would change its frozen configuration.
    if (threadBusy(threadId)) throw new AppError({ code: "validation", message: "This chat is busy. Finish or stop the reply first." });
    return c.json(await selectThreadAssistant(userId, threadId, body.data.expectedRevision, body.data.selection));
  });
