import { HTTPException } from "hono/http-exception";
import type {
  KnowledgeCollection,
  KnowledgeCollectionStatus,
  KnowledgeEmbeddingSetting,
  KnowledgeSource,
  KnowledgeSourceKind,
  KnowledgeSourceStatus,
} from "../../shared/knowledge.js";
import { newId } from "../crypto.js";
import { db, tx } from "../db.js";
import type { RawChunk } from "./chunker.js";
import { encodeVector } from "./embeddings.js";
import { assertStorage } from "../quota.js";
import { deleteUpload } from "../files.js";
import { assertFeature } from "../permissions/guard.js";

// Account-owned collections, sources, and chunks. Every query carries `user_id`; a chat may only use a
// collection that is global or bound to the chat's own project (docs/implementation/knowledge.md).

/** A message this module wrote for the user (validation, unsupported input). Routes and jobs show it; any other error is generic. */
export class KnowledgeInputError extends Error {}

export interface CollectionRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  project_id: string | null;
  embedding_provider: KnowledgeEmbeddingSetting["provider"];
  embedding_provider_id: string | null;
  embedding_model: string | null;
  embedding_dim: number | null;
  status: KnowledgeCollectionStatus;
  vectors_revision: number;
  created_at: number;
  updated_at: number;
}

export interface SourceRow {
  id: string;
  collection_id: string;
  user_id: string;
  upload_id: string | null;
  name: string;
  kind: KnowledgeSourceKind;
  url: string | null;
  mime: string;
  bytes: number;
  text_bytes: number;
  text: string | null;
  status: KnowledgeSourceStatus;
  progress: number;
  error: string | null;
  chunk_count: number;
  generation: number;
  created_at: number;
  updated_at: number;
}

interface Stats {
  source_count: number;
  chunk_count: number;
  bytes: number;
  processing: number;
  failed: number;
}

export const embeddingOf = (row: CollectionRow): KnowledgeEmbeddingSetting =>
  row.embedding_provider === "none"
    ? { provider: "none" }
    : {
        provider: row.embedding_provider,
        ...(row.embedding_provider_id ? { providerId: row.embedding_provider_id } : {}),
        ...(row.embedding_model ? { model: row.embedding_model } : {}),
      };

