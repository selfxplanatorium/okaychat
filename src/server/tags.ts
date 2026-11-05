import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./auth.js";
import { newId } from "./crypto.js";
import { db } from "./db.js";
import { AppError } from "./errors.js";
import {
  MAX_TAG_PRESETS,
  MAX_TAG_PRESET_NAME,
  parseTagFilter,
  type TagFilterPreset,
} from "../shared/tags.js";

/**
 * Tag metadata for the sidebar. Tag writes go through `PATCH /threads/:id` so a chat's ownership and
 * its hidden-comparison rule stay in one place. Tags are private metadata: never prompts, search, or
 * anything a share exports.
 */

interface PresetRow {
  id: string;
  name: string;
  filter_json: string;
  created_at: number;
  updated_at: number;
}

const toPreset = (row: PresetRow): TagFilterPreset => ({
  id: row.id,
  name: row.name,
  filter: parseTagFilter(JSON.parse(row.filter_json)) ?? { tags: [], match: "any" },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const presetBody = z.object({
  name: z.string().trim().min(1).max(MAX_TAG_PRESET_NAME),
  filter: z.unknown(),
});
const presetPatch = z.object({
  name: z.string().trim().min(1).max(MAX_TAG_PRESET_NAME).optional(),
  filter: z.unknown().optional(),
});

const ownedPreset = (userId: string, id: string) =>
  db.prepare("SELECT * FROM tag_filter_presets WHERE id = ? AND user_id = ?").get(id, userId) as PresetRow | undefined;

const duplicateName = () => new AppError({ code: "conflict", status: 409, message: "A filter with that name exists." });

export const tagRoutes = new Hono<AppEnv>()
  .get("/tags", (c) => {
    // Archives are out of the sidebar's way, and a hidden comparison pane never contributes a tag.
    const rows = db
      .prepare(
        `SELECT tt.tag AS tag, COUNT(*) AS count
           FROM thread_tags tt JOIN threads th ON th.id = tt.thread_id
          WHERE th.user_id = ? AND th.compare_group_id IS NULL AND th.status <> 'archived'
          GROUP BY tt.tag
          ORDER BY count DESC, tt.tag`,
      )
      .all(c.get("user").id) as Array<{ tag: string; count: number }>;
    return c.json({ tags: rows });
  })
  .get("/tag-filters", (c) => {
    const rows = db
      .prepare("SELECT * FROM tag_filter_presets WHERE user_id = ? ORDER BY updated_at DESC, id")
      .all(c.get("user").id) as unknown as PresetRow[];
    return c.json({ presets: rows.map(toPreset) });
  })
  .post("/tag-filters", async (c) => {
    const userId = c.get("user").id;
    const body = presetBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Enter a filter name of 1 to 40 characters." }, 400);
    const filter = parseTagFilter(body.data.filter);
    if (!filter) return c.json({ error: "Invalid tag filter" }, 400);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM tag_filter_presets WHERE user_id = ?").get(userId) as { n: number };
    if (n >= MAX_TAG_PRESETS) throw new AppError({ code: "conflict", status: 409, message: `You have the maximum of ${MAX_TAG_PRESETS} saved filters. Delete one first.` });
    const exists = db.prepare("SELECT 1 FROM tag_filter_presets WHERE user_id = ? AND name = ?").get(userId, body.data.name);
    if (exists) throw duplicateName();
    const id = newId("tfp");
    const now = Date.now();
    try {
      db.prepare("INSERT INTO tag_filter_presets (id, user_id, name, filter_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, userId, body.data.name, JSON.stringify(filter), now, now);
    } catch (error) {
      if (String((error as Error).message).includes("UNIQUE")) throw duplicateName();
      throw error;
    }
    return c.json({ preset: toPreset(ownedPreset(userId, id)!) }, 201);
  })
  .patch("/tag-filters/:id", async (c) => {
    const userId = c.get("user").id;
    const row = ownedPreset(userId, c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    const body = presetPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid filter" }, 400);
    if (body.data.name === undefined && body.data.filter === undefined) return c.json({ error: "Nothing to change" }, 400);
    const filter = body.data.filter === undefined ? undefined : parseTagFilter(body.data.filter);
    if (body.data.filter !== undefined && !filter) return c.json({ error: "Invalid tag filter" }, 400);
    if (body.data.name !== undefined && body.data.name !== row.name) {
      const exists = db.prepare("SELECT 1 FROM tag_filter_presets WHERE user_id = ? AND name = ?").get(userId, body.data.name);
      if (exists) throw duplicateName();
    }
    try {
      db.prepare("UPDATE tag_filter_presets SET name = ?, filter_json = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(
        body.data.name ?? row.name,
        filter ? JSON.stringify(filter) : row.filter_json,
        Date.now(),
        row.id,
        userId,
      );
    } catch (error) {
      if (String((error as Error).message).includes("UNIQUE")) throw duplicateName();
      throw error;
    }
    return c.json({ preset: toPreset(ownedPreset(userId, row.id)!) });
  })
  .delete("/tag-filters/:id", (c) => {
    db.prepare("DELETE FROM tag_filter_presets WHERE id = ? AND user_id = ?").run(c.req.param("id"), c.get("user").id);
    return c.json({ ok: true });
  });
