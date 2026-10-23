import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { UIMessage } from "ai";
import { Hono } from "hono";
import type { ArtifactToolResult, DocumentArtifactKind, SharedPart, SharedThread } from "../shared/types.js";
import { artifactData, artifactVersions, DOCUMENT_MIME, documentFilename } from "./artifacts.js";
import { previewXlsx } from "./documents/xlsx.js";
import type { AppEnv } from "./auth.js";
import { randomToken } from "./crypto.js";
import { db } from "./db.js";
import { env } from "./env.js";
import { currentBranch, getThread } from "./threads.js";

// Read-only public links. A link is live: it shows the thread's current branch, and revoking deletes it.
// Only text, generated images, and artifacts are exposed. Reasoning, tool inputs, usage, and costs stay private.

interface ShareRow {
  token: string;
  user_id: string;
  thread_id: string;
}

const byThread = (userId: string, threadId: string) =>
  db.prepare("SELECT token FROM shares WHERE user_id = ? AND thread_id = ?").get(userId, threadId) as { token: string } | undefined;
const byToken = (token: string) => db.prepare("SELECT * FROM shares WHERE token = ?").get(token) as ShareRow | undefined;

const toolName = (part: { type: string; toolName?: string }) => part.toolName ?? part.type.replace(/^tool-/, "");

const ARTIFACT_TOOLS = new Set(["create_artifact", "update_artifact", "create_document", "edit_document", "import_document"]);

function sharedParts(message: UIMessage, token: string): SharedPart[] {
  const out: SharedPart[] = [];
  for (const raw of message.parts) {
    const part = raw as { type: string; text?: string; mediaType?: string; url?: string; state?: string; output?: unknown; toolName?: string };
    if (part.type === "text" && part.text?.trim()) out.push({ type: "text", text: part.text });
    else if (part.type === "file" && part.mediaType?.startsWith("image/") && part.url?.startsWith("data:")) out.push({ type: "image", url: part.url });
    else if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
      const name = toolName(part);
      const output = part.state === "output-available" ? part.output : undefined;
      if (name === "generate_image" && (output as { id?: string })?.id) {
        out.push({ type: "image", url: `/api/public/shares/${token}/images/${(output as { id: string }).id}` });
      } else if (ARTIFACT_TOOLS.has(name) && (output as ArtifactToolResult)?.id) {
        const a = output as ArtifactToolResult;
        out.push({ type: "artifact", id: a.id, title: a.title, kind: a.kind, version: a.version });
      } else out.push({ type: "tool", name });
    }
  }
  return out;
}

export const shareRoutes = new Hono<AppEnv>()
  .get("/threads/:id/share", (c) => {
    const row = byThread(c.get("user").id, c.req.param("id"));
    return c.json({ token: row?.token ?? null });
  })
  .post("/threads/:id/share", (c) => {
    const user = c.get("user");
    const thread = getThread(user.id, c.req.param("id"));
    if (!thread) return c.json({ error: "Not found" }, 404);
    const existing = byThread(user.id, thread.id);
    if (existing) return c.json({ token: existing.token });
    const token = randomToken();
    db.prepare("INSERT INTO shares (token, user_id, thread_id, created_at) VALUES (?, ?, ?, ?)").run(token, user.id, thread.id, Date.now());
    return c.json({ token });
  })
  .delete("/threads/:id/share", (c) => {
    db.prepare("DELETE FROM shares WHERE user_id = ? AND thread_id = ?").run(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  });

/** No login. The token is the only key. */
export const publicShareRoutes = new Hono()
  .get("/:token", (c) => {
    const share = byToken(c.req.param("token"));
    const thread = share && getThread(share.user_id, share.thread_id);
    if (!share || !thread) return c.json({ error: "This link was revoked or never existed." }, 404);
    const body: SharedThread = {
      title: thread.title,
      createdAt: thread.createdAt,
      messages: currentBranch(share.user_id, share.thread_id)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ id: m.id, role: m.role as "user" | "assistant", parts: sharedParts(m, share.token) }))
        .filter((m) => m.parts.length > 0),
    };
    return c.json(body);
  })
  .get("/:token/artifacts/:id", (c) => {
    const share = byToken(c.req.param("token"));
    if (!share) return c.json({ error: "Not found" }, 404);
    const versions = artifactVersions(share.thread_id, c.req.param("id"));
    return versions.length ? c.json(versions) : c.json({ error: "Not found" }, 404);
  })
  .get("/:token/artifacts/:id/file", (c) => {
    const share = byToken(c.req.param("token"));
    if (!share) return c.json({ error: "Not found" }, 404);
    const id = c.req.param("id");
    const version = c.req.query("version") ? Number(c.req.query("version")) : undefined;
    const data = artifactData(share.thread_id, id, version);
    const versions = artifactVersions(share.thread_id, id);
    const chosen = version === undefined ? versions.at(-1) : versions.find((v) => v.version === version);
    if (!data || !chosen) return c.json({ error: "Not found" }, 404);
    const kind = chosen.kind as DocumentArtifactKind;
    return new Response(data as unknown as BodyInit, {
      headers: {
        "Content-Type": DOCUMENT_MIME[kind],
        "Content-Disposition": `inline; filename="${documentFilename(chosen.title, kind)}"`,
        "Cache-Control": "public, max-age=60",
      },
    });
  })
  .get("/:token/artifacts/:id/preview", async (c) => {
    const share = byToken(c.req.param("token"));
    if (!share) return c.json({ error: "Not found" }, 404);
    const id = c.req.param("id");
    const version = c.req.query("version") ? Number(c.req.query("version")) : undefined;
    const data = artifactData(share.thread_id, id, version);
    const artifact = artifactVersions(share.thread_id, id).at(-1);
    if (!data || !artifact) return c.json({ error: "Not found" }, 404);
    if (artifact.kind !== "xlsx") return c.json({ error: "Preview is only available for spreadsheets" }, 400);
    return c.json(await previewXlsx(data));
  })
  .get("/:token/images/:id", (c) => {
    const share = byToken(c.req.param("token"));
    // The image must have been generated in the shared thread, not just by the same user.
    const image = share && (db.prepare("SELECT id, mime FROM images WHERE id = ? AND user_id = ? AND thread_id = ?").get(c.req.param("id"), share.user_id, share.thread_id) as { id: string; mime: string } | undefined);
    if (!share || !image) return c.json({ error: "Not found" }, 404);
    const stream = Readable.toWeb(createReadStream(path.join(env.dataDir, "images", share.user_id, `${image.id}.png`))) as ReadableStream;
    return new Response(stream, { headers: { "Content-Type": image.mime, "Cache-Control": "public, max-age=3600" } });
  });