export const sourceOf = (row: SourceRow): KnowledgeSource => ({
  id: row.id,
  collectionId: row.collection_id,
  name: row.name,
  kind: row.kind,
  url: row.url,
  mime: row.mime,
  bytes: row.bytes,
  textBytes: row.text_bytes,
  status: row.status,
  progress: row.progress,
  error: row.error,
  chunkCount: row.chunk_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function statsFor(userId: string, rows: CollectionRow[]): Map<string, Stats> {
  const ids = rows.map((row) => row.id);
  const out = new Map<string, Stats>();
  if (!ids.length) return out;
  const marks = ids.map(() => "?").join(",");
  const sources = db
    .prepare(
      `SELECT collection_id, COUNT(*) AS source_count,
        COALESCE(SUM(bytes + text_bytes), 0) AS bytes,
        COALESCE(SUM(status IN ('queued', 'extracting', 'embedding')), 0) AS processing,
        COALESCE(SUM(status = 'failed'), 0) AS failed
       FROM knowledge_sources WHERE user_id = ? AND collection_id IN (${marks}) GROUP BY collection_id`,
    )
    .all(userId, ...ids) as unknown as Array<Omit<Stats, "chunk_count"> & { collection_id: string }>;
  const chunks = db
    .prepare(
      `SELECT collection_id, COUNT(*) AS chunk_count, COALESCE(SUM(length(CAST(text AS BLOB)) + COALESCE(length(embedding), 0)), 0) AS bytes
       FROM knowledge_chunks WHERE user_id = ? AND collection_id IN (${marks}) GROUP BY collection_id`,
    )
    .all(userId, ...ids) as unknown as Array<{ collection_id: string; chunk_count: number; bytes: number }>;
  for (const id of ids) out.set(id, { source_count: 0, chunk_count: 0, bytes: 0, processing: 0, failed: 0 });
  for (const row of sources) {
    const stats = out.get(row.collection_id)!;
    stats.source_count = row.source_count;
    stats.bytes = row.bytes;
    stats.processing = row.processing;
    stats.failed = row.failed;
  }
  // Chunks also duplicate the extracted text; count them once more, as the quota does.
  for (const row of chunks) {
    const stats = out.get(row.collection_id)!;
    stats.chunk_count = row.chunk_count;
    stats.bytes += row.bytes;
  }
  return out;
}

function statusOf(stats: Stats): KnowledgeCollectionStatus {
  if (stats.processing > 0) return "processing";
  if (stats.source_count === 0) return "empty";
  if (stats.chunk_count > 0) return "ready";
  if (stats.failed > 0) return "failed";
  return "empty";
}

export function toCollection(row: CollectionRow, stats?: Stats): KnowledgeCollection {
  const s = stats ?? { source_count: 0, chunk_count: 0, bytes: 0, processing: 0, failed: 0 };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    projectId: row.project_id,
    embedding: embeddingOf(row),
    status: statusOf(s),
    sourceCount: s.source_count,
    chunkCount: s.chunk_count,
    bytes: s.bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getCollectionRow(userId: string, id: string): CollectionRow | undefined {
  return db.prepare("SELECT * FROM knowledge_collections WHERE user_id = ? AND id = ?").get(userId, id) as CollectionRow | undefined;
}

export function getCollection(userId: string, id: string): KnowledgeCollection | null {
  const row = getCollectionRow(userId, id);
  return row ? toCollection(row, statsFor(userId, [row]).get(row.id)) : null;
}

/** A collection is usable from a chat when it is global or bound to that chat's project. */
export function collectionAccessible(userId: string, id: string, projectId: string | null): CollectionRow | undefined {
  const row = getCollectionRow(userId, id);
  if (!row) return undefined;
  return row.project_id === null || row.project_id === projectId ? row : undefined;
}

export function accessibleCollections(userId: string, ids: readonly string[], projectId: string | null): CollectionRow[] {
  return ids.flatMap((id) => {
    const row = collectionAccessible(userId, id, projectId);
    return row ? [row] : [];
  });
}

export function listCollections(userId: string): KnowledgeCollection[] {
  const rows = db
    .prepare("SELECT * FROM knowledge_collections WHERE user_id = ? ORDER BY updated_at DESC, id")
    .all(userId) as unknown as CollectionRow[];
  const stats = statsFor(userId, rows);
  return rows.map((row) => toCollection(row, stats.get(row.id)));
}

/** Collections the selector may attach to a chat in this project. */
export function attachableCollections(userId: string, projectId: string | null): KnowledgeCollection[] {
  return listCollections(userId).filter((collection) => collection.projectId === null || collection.projectId === projectId);
}

function invalid(message: string, status: 400 | 404 | 409 = 400): never {
  throw new HTTPException(status, { message });
}

function validateProject(userId: string, projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ? AND user_id = ?").get(projectId, userId)) invalid("Project not found", 404);
  return projectId;
}

function validateName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > 80) invalid("Collection names must be 1–80 characters.");
  return trimmed;
}

export interface CollectionInput {
  name: string;
  description?: string;
  projectId?: string | null;
  embedding: KnowledgeEmbeddingSetting;
}

function validateEmbedding(embedding: KnowledgeEmbeddingSetting): KnowledgeEmbeddingSetting {
  if (embedding.provider === "none") return { provider: "none" };
  if (!["openai", "google", "ollama", "compatible"].includes(embedding.provider)) invalid("Unknown embedding provider.");
  if (embedding.provider === "compatible" && !embedding.providerId) invalid("Choose an embedding connection.");
  const model = embedding.model?.trim();
  if (!model || model.length > 200) invalid("Enter an embedding model name.");
  return { provider: embedding.provider, ...(embedding.providerId ? { providerId: embedding.providerId } : {}), model };
}

export function createCollection(userId: string, input: CollectionInput): KnowledgeCollection {
  assertFeature(userId, "knowledge");
  const now = Date.now();
  const id = newId("knc");
  const name = validateName(input.name);
  const projectId = validateProject(userId, input.projectId);
  const embedding = validateEmbedding(input.embedding);
  if (db.prepare("SELECT 1 FROM knowledge_collections WHERE user_id = ? AND name = ?").get(userId, name)) invalid("A collection with that name exists.", 409);
  db.prepare(
    `INSERT INTO knowledge_collections (id, user_id, name, description, project_id, embedding_provider, embedding_provider_id, embedding_model, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'empty', ?, ?)`,
  ).run(id, userId, name, (input.description ?? "").slice(0, 500), projectId, embedding.provider, embedding.providerId ?? null, embedding.model ?? null, now, now);
  return getCollection(userId, id)!;
}

export interface CollectionPatch {
  name?: string;
  description?: string;
  projectId?: string | null;
  embedding?: KnowledgeEmbeddingSetting;
}

/** Returns whether the embedding choice changed, so the caller can queue a reindex. */
export function updateCollection(userId: string, id: string, patch: CollectionPatch): { collection: KnowledgeCollection; reindex: boolean } {
  assertFeature(userId, "knowledge");
  const row = getCollectionRow(userId, id);
  if (!row) invalid("Collection not found", 404);
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.name !== undefined) {
    const name = validateName(patch.name);
    if (db.prepare("SELECT 1 FROM knowledge_collections WHERE user_id = ? AND name = ? AND id != ?").get(userId, name, id)) invalid("A collection with that name exists.", 409);
    sets.push("name = ?"), values.push(name);
  }
  if (patch.description !== undefined) sets.push("description = ?"), values.push(patch.description.slice(0, 500));
  if (patch.projectId !== undefined) sets.push("project_id = ?"), values.push(validateProject(userId, patch.projectId));
  let reindex = false;
  if (patch.embedding) {
    const next = validateEmbedding(patch.embedding);
    const current = embeddingOf(row);
    reindex =
      next.provider !== current.provider ||
      next.providerId !== current.providerId ||
      (next.model ?? "") !== (current.model ?? "");
    if (reindex) {
      sets.push("embedding_provider = ?", "embedding_provider_id = ?", "embedding_model = ?", "embedding_dim = NULL", "vectors_revision = vectors_revision + 1");
      values.push(next.provider, next.providerId ?? null, next.model ?? null);
    }
  }
  if (sets.length) {
    sets.push("updated_at = ?");
    values.push(Date.now());
    db.prepare(`UPDATE knowledge_collections SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`).run(...values, userId, id);
  }
  return { collection: getCollection(userId, id)!, reindex };
}

