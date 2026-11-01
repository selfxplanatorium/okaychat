import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../auth.js";
import { db } from "../db.js";
import { deleteUpload, MAX_BYTES, storeUpload } from "../files.js";
import { excerpt } from "./chunker.js";
import { embeddingOptions } from "./embeddings.js";
import {
  cancelCollectionIngestion,
  cancelSourceIngestion,
  enqueueSource,
  enqueueSources,
} from "./jobs.js";
import { searchKnowledge } from "./retrieval.js";
import { fetchKnowledgeUrl } from "./url.js";
import {
  attachableCollections,
  chunkRow,
  createCollection,
  createSource,
  deleteCollection,
  deleteSource,
  getCollection,
  getCollectionRow,
  listCollections,
  KnowledgeInputError,
  listSources,
  requeueCollection,
  requeueSource,
  sourceRow,
  updateCollection,
} from "./store.js";

// Authenticated knowledge management. No model can call these: ingestion, edits, and deletes are a
// user action. Every route resolves ownership first, and a collection's project binding is checked
// when it is attached to a chat (see `knowledge/tools.ts`).

const MAX_TEXT = 400_000;
const embeddingInput = z.object({
  provider: z.enum(["none", "openai", "google", "ollama", "compatible"]),
  providerId: z.string().min(1).max(200).optional(),
  model: z.string().max(200).optional(),
});
const collectionInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  projectId: z.string().max(200).nullable().optional(),
  embedding: embeddingInput,
});
const collectionPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  projectId: z.string().max(200).nullable().optional(),
  embedding: embeddingInput.optional(),
});

/** Stores original bytes and creates the queued source. Rolls back the upload if the row fails. */
function addSource(userId: string, collectionId: string, input: { name: string; kind: "file" | "paste" | "url"; mime: string; data: Uint8Array; text?: string; url?: string }) {
  if (!getCollectionRow(userId, collectionId)) throw new HTTPException(404, { message: "Collection not found" });
  const uploadId = storeUpload(userId, input.name, input.mime, input.data);
  try {
    return createSource(userId, collectionId, {
      name: input.name,
      kind: input.kind,
      mime: input.mime,
      uploadId,
      bytes: input.data.byteLength,
      text: input.text,
      url: input.url,
    });
  } catch (error) {
    deleteUpload(userId, uploadId);
    throw error;
  }
}

const passageOf = (row: NonNullable<ReturnType<typeof chunkRow>>) => ({
  chunk: { id: row.id, sourceId: row.source_id, ordinal: row.ordinal, title: row.title || row.source_name, start: row.start, end: row.end, text: row.text, tokens: row.tokens },
  source: { id: row.source_id, name: row.source_name, kind: row.source_kind, url: row.source_url, collectionId: row.collection_id },
  collection: { id: row.collection_id, name: row.collection_name, projectId: row.project_id },
});

