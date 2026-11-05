import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../auth.js";
import { db } from "../db.js";
import { assertFeature } from "../permissions/guard.js";
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
  audienceTargets,
  collectionDetail,
  collectionSharingState,
  decodeCursor,
  KnowledgeConflictError,
  listAttachablePage,
  listOwnedPage,
  listSharedPage,
  readableChunkRows,
  readableCollectionRow,
  readablePassage,
  readableSourceChunks,
  readableSourceSummaries,
  setCollectionSharing,
} from "./access.js";
import {
  createCollection,
  createSource,
  deleteCollection,
  deleteSource,
  getCollectionRow,
  listSources,
  KnowledgeInputError,
  requeueCollection,
  requeueSource,
  sourceRow,
  updateCollection,
} from "./store.js";

// Authenticated knowledge management. No model can call these: ingestion, edits, publication, and deletes
// are a user action. Every route resolves ownership first; reader routes resolve the live audience instead
// and never expose an owner's other rows, originals, or provider details.

const MAX_TEXT = 400_000;
const embeddingInput = z.object({
  provider: z.enum(["none", "openai", "google", "ollama", "compatible"]),
  providerId: z.string().min(1).max(200).optional(),
  model: z.string().max(200).optional(),
}).strict();
const collectionInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  projectId: z.string().max(200).nullable().optional(),
  embedding: embeddingInput,
}).strict();
const collectionPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  projectId: z.string().max(200).nullable().optional(),
  embedding: embeddingInput.optional(),
}).strict();

const audienceShape = z.object({
  mode: z.enum(["all", "selected"]),
  userIds: z.array(z.string().min(1).max(200)).max(200).optional(),
  groupIds: z.array(z.string().min(1).max(200)).max(200).optional(),
}).strict();
const sharingInput = z.discriminatedUnion("visibility", [
  z.object({ visibility: z.literal("private"), expectedRevision: z.number().int().min(1) }).strict(),
  z.object({ visibility: z.literal("shared"), audience: audienceShape, expectedRevision: z.number().int().min(1) }).strict(),
]);
const reindexInput = z.object({ embedding: embeddingInput.optional() }).strict();

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

/**
 * Owner-only mutation authority: missing or foreign rows answer 404; a readable but foreign collection
 * answers 403 so a reader learns only that this is not theirs to edit.
 */
function ownedForMutation(userId: string, id: string) {
  const own = getCollectionRow(userId, id);
  if (own) return own;
  if (readableCollectionRow(userId, id)) throw new HTTPException(403, { message: "Only the collection owner can change it." });
  throw new HTTPException(404, { message: "Collection not found" });
}

function readableOr404(userId: string, id: string) {
  const row = readableCollectionRow(userId, id);
  if (!row) throw new HTTPException(404, { message: "Collection not found" });
  return row;
}

const passageOf = (row: NonNullable<ReturnType<typeof readablePassage>>) => ({
  chunk: { id: row.id, sourceId: row.source_id, ordinal: row.ordinal, title: row.title || row.source_name, start: row.start, end: row.end, text: row.text, tokens: row.tokens },
  source: { id: row.source_id, name: row.source_name, kind: row.source_kind, url: row.source_url, collectionId: row.collection_id },
  collection: { id: row.collection_id, name: row.collection_name, projectId: row.project_id },
});

const limitOf = (value: string | undefined, fallback = 50) => Math.max(1, Math.min(100, Number(value ?? fallback) || fallback));

