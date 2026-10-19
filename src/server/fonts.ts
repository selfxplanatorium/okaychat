import { Hono } from "hono";
import type { InstalledFont } from "../shared/types.js";
import type { AppEnv } from "./auth.js";
import { newId } from "./crypto.js";
import { db } from "./db.js";

// Fonts a user uploads. Files live in SQLite so they travel with the account and the one volume.
export const MAX_FONT_BYTES = 15 * 1024 * 1024;
const MAX_FAMILY_CHARS = 80;

/** Identifies the font by its file signature, not by the name the browser sent. */
export function sniffFont(bytes: Uint8Array): string | null {
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  if (tag === "wOF2") return "font/woff2";
  if (tag === "wOFF") return "font/woff";
  if (tag === "OTTO") return "font/otf";
  if (tag === "true" || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return "font/ttf";
  return null;
}

/** The family name is the file name without its extension. Quotes and CSS syntax are stripped. */
export function familyFromFilename(filename: string): string {
  return filename
    .replace(/\.(woff2?|ttf|otf)$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/["'\\<>;{}()]/g, "")
    .trim()
    .slice(0, MAX_FAMILY_CHARS)
    .trim();
}

function listFonts(userId: string): InstalledFont[] {
  const rows = db
    .prepare("SELECT id, family, filename, length(data) AS bytes FROM user_fonts WHERE user_id = ? ORDER BY family COLLATE NOCASE")
    .all(userId) as Array<{ id: string; family: string; filename: string; bytes: number }>;
  return rows;
}

export const fontRoutes = new Hono<AppEnv>()
  .get("/fonts", (c) => c.json(listFonts(c.get("user").id)))
  .post("/fonts", async (c) => {
    const userId = c.get("user").id;
    const file = (await c.req.formData()).get("file");
    if (!(file instanceof File)) return c.json({ error: "No file" }, 400);
    if (file.size > MAX_FONT_BYTES) return c.json({ error: "Font files are limited to 15 MB" }, 413);
    const data = new Uint8Array(await file.arrayBuffer());
    const mime = sniffFont(data);
    if (mime === null) return c.json({ error: `${file.name} is not a WOFF, WOFF2, TTF, or OTF font` }, 422);
    const family = familyFromFilename(file.name);
    if (family === "") return c.json({ error: "Name the font file, not just its extension" }, 400);
    if (db.prepare("SELECT 1 FROM user_fonts WHERE user_id = ? AND family = ?").get(userId, family)) {
      return c.json({ error: `A font named ${family} is already installed` }, 409);
    }
    const id = newId("fnt");
    db.prepare("INSERT INTO user_fonts (id, user_id, family, filename, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      id,
      userId,
      family,
      file.name,
      mime,
      data,
      Date.now(),
    );
    return c.json({ id, family, filename: file.name, bytes: data.byteLength }, 201);
  })
  .get("/fonts/:id/file", (c) => {
    const row = db
      .prepare("SELECT mime, data FROM user_fonts WHERE id = ? AND user_id = ?")
      .get(c.req.param("id"), c.get("user").id) as { mime: string; data: Uint8Array } | undefined;
    if (!row) return c.json({ error: "Not found" }, 404);
    // Ids are random and never reused, so a given URL always returns the same bytes.
    return c.body(new Uint8Array(row.data), 200,{ "Content-Type": row.mime, "Cache-Control": "private, max-age=31536000, immutable" });
  })
  .delete("/fonts/:id", (c) => {
    db.prepare("DELETE FROM user_fonts WHERE id = ? AND user_id = ?").run(c.req.param("id"), c.get("user").id);
    return c.json(listFonts(c.get("user").id));
  });