export const knowledgeRoutes = new Hono<AppEnv>()
  .use(bodyLimit({ maxSize: MAX_BYTES + 1024 * 1024 }))
  .use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  // Registered before `/collections/:id` so the literal path is not shadowed.
  .get("/embedding-options", async (c) => c.json({ options: await embeddingOptions(c.get("user").id) }))
  .get("/collections", (c) => {
    const project = c.req.query("project");
    const userId = c.get("user").id;
    const collections = project === undefined
      ? listCollections(userId)
      : attachableCollections(userId, project === "none" ? null : project);
    return c.json({ collections });
  })
  .post("/collections", async (c) => {
    const parsed = collectionInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid collection" }, 400);
    return c.json(createCollection(c.get("user").id, parsed.data));
  })
  .get("/collections/:id", (c) => {
    const userId = c.get("user").id;
    const collection = getCollection(userId, c.req.param("id"));
    if (!collection) return c.json({ error: "Collection not found" }, 404);
    return c.json({ collection, sources: listSources(userId, collection.id) });
  })
  .patch("/collections/:id", async (c) => {
    const parsed = collectionPatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid collection" }, 400);
    const userId = c.get("user").id;
    const result = updateCollection(userId, c.req.param("id"), parsed.data);
    if (result.reindex) {
      cancelCollectionIngestion(userId, result.collection.id);
      const sources = listSources(userId, result.collection.id);
      requeueCollection(userId, result.collection.id);
      enqueueSources(userId, sources.map((source) => source.id));
    }
    return c.json(result.collection);
  })
  .delete("/collections/:id", (c) => {
    const userId = c.get("user").id;
    cancelCollectionIngestion(userId, c.req.param("id"));
    if (!deleteCollection(userId, c.req.param("id"))) return c.json({ error: "Collection not found" }, 404);
    return c.json({ ok: true });
  })
  .post("/collections/:id/sources/file", async (c) => {
    const userId = c.get("user").id;
    const collectionId = c.req.param("id");
    if (!getCollectionRow(userId, collectionId)) return c.json({ error: "Collection not found" }, 404);
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "No file" }, 400);
    if (file.size > MAX_BYTES) return c.json({ error: "File is larger than 25 MB" }, 413);
    if (/^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|avif|bmp|tiff?)$/i.test(file.name)) {
      return c.json({ error: "Images are not supported yet: this build has no OCR for them. Add a text, PDF, DOCX, or spreadsheet file instead." }, 415);
    }
    const source = addSource(userId, collectionId, {
      name: file.name.slice(0, 200),
      kind: "file",
      mime: file.type || "application/octet-stream",
      data: new Uint8Array(await file.arrayBuffer()),
    });
    enqueueSource(userId, source.id);
    return c.json(source, 201);
  })
  .post("/collections/:id/sources/paste", async (c) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(200), text: z.string().min(1).max(MAX_TEXT) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: `Pasted text must be 1–${MAX_TEXT} characters with a name.` }, 400);
    const userId = c.get("user").id;
    const source = addSource(userId, c.req.param("id"), {
      name: parsed.data.name,
      kind: "paste",
      mime: "text/markdown",
      data: Buffer.from(parsed.data.text),
      text: parsed.data.text,
    });
    enqueueSource(userId, source.id);
    return c.json(source, 201);
  })
  .post("/collections/:id/sources/url", async (c) => {
    const parsed = z.object({ url: z.string().url().max(2000) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a valid http or https URL." }, 400);
    const userId = c.get("user").id;
    const collection = getCollectionRow(userId, c.req.param("id"));
    if (!collection) return c.json({ error: "Collection not found" }, 404);
    let page: Awaited<ReturnType<typeof fetchKnowledgeUrl>>;
    try {
      page = await fetchKnowledgeUrl(parsed.data.url, { signal: c.req.raw.signal });
    } catch (error) {
      // Only messages this module wrote are shown; transport failures keep a generic text.
      return c.json({ error: error instanceof KnowledgeInputError ? error.message : "Could not read that URL." }, 422);
    }
    // The original response body is the upload; `page.text` is only the extraction used for chunking.
    const source = addSource(userId, collection.id, {
      name: page.title.slice(0, 200),
      kind: "url",
      mime: page.mime,
      data: page.bytes,
      text: page.text,
      url: parsed.data.url,
    });
    enqueueSource(userId, source.id);
    return c.json(source, 201);
  })
  .post("/collections/:id/reindex", (c) => {
    const userId = c.get("user").id;
    const collectionId = c.req.param("id");
    if (!getCollectionRow(userId, collectionId)) return c.json({ error: "Collection not found" }, 404);
    cancelCollectionIngestion(userId, collectionId);
    const sources = listSources(userId, collectionId);
    requeueCollection(userId, collectionId);
    enqueueSources(userId, sources.map((source) => source.id));
    return c.json({ queued: sources.length });
  })
  .post("/collections/:id/search", async (c) => {
    const parsed = z.object({ query: z.string().trim().min(1).max(1000), k: z.number().int().min(1).max(12).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a search query." }, 400);
    const userId = c.get("user").id;
    const collection = getCollectionRow(userId, c.req.param("id"));
    if (!collection) return c.json({ error: "Collection not found" }, 404);
    const result = await searchKnowledge({
      userId,
      collectionIds: [collection.id],
      projectId: collection.project_id,
      query: parsed.data.query,
      k: parsed.data.k,
    });
    return c.json({ mode: result.mode, degraded: result.degraded ?? false, tokens: result.tokens, hits: result.hits.map((hit) => ({ ...hit, excerpt: excerpt(hit.text) })) });
  })
  .get("/collections/:id/chunks", (c) => {
    const userId = c.get("user").id;
    const collection = getCollectionRow(userId, c.req.param("id"));
    if (!collection) return c.json({ error: "Collection not found" }, 404);
    const source = c.req.query("source");
    const limit = Math.max(1, Math.min(100, Number(c.req.query("limit") ?? 20) || 20));
    const rows = db
      .prepare(
        `SELECT c.id, c.source_id, c.ordinal, c.title, c.start, c."end", c.text, c.tokens, s.name AS source_name
         FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id
         WHERE c.user_id = ? AND c.collection_id = ? ${source ? "AND c.source_id = ?" : ""}
         ORDER BY s.created_at, c.ordinal LIMIT ?`,
      )
      .all(...(source ? [userId, collection.id, source, limit] : [userId, collection.id, limit])) as Array<{ id: string; source_id: string; ordinal: number; title: string; start: number; end: number; text: string; tokens: number; source_name: string }>;
    return c.json({
      chunks: rows.map((row) => ({ id: row.id, sourceId: row.source_id, sourceName: row.source_name, ordinal: row.ordinal, title: row.title || row.source_name, start: row.start, end: row.end, tokens: row.tokens, excerpt: excerpt(row.text) })),
    });
  })
  // Citation panel: owned passage only. The route is not reachable from a public share.
  .get("/chunks/:id", (c) => {
    const row = chunkRow(c.get("user").id, c.req.param("id"));
    if (!row) return c.json({ error: "Passage not found" }, 404);
    return c.json(passageOf(row));
  })
  .get("/sources/:id/chunks", (c) => {
    const userId = c.get("user").id;
    const source = sourceRow(userId, c.req.param("id"));
    if (!source) return c.json({ error: "Source not found" }, 404);
    const rows = db
      .prepare(`SELECT id, source_id, ordinal, title, start, "end", text, tokens FROM knowledge_chunks WHERE user_id = ? AND source_id = ? ORDER BY ordinal LIMIT 100`)
      .all(userId, source.id) as Array<{ id: string; source_id: string; ordinal: number; title: string; start: number; end: number; text: string; tokens: number }>;
    return c.json({ chunks: rows.map((row) => ({ id: row.id, sourceId: row.source_id, ordinal: row.ordinal, title: row.title || source.name, start: row.start, end: row.end, tokens: row.tokens, text: row.text })) });
  })
  .post("/sources/:id/retry", (c) => {
    const userId = c.get("user").id;
    const sourceId = c.req.param("id");
    if (!requeueSource(userId, sourceId)) return c.json({ error: "Source not found" }, 404);
    enqueueSource(userId, sourceId);
    return c.json({ queued: true });
  })
  .post("/sources/:id/reindex", (c) => {
    const userId = c.get("user").id;
    const sourceId = c.req.param("id");
    if (!requeueSource(userId, sourceId)) return c.json({ error: "Source not found" }, 404);
    enqueueSource(userId, sourceId);
    return c.json({ queued: true });
  })
  .post("/sources/:id/cancel", (c) => {
    const userId = c.get("user").id;
    if (!cancelSourceIngestion(userId, c.req.param("id"))) return c.json({ error: "This source is not processing." }, 409);
    return c.json({ ok: true });
  })
  .delete("/sources/:id", (c) => {
    const userId = c.get("user").id;
    cancelSourceIngestion(userId, c.req.param("id"));
    if (!deleteSource(userId, c.req.param("id"))) return c.json({ error: "Source not found" }, 404);
    return c.json({ ok: true });
  });