/** Deletes rows, chunks, and the original uploads; quota is released with the bytes. */
export function deleteCollection(userId: string, id: string): boolean {
  return tx(() => {
    const row = getCollectionRow(userId, id);
    if (!row) return false;
    const uploads = db.prepare("SELECT upload_id FROM knowledge_sources WHERE user_id = ? AND collection_id = ? AND upload_id IS NOT NULL").all(userId, id) as Array<{ upload_id: string }>;
    db.prepare("DELETE FROM knowledge_collections WHERE user_id = ? AND id = ?").run(userId, id);
    for (const { upload_id } of uploads) deleteUpload(userId, upload_id);
    return true;
  });
}

export function sourceRow(userId: string, id: string): SourceRow | undefined {
  return db.prepare("SELECT * FROM knowledge_sources WHERE user_id = ? AND id = ?").get(userId, id) as SourceRow | undefined;
}

export function listSources(userId: string, collectionId: string): KnowledgeSource[] {
  return (db
    .prepare("SELECT * FROM knowledge_sources WHERE user_id = ? AND collection_id = ? ORDER BY created_at, id")
    .all(userId, collectionId) as unknown as SourceRow[]).map(sourceOf);
}

export interface SourceInput {
  name: string;
  kind: KnowledgeSourceKind;
  mime: string;
  /** Original bytes, already stored as an upload. */
  uploadId: string;
  bytes: number;
  text?: string;
  url?: string;
}

