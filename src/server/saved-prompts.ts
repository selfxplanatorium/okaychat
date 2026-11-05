import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  MAX_PROMPT_BODY,
  MAX_PROMPT_BODY_BYTES,
  MAX_PROMPT_NAME,
  MAX_PROMPT_VARIABLES,
  MAX_SAVED_PROMPTS,
  SAVED_PROMPT_BODY_LIMIT,
  checkSavedPromptWrite,
  type SavedPrompt,
  type SavedPromptProblem,
  type SavedPromptWrite,
} from "../shared/saved-prompts.js";
import type { AppEnv } from "./auth.js";
import { newId } from "./crypto.js";
import { db, tx } from "./db.js";
import { AppError, errorJson } from "./errors.js";
import { assertStorage } from "./quota.js";

// Personal saved prompts: private templates the user inserts into the composer. They are ordinary account
// text (no at-rest encryption promise beyond the volume), never sent to a model by themselves, and never
// logged. `threads.updated_at` is untouched here: editing a template is not chat activity.
// See docs/implementation/saved-prompts.md.

interface Row {
  id: string;
  name: string;
  shortcut: string;
  body: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

const COLUMNS = "id, name, shortcut, body, revision, created_at, updated_at";

const STALE = "This prompt changed in another tab or window. Reload it before saving.";
const DUPLICATE = "Another saved prompt already uses this shortcut.";

/** A plain English message per rule, because these strings are shown to the user as the field error. */
const PROBLEMS: Record<SavedPromptProblem, string> = {
  nameRequired: "Give the prompt a name.",
  nameTooLong: `A name can hold at most ${MAX_PROMPT_NAME} characters.`,
  invalidShortcut: "Use a lowercase letter first, then letters, digits, or hyphens (up to 32).",
  bodyRequired: "Write the prompt text.",
  bodyTooLong: `The prompt can hold at most ${MAX_PROMPT_BODY} characters and ${MAX_PROMPT_BODY_BYTES / 1024} KiB.`,
  tooManyVariables: `A prompt can use at most ${MAX_PROMPT_VARIABLES} variables.`,
};

const invalid = (message: string) => new AppError({ code: "validation", message });
const conflict = (message: string, details?: Record<string, unknown>) => new AppError({ code: "conflict", message, details });
const notFound = () => new AppError({ code: "not_found", message: "Saved prompt not found" });

const toDto = (row: Row): SavedPrompt => ({
  id: row.id,
  name: row.name,
  shortcut: row.shortcut,
  body: row.body,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** What the quota counts for one prompt: UTF-8 bytes of its stored text columns. */
const promptBytes = (write: SavedPromptWrite) =>
  Buffer.byteLength(write.name) + Buffer.byteLength(write.shortcut) + Buffer.byteLength(write.body);

/** Trimmed name, normalized shortcut, body as typed, or the first rule it breaks. */
function checked(write: SavedPromptWrite): SavedPromptWrite {
  const result = checkSavedPromptWrite(write);
  if (!result.ok) throw invalid(PROBLEMS[result.problem]);
  return result.value;
}

/** `shortcut` compares through the column's NOCASE collation, so case never creates a second row. */
function shortcutTaken(userId: string, shortcut: string, exceptId?: string): boolean {
  const row = exceptId
    ? db.prepare("SELECT 1 FROM saved_prompts WHERE user_id = ? AND shortcut = ? AND id <> ?").get(userId, shortcut, exceptId)
    : db.prepare("SELECT 1 FROM saved_prompts WHERE user_id = ? AND shortcut = ?").get(userId, shortcut);
  return row !== undefined;
}

/** The user's row, or a 404 that is identical for a foreign and an absent id. */
function ownedRow(userId: string, id: string): Row {
  const row = db.prepare(`SELECT ${COLUMNS} FROM saved_prompts WHERE id = ? AND user_id = ?`).get(id, userId) as Row | undefined;
  if (!row) throw notFound();
  return row;
}

export function listSavedPrompts(userId: string): SavedPrompt[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM saved_prompts WHERE user_id = ? ORDER BY name COLLATE NOCASE, id LIMIT ?`)
    .all(userId, MAX_SAVED_PROMPTS) as unknown as Row[];
  return rows.map(toDto);
}

export function createSavedPrompt(userId: string, write: SavedPromptWrite): SavedPrompt {
  const value = checked(write);
  return tx(() => {
    const count = (db.prepare("SELECT COUNT(*) AS n FROM saved_prompts WHERE user_id = ?").get(userId) as { n: number }).n;
    if (count >= MAX_SAVED_PROMPTS) throw conflict(`You can save up to ${MAX_SAVED_PROMPTS} prompts.`);
    if (shortcutTaken(userId, value.shortcut)) throw conflict(DUPLICATE, { shortcut: value.shortcut });
    assertStorage(userId, promptBytes(value));
    const now = Date.now();
    const id = newId("sp");
    db.prepare("INSERT INTO saved_prompts (id, user_id, name, shortcut, body, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      userId,
      value.name,
      value.shortcut,
      value.body,
      1,
      now,
      now,
    );
    return { id, ...value, revision: 1, createdAt: now, updatedAt: now };
  });
}

export function updateSavedPrompt(userId: string, id: string, write: SavedPromptWrite & { revision: number }): SavedPrompt {
  const value = checked(write);
  return tx(() => {
    const row = ownedRow(userId, id);
    if (row.revision !== write.revision) throw conflict(STALE, { reason: "stale" });
    if (shortcutTaken(userId, value.shortcut, id)) throw conflict(DUPLICATE, { shortcut: value.shortcut });
    // A shrink is always allowed; assertStorage only refuses positive growth.
    assertStorage(userId, promptBytes(value) - promptBytes(row));
    const now = Date.now();
    // The revision predicate makes the write conditional even though the transaction already read the row.
    const result = db
      .prepare("UPDATE saved_prompts SET name = ?, shortcut = ?, body = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND user_id = ? AND revision = ?")
      .run(value.name, value.shortcut, value.body, now, id, userId, write.revision);
    if (Number(result.changes) === 0) throw conflict(STALE, { reason: "stale" });
    return { id, ...value, revision: row.revision + 1, createdAt: row.created_at, updatedAt: now };
  });
}

export function deleteSavedPrompt(userId: string, id: string, revision: number): void {
  tx(() => {
    const row = ownedRow(userId, id);
    if (row.revision !== revision) throw conflict(STALE, { reason: "stale" });
    // Deleting frees bytes, so it works while the account is over its quota.
    db.prepare("DELETE FROM saved_prompts WHERE id = ? AND user_id = ? AND revision = ?").run(id, userId, revision);
  });
}

// Coarse guards only: `checkSavedPromptWrite` applies the real code-point and byte limits. UTF-16 lengths can
// be at most twice the code-point count, so these caps never reject a value the real rules accept.
const writeInput = z
  .object({
    name: z.string().max(MAX_PROMPT_NAME * 2),
    shortcut: z.string().max(64),
    body: z.string().max(MAX_PROMPT_BODY * 2),
  })
  .strict();

const revisionInput = z.number().int().positive();

const updateInput = writeInput.extend({ revision: revisionInput }).strict();
const deleteInput = z.object({ revision: revisionInput }).strict();

const firstIssue = (error: z.ZodError) => error.issues[0]?.message ?? "Invalid saved prompt";

const writeTooLarge = (c: Context) => errorJson(c, invalid("The prompt is too large."));

export const savedPromptRoutes = new Hono<AppEnv>()
  // Prompt text is private per account, so no shared cache may keep a copy of a success or an error.
  .use(async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
  })
  .get("/", (c) => c.json({ prompts: listSavedPrompts(c.get("user").id) }))
  .post("/", bodyLimit({ maxSize: SAVED_PROMPT_BODY_LIMIT, onError: writeTooLarge }), async (c) => {
    const parsed = writeInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw invalid(firstIssue(parsed.error));
    return c.json(createSavedPrompt(c.get("user").id, parsed.data), 201);
  })
  .put("/:id", bodyLimit({ maxSize: SAVED_PROMPT_BODY_LIMIT, onError: writeTooLarge }), async (c) => {
    const parsed = updateInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw invalid(firstIssue(parsed.error));
    return c.json(updateSavedPrompt(c.get("user").id, c.req.param("id"), parsed.data));
  })
  .delete(
    "/:id",
    bodyLimit({ maxSize: 1024, onError: (c) => errorJson(c, invalid("The request is too large.")) }),
    async (c) => {
      const parsed = deleteInput.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw invalid(firstIssue(parsed.error));
      deleteSavedPrompt(c.get("user").id, c.req.param("id"), parsed.data.revision);
      return c.json({ ok: true });
    },
  );