export const knowledgeRoutes = new Hono<AppEnv>()
  .use(bodyLimit({ maxSize: MAX_BYTES + 1024 * 1024 }))
  .use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  // Management JSON is small; the file upload and the 400k-character paste keep their own larger bounds.
  .use(async (c, next) => {
    const length = Number(c.req.header("content-length") ?? 0);
    const path = c.req.path;
    const larger = path.endsWith("/sources/file") || path.endsWith("/sources/paste");
    if (!larger && Number.isFinite(length) && length > 128 * 1024) {
      return c.json({ error: "Request is too large." }, 413);
    }
    await next();
  })
  // Registered before `/collections/:id` so the literal path is not shadowed.
  .get("/embedding-options", async (c) => {
    assertFeature(c.get("user").id, "knowledge");
    return c.json({ options: await embeddingOptions(c.get("user").id) });
  })
  // Minimal sharing directory: never an account directory, and no email or member list.
  .get("/audience-targets", (c) => {
    const kind = c.req.query("kind") === "groups" ? "groups" : "users";
    const result = audienceTargets(c.get("user").id, {
      kind,
      q: c.req.query("q") ?? "",
      userId: c.req.query("userId") ?? undefined,
      limit: Math.max(1, Math.min(50, Number(c.req.query("limit") ?? 20) || 20)),
    });
    return c.json({ items: result.items, nextCursor: null });
  })
  .get("/collections", (c) => {
    const userId = c.get("user").id;
    const scope = c.req.query("scope");
    const projectValue = c.req.query("project");
    const project = projectValue === undefined ? undefined : projectValue === "none" ? null : projectValue;
    const limit = limitOf(c.req.query("limit"));
    const cursor = decodeCursor(c.req.query("cursor"));
    if (c.req.query("cursor") && !cursor) return c.json({ error: "Invalid cursor", code: "validation" }, 400);
    const page = scope === "shared"
      ? listSharedPage(userId, limit, cursor)
      : scope === "attachable"
        ? listAttachablePage(userId, project ?? null, limit, cursor)
        : listOwnedPage(userId, project, limit, cursor);
    return c.json(page);
  })
  .post("/collections", async (c) => {
    assertFeature(c.get("user").id, "knowledge");
    const parsed = collectionInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid collection" }, 400);
    return c.json(createCollection(c.get("user").id, parsed.data), 201);
  })
  .get("/collections/:id", (c) => {
    const userId = c.get("user").id;
    const detail = collectionDetail(userId, c.req.param("id"));
    if (!detail) return c.json({ error: "Collection not found" }, 404);
    if (detail.access === "owner") {
      return c.json({ collection: detail.collection, sources: listSources(userId, detail.row.id) });
    }
    return c.json({ collection: detail.collection, sources: readableSourceSummaries(detail.row) });
  })
  .patch("/collections/:id", async (c) => {
    const userId = c.get("user").id;
    ownedForMutation(userId, c.req.param("id"));
    assertFeature(userId, "knowledge");
    const parsed = collectionPatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid collection" }, 400);
    const result = updateCollection(userId, c.req.param("id"), parsed.data);
    return c.json(result.collection);
  })
  .get("/collections/:id/sharing", (c) => {
    const userId = c.get("user").id;
    ownedForMutation(userId, c.req.param("id"));
    const state = collectionSharingState(userId, c.req.param("id"));
    if (!state) return c.json({ error: "Collection not found" }, 404);
    return c.json(state);
  })
  .put("/collections/:id/sharing", async (c) => {
    const userId = c.get("user").id;
    ownedForMutation(userId, c.req.param("id"));
    // Publishing is also the owner's way back to private while the knowledge feature is denied, so this
    // one mutation deliberately does not require the read feature.
    const parsed = sharingInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid sharing settings" }, 400);
    const input = parsed.data.visibility === "private"
      ? { visibility: "private" as const, expectedRevision: parsed.data.expectedRevision }
      : {
          visibility: "shared" as const,
          expectedRevision: parsed.data.expectedRevision,
          audience: {
            mode: parsed.data.audience.mode,
            userIds: parsed.data.audience.userIds ?? [],
            groupIds: parsed.data.audience.groupIds ?? [],
          },
        };
    try {
      const state = setCollectionSharing(userId, c.req.param("id"), input);
      if (!state) return c.json({ error: "Collection not found" }, 404);
      return c.json(state);
    } catch (error) {
      if (!(error instanceof KnowledgeConflictError)) throw error;
      if (error.message === "project_bound") return c.json({ error: "Clear the project restriction before sharing this collection.", code: "knowledge_project_bound" }, 409);
      if (error.message === "invalid_audience") return c.json({ error: "Invalid audience" }, 400);
      return c.json({ error: "Sharing changed. Reload the current audience before saving.", code: "knowledge_conflict" }, 409);
    }
  })
  .delete("/collections/:id", (c) => {
    const userId = c.get("user").id;
    const row = ownedForMutation(userId, c.req.param("id"));
    cancelCollectionIngestion(userId, row.id);
    if (!deleteCollection(userId, row.id)) return c.json({ error: "Collection not found" }, 404);
    return c.json({ ok: true });
  })
  .post("/collections/:id/reindex", async (c) => {
    const userId = c.get("user").id;
    const row = ownedForMutation(userId, c.req.param("id"));
    assertFeature(userId, "knowledge");
    const parsed = reindexInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid reindex request" }, 400);
    cancelCollectionIngestion(userId, row.id);
    let queued: number;
    try {
      queued = requeueCollection(userId, row.id, parsed.data.embedding);
    } catch (error) {
      if (error instanceof HTTPException) return c.json({ error: error.message, code: "knowledge_reindex_required" }, error.status);
      throw error;
    }
    enqueueSources(userId, listSources(userId, row.id).map((source) => source.id));
    return c.json({ queued });
  })
  .post("/collections/:id/search", async (c) => {
    const parsed = z.object({ query: z.string().trim().min(1).max(1000), k: z.number().int().min(1).max(12).optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a search query." }, 400);
    const userId = c.get("user").id;
    assertFeature(userId, "knowledge");
    const collection = readableOr404(userId, c.req.param("id"));
    const result = await searchKnowledge({
      userId,
      collectionIds: [collection.id],
      projectId: collection.project_id,
      query: parsed.data.query,
      k: parsed.data.k,
      signal: c.req.raw.signal,
    });
    return c.json({
      mode: result.mode,
      degraded: result.degraded ?? false,
      tokens: result.tokens,
      collections: result.collections,
      hits: result.hits.map((hit) => ({ ...hit, excerpt: excerpt(hit.text) })),
    });
  })
  .get("/collections/:id/chunks", (c) => {
    const userId = c.get("user").id;
    assertFeature(userId, "knowledge");
    const collection = readableOr404(userId, c.req.param("id"));
    const source = c.req.query("source");
    if (source && !db.prepare("SELECT 1 FROM knowledge_sources WHERE user_id = ? AND collection_id = ? AND id = ?").get(collection.user_id, collection.id, source)) {
      return c.json({ error: "Source not found" }, 404);
    }
    const limit = limitOf(c.req.query("limit"), 20);
    const rows = readableChunkRows(collection, source ?? null, limit);
    return c.json({
      chunks: rows.map((row) => ({ id: row.id, sourceId: row.source_id, sourceName: row.source_name, ordinal: row.ordinal, title: row.title || row.source_name, start: row.start, end: row.end, tokens: row.tokens, excerpt: excerpt(row.text) })),
    });
  })
  // Citation panel: any readable passage. Unknown, deleted, foreign, and revoked ids all answer the same 404.
  .get("/chunks/:id", (c) => {
    assertFeature(c.get("user").id, "knowledge");
    const row = readablePassage(c.get("user").id, c.req.param("id"));
    if (!row) return c.json({ error: "Passage not found" }, 404);
    return c.json(passageOf(row));
  })
  .get("/sources/:id/chunks", (c) => {
    const userId = c.get("user").id;
    assertFeature(userId, "knowledge");
    const rows = readableSourceChunks(userId, c.req.param("id"));
    if (!rows) return c.json({ error: "Source not found" }, 404);
    return c.json({ chunks: rows.map((row) => ({ id: row.id, sourceId: row.source_id, ordinal: row.ordinal, title: row.title, start: row.start, end: row.end, tokens: row.tokens, text: row.text })) });
  })
  .post("/collections/:id/sources/file", async (c) => {
    const userId = c.get("user").id;
    ownedForMutation(userId, c.req.param("id"));
    assertFeature(userId, "knowledge");
    const collectionId = c.req.param("id");
    if (!getCollectionRow(userId, collectionId)) return c.json({ error: "Collection not found" }, 404);
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "No file" }, 400);
    if (file.size > MAX_BYTES) return c.json({ error: "File is larger than 25 MB" }, 413);
    if (/^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|avif|bmp|tiff?)$/i.test(file.name)) {
      return c.json({ error: "Images are not supported yet: this build has no OCR for them. Add a text, PDF, DOCX, or spreadsheet file instead." }, 415);
    }
    // Ownership and feature state are rechecked after the awaited form body, not only before it.
    if (!getCollectionRow(userId, collectionId)) return c.json({ error: "Collection not found" }, 404);
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
    const userId = c.get("user").id;
    ownedForMutation(userId, c.req.param("id"));
    assertFeature(userId, "knowledge");
    const parsed = z.object({ name: z.string().trim().min(1).max(200), text: z.string().min(1).max(MAX_TEXT) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: `Pasted text must be 1–${MAX_TEXT} characters with a name.` }, 400);
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
    const userId = c.get("user").id;
    const collectionId = c.req.param("id");
    ownedForMutation(userId, collectionId);
    assertFeature(userId, "knowledge");
    const parsed = z.object({ url: z.string().url().max(2000) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a valid http or https URL." }, 400);
    if (!getCollectionRow(userId, collectionId)) return c.json({ error: "Collection not found" }, 404);
    let page: Awaited<ReturnType<typeof fetchKnowledgeUrl>>;
    try {
      page = await fetchKnowledgeUrl(parsed.data.url, { signal: c.req.raw.signal });
    } catch (error) {
      // Only messages this module wrote are shown; transport failures keep a generic text.
      return c.json({ error: error instanceof KnowledgeInputError ? error.message : "Could not read that URL." }, 422);
    }
    // The awaited fetch may have outlived the collection or the owner's permission to add sources.
    if (!getCollectionRow(userId, collectionId)) return c.json({ error: "Collection not found" }, 404);
    assertFeature(userId, "knowledge");
    const source = addSource(userId, collectionId, {
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
  .post("/sources/:id/retry", (c) => {
    const userId = c.get("user").id;
    const source = ownedSource(userId, c.req.param("id"));
    assertFeature(userId, "knowledge");
    if (!requeueSource(userId, source.id)) return c.json({ error: "Source not found" }, 404);
    enqueueSource(userId, source.id);
    return c.json({ queued: true });
  })
  .post("/sources/:id/reindex", (c) => {
    const userId = c.get("user").id;
    const source = ownedSource(userId, c.req.param("id"));
    assertFeature(userId, "knowledge");
    if (!requeueSource(userId, source.id)) return c.json({ error: "Source not found" }, 404);
    enqueueSource(userId, source.id);
    return c.json({ queued: true });
  })
  .post("/sources/:id/cancel", (c) => {
    const userId = c.get("user").id;
    const source = ownedSource(userId, c.req.param("id"));
    if (!cancelSourceIngestion(userId, source.id)) return c.json({ error: "This source is not processing." }, 409);
    return c.json({ ok: true });
  })
  .delete("/sources/:id", (c) => {
    const userId = c.get("user").id;
    const source = ownedSource(userId, c.req.param("id"));
    cancelSourceIngestion(userId, source.id);
    if (!deleteSource(userId, source.id)) return c.json({ error: "Source not found" }, 404);
    return c.json({ ok: true });
  });

/** Source authority: owner row only, with reader authority mapped to the same 403/404 vocabulary. */
function ownedSource(userId: string, id: string) {
  const source = sourceRow(userId, id);
  if (source) return source;
  const owned = db.prepare("SELECT 1 FROM knowledge_sources WHERE id = ?").get(id);
  if (owned) throw new HTTPException(403, { message: "Only the collection owner can change its sources." });
  throw new HTTPException(404, { message: "Source not found" });
}