/** Inserts a queued source and its already-stored original upload reference. */
export function createSource(userId: string, collectionId: string, input: SourceInput): KnowledgeSource {
  assertFeature(userId, "knowledge");
  const collection = getCollectionRow(userId, collectionId);
  if (!collection) invalid("Collection not found", 404);
  const sourceCount = (db.prepare("SELECT COUNT(*) AS n FROM knowledge_sources WHERE user_id = ? AND collection_id = ?").get(userId, collectionId) as { n: number }).n;
  if (sourceCount >= 2_000) invalid("This collection has the maximum of 2,000 sources.", 409);
  const now = Date.now();
  const id = newId("kns");
  const textBytes = input.text ? Buffer.byteLength(input.text) : 0;
  return tx(() => {
    if (input.text) assertStorage(userId, textBytes);
    db.prepare(
      `INSERT INTO knowledge_sources (id, collection_id, user_id, upload_id, name, kind, url, mime, bytes, text_bytes, text, status, progress, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
    ).run(id, collectionId, userId, input.uploadId, input.name.slice(0, 200), input.kind, input.url ?? null, input.mime, input.bytes, textBytes, input.text ?? null, now, now);
    db.prepare("UPDATE knowledge_collections SET updated_at = ? WHERE user_id = ? AND id = ?").run(now, userId, collectionId);
    return sourceOf(sourceRow(userId, id)!);
  });
}

/** Stores extraction output, charging only the growth. Returns false when the job was superseded. */
export function setSourceText(userId: string, sourceId: string, generation: number, text: string): boolean {
  return tx(() => {
    const row = sourceRow(userId, sourceId);
    if (!row || row.generation !== generation) return false;
    const bytes = Buffer.byteLength(text);
    assertStorage(userId, bytes - row.text_bytes);
    db.prepare("UPDATE knowledge_sources SET text = ?, text_bytes = ?, status = 'embedding', progress = 0.55, error = NULL, updated_at = ? WHERE user_id = ? AND id = ? AND generation = ?")
      .run(text, bytes, Date.now(), userId, sourceId, generation);
    return true;
  });
}

export function setSourceProgress(userId: string, sourceId: string, generation: number, status: KnowledgeSourceStatus, progress: number) {
  db.prepare("UPDATE knowledge_sources SET status = ?, progress = ?, updated_at = ? WHERE user_id = ? AND id = ? AND generation = ?")
    .run(status, Math.min(1, Math.max(0, progress)), Date.now(), userId, sourceId, generation);
}

export function failSource(userId: string, sourceId: string, generation: number, message: string) {
  db.prepare("UPDATE knowledge_sources SET status = 'failed', progress = 0, error = ?, updated_at = ? WHERE user_id = ? AND id = ? AND generation = ?")
    .run(message.slice(0, 1000), Date.now(), userId, sourceId, generation);
}

/** Cancels a queued or running source. The generation bump makes any later write from that job a no-op. */
export function cancelSource(userId: string, sourceId: string): boolean {
  return tx(() => {
    const row = sourceRow(userId, sourceId);
    if (!row) return false;
    if (row.status === "cancelled" || row.status === "ready" || row.status === "failed") return false;
    db.prepare("UPDATE knowledge_sources SET status = 'cancelled', progress = 0, generation = generation + 1, updated_at = ? WHERE user_id = ? AND id = ?")
      .run(Date.now(), userId, sourceId);
    return true;
  });
}

/** Retry or reindex: keeps extraction text, drops chunks, and starts a fresh job generation. */
export function requeueSource(userId: string, sourceId: string): boolean {
  return tx(() => {
    const row = sourceRow(userId, sourceId);
    if (!row) return false;
    const chunks = db.prepare("SELECT COALESCE(SUM(length(CAST(text AS BLOB)) + COALESCE(length(embedding), 0)), 0) AS bytes FROM knowledge_chunks WHERE user_id = ? AND source_id = ?").get(userId, sourceId) as { bytes: number };
    db.prepare("DELETE FROM knowledge_chunks WHERE user_id = ? AND source_id = ?").run(userId, sourceId);
    assertStorage(userId, -chunks.bytes);
    db.prepare("UPDATE knowledge_sources SET status = 'queued', progress = 0, error = NULL, chunk_count = 0, generation = generation + 1, updated_at = ? WHERE user_id = ? AND id = ?")
      .run(Date.now(), userId, sourceId);
    db.prepare("UPDATE knowledge_collections SET vectors_revision = vectors_revision + 1, updated_at = ? WHERE user_id = ? AND id = ?").run(Date.now(), userId, row.collection_id);
    return true;
  });
}

/** Rebuilds every chunk in a collection, e.g. after the embedding model changed. */
export function requeueCollection(userId: string, collectionId: string): number {
  return tx(() => {
    const collection = getCollectionRow(userId, collectionId);
    if (!collection) invalid("Collection not found", 404);
    const bytes = db.prepare("SELECT COALESCE(SUM(length(CAST(text AS BLOB)) + COALESCE(length(embedding), 0)), 0) AS bytes FROM knowledge_chunks WHERE user_id = ? AND collection_id = ?").get(userId, collectionId) as { bytes: number };
    db.prepare("DELETE FROM knowledge_chunks WHERE user_id = ? AND collection_id = ?").run(userId, collectionId);
    assertStorage(userId, -bytes.bytes);
    const sources = db.prepare("UPDATE knowledge_sources SET status = 'queued', progress = 0, error = NULL, chunk_count = 0, generation = generation + 1, updated_at = ? WHERE user_id = ? AND collection_id = ?")
      .run(Date.now(), userId, collectionId);
    db.prepare("UPDATE knowledge_collections SET vectors_revision = vectors_revision + 1, updated_at = ? WHERE user_id = ? AND id = ?").run(Date.now(), userId, collectionId);
    return Number(sources.changes);
  });
}

export function deleteSource(userId: string, sourceId: string): boolean {
  return tx(() => {
    const row = sourceRow(userId, sourceId);
    if (!row) return false;
    const bytes = db.prepare("SELECT COALESCE(SUM(length(CAST(text AS BLOB)) + COALESCE(length(embedding), 0)), 0) AS bytes FROM knowledge_chunks WHERE user_id = ? AND source_id = ?").get(userId, sourceId) as { bytes: number };
    db.prepare("DELETE FROM knowledge_sources WHERE user_id = ? AND id = ?").run(userId, sourceId);
    if (row.upload_id) deleteUpload(userId, row.upload_id);
    assertStorage(userId, -bytes.bytes);
    db.prepare("UPDATE knowledge_collections SET vectors_revision = vectors_revision + 1, updated_at = ? WHERE user_id = ? AND id = ?").run(Date.now(), userId, row.collection_id);
    return true;
  });
}

export interface StoredChunk {
  chunk: RawChunk;
  vector: Float32Array | null;
}

/**
 * Replaces one source's chunks in a single transaction. Storage is charged for the net growth, including
 * the embeddings, so a retry or reindex can never bypass the quota.
 */
export function replaceChunks(userId: string, sourceId: string, generation: number, collectionId: string, chunks: StoredChunk[], dimensions: number | null): boolean {
  return tx(() => {
    const source = sourceRow(userId, sourceId);
    if (!source || source.generation !== generation) return false;
    const old = db.prepare("SELECT COALESCE(SUM(length(CAST(text AS BLOB)) + COALESCE(length(embedding), 0)), 0) AS bytes FROM knowledge_chunks WHERE user_id = ? AND source_id = ?").get(userId, sourceId) as { bytes: number };
    const next = chunks.reduce((sum, row) => sum + Buffer.byteLength(row.chunk.text) + (row.vector ? row.vector.byteLength : 0), 0);
    assertStorage(userId, next - old.bytes);
    db.prepare("DELETE FROM knowledge_chunks WHERE user_id = ? AND source_id = ?").run(userId, sourceId);
    const insert = db.prepare(
      `INSERT INTO knowledge_chunks (id, source_id, collection_id, user_id, ordinal, title, start, "end", text, tokens, embedding, embedding_dim, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    for (const { chunk, vector } of chunks) {
      insert.run(chunk.id, sourceId, collectionId, userId, chunk.ordinal, chunk.title, chunk.start, chunk.end, chunk.text, chunk.tokens, vector ? encodeVector(vector) : null, vector ? dimensions : null, now);
    }
    db.prepare("UPDATE knowledge_sources SET status = 'ready', progress = 1, error = NULL, chunk_count = ?, updated_at = ? WHERE user_id = ? AND id = ? AND generation = ?")
      .run(chunks.length, now, userId, sourceId, generation);
    db.prepare("UPDATE knowledge_collections SET status = 'ready', embedding_dim = COALESCE(?, embedding_dim), vectors_revision = vectors_revision + 1, updated_at = ? WHERE user_id = ? AND id = ?")
      .run(dimensions, now, userId, collectionId);
    return true;
  });
}

/** A pending source becoming ready may leave the collection empty until its job finishes. */
export function markCollectionStatus(userId: string, collectionId: string, status: KnowledgeCollectionStatus) {
  db.prepare("UPDATE knowledge_collections SET status = ?, updated_at = ? WHERE user_id = ? AND id = ?").run(status, Date.now(), userId, collectionId);
}

export interface ChunkRow {
  id: string;
  source_id: string;
  collection_id: string;
  ordinal: number;
  title: string;
  start: number;
  end: number;
  text: string;
  tokens: number;
  embedding: Uint8Array | null;
  source_name: string;
  source_kind: KnowledgeSourceKind;
  source_url: string | null;
  collection_name: string;
  project_id: string | null;
}

export function chunkRow(userId: string, chunkId: string): ChunkRow | undefined {
  return db
    .prepare(
      `SELECT c.id, c.source_id, c.collection_id, c.ordinal, c.title, c.start, c."end", c.text, c.tokens, c.embedding,
        s.name AS source_name, s.kind AS source_kind, s.url AS source_url, k.name AS collection_name, k.project_id
       FROM knowledge_chunks c
       JOIN knowledge_sources s ON s.id = c.source_id AND s.user_id = c.user_id
       JOIN knowledge_collections k ON k.id = c.collection_id AND k.user_id = c.user_id
       WHERE c.user_id = ? AND c.id = ?`,
    )
    .get(userId, chunkId) as ChunkRow | undefined;
}
