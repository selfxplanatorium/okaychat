import { AppError } from "../errors.js";
import type {
  KnowledgeRetrievalMode,
  KnowledgeSearchCollectionOutcome,
  KnowledgeSearchHit,
  KnowledgeSearchResult,
} from "../../shared/knowledge.js";
import { db } from "../db.js";
import { cosine, createEmbedder, decodeVector, embeddingKey, type Embedder } from "./embeddings.js";
import { readableCollectionsForChat, readableCollectionRow } from "./access.js";
import { embeddingNeedsReindex, type CollectionRow } from "./store.js";
import { assertFeature } from "../permissions/guard.js";
import { registerKnowledgeOperation } from "./revocation.js";
import { resolvePinnedConnection } from "../catalog/providers.js";

// Hybrid retrieval: FTS5 BM25 over chunks and cosine over normalized embeddings, fused with reciprocal
// rank fusion. Vectors are never scanned table-wide per query: the per-collection cache is bounded and
// keyed by `vectors_revision`, and FTS supplies a small prefiltered candidate set. A collection belonging
// to another account is always keyword-only: a reader query never touches the owner's credentials or
// embedding budget, and never reaches a private endpoint.

export const RRF_K = 60;
/** Bounded vector cache per collection. Queries still reach older chunks through FTS + indexed vector fetch. */
export const VECTOR_CACHE_LIMIT = 4_000;
export const MAX_LEXICAL_CANDIDATES = 120;
export const MAX_VECTOR_CANDIDATES = 60;
export const DEFAULT_K = 8;
export const DEFAULT_BUDGET_TOKENS = 2_400;

interface CachedVector {
  id: string;
  sourceId: string;
  vector: Float32Array;
}

interface CacheEntry {
  revision: number;
  entries: CachedVector[];
  bytes: number;
}

const vectorCache = new Map<string, CacheEntry>();
/** Upper bound on cached vector memory across all collections; the oldest collection is dropped first. */
export const VECTOR_CACHE_BYTES = 64 * 1024 * 1024;

function trimVectorCache() {
  let total = 0;
  for (const entry of vectorCache.values()) total += entry.bytes;
  for (const [id, entry] of vectorCache) {
    if (total <= VECTOR_CACHE_BYTES) break;
    vectorCache.delete(id);
    total -= entry.bytes;
  }
}

/** Tests replace provider resolution; production never calls this. */
let testEmbedder: ((collection: CollectionRow) => Embedder | null) | undefined;
export function setRetrievalEmbedderFactoryForTests(next: ((collection: CollectionRow) => Embedder | null) | null) {
  testEmbedder = next ?? undefined;
}

/** Called after any chunk write, delete, or reindex. */
export function invalidateKnowledgeVectors(collectionId?: string) {
  if (collectionId) vectorCache.delete(collectionId);
  else vectorCache.clear();
}

function cachedVectors(userId: string, collection: CollectionRow): CachedVector[] {
  const hit = vectorCache.get(collection.id);
  if (hit && hit.revision === collection.vectors_revision) {
    // Keep recently used collections at the end, so the byte bound evicts the least recently used.
    vectorCache.delete(collection.id);
    vectorCache.set(collection.id, hit);
    return hit.entries;
  }
  const rows = db
    .prepare(`SELECT id, source_id, embedding FROM knowledge_chunks WHERE user_id = ? AND collection_id = ? AND embedding IS NOT NULL ORDER BY rowid LIMIT ${VECTOR_CACHE_LIMIT}`)
    .all(userId, collection.id) as Array<{ id: string; source_id: string; embedding: Uint8Array }>;
  const entries: CachedVector[] = [];
  for (const row of rows) {
    const vector = decodeVector(row.embedding);
    if (vector) entries.push({ id: row.id, sourceId: row.source_id, vector });
  }
  const bytes = entries.reduce((sum, entry) => sum + entry.vector.byteLength, 0);
  vectorCache.delete(collection.id);
  vectorCache.set(collection.id, { revision: collection.vectors_revision, entries, bytes });
  trimVectorCache();
  return entries;
}

function finiteWords(query: string): string[] {
  return [...new Set(query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])]
    .map((word) => word.slice(0, 40))
    .slice(0, 12);
}

/** A safe FTS5 MATCH expression. Quoting every word keeps operators and punctuation out. */
export function ftsExpression(query: string): string | null {
  const words = finiteWords(query).map((word) => `"${word.replaceAll('"', "")}"`).filter((word) => word !== '""');
  return words.length ? words.join(" OR ") : null;
}

interface ChunkHitRow {
  id: string;
  source_id: string;
  collection_id: string;
  title: string;
  start: number;
  end: number;
  text: string;
  tokens: number;
  source_name: string;
  source_kind: "file" | "paste" | "url";
  source_url: string | null;
}

/** Loads rows by owner/id pairs; a bare id is never trusted to identify the owner. */
function loadRows(collections: CollectionRow[], ids: string[]): Map<string, ChunkHitRow> {
  const out = new Map<string, ChunkHitRow>();
  if (!collections.length) return out;
  const owners = [...new Set(collections.map((row) => row.user_id))];
  const ownerMarks = owners.map(() => "?").join(",");
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const marks = batch.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT c.id, c.source_id, c.collection_id, c.title, c.start, c."end", c.text, c.tokens,
          s.name AS source_name, s.kind AS source_kind, s.url AS source_url
         FROM knowledge_chunks c
         JOIN knowledge_sources s ON s.id = c.source_id AND s.user_id = c.user_id
         JOIN knowledge_collections k ON k.id = c.collection_id AND k.user_id = c.user_id
         WHERE c.user_id IN (${ownerMarks}) AND c.id IN (${marks})`,
      )
      .all(...owners, ...batch) as unknown as ChunkHitRow[];
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

/** FTS is constrained to the (owner, collection) pairs the caller authorized, never to the viewer id. */
function lexicalRanking(collections: CollectionRow[], query: string, sourceIds?: string[]): string[] {
  const match = ftsExpression(query);
  if (!match || !collections.length) return [];
  const byOwner = new Map<string, string[]>();
  for (const row of collections) {
    const list = byOwner.get(row.user_id);
    if (list) list.push(row.id);
    else byOwner.set(row.user_id, [row.id]);
  }
  const clauses: string[] = [];
  const args: Array<string> = [match];
  for (const [owner, ids] of byOwner) {
    clauses.push(`(user_id = ? AND collection_id IN (${ids.map(() => "?").join(",")}))`);
    args.push(owner, ...ids);
  }
  const sourceFilter = sourceIds?.length ? ` AND source_id IN (${sourceIds.map(() => "?").join(",")})` : "";
  if (sourceIds?.length) args.push(...sourceIds);
  try {
    const rows = db
      .prepare(
        `SELECT chunk_id FROM knowledge_chunks_fts
         WHERE knowledge_chunks_fts MATCH ? AND (${clauses.join(" OR ")})${sourceFilter}
         ORDER BY rank LIMIT ${MAX_LEXICAL_CANDIDATES}`,
      )
      .all(...args) as Array<{ chunk_id: string }>;
    return rows.map((row) => row.chunk_id);
  } catch {
    // A malformed expression or a rebuilt index must not fail the chat: fall back to vector/empty.
    return [];
  }
}

interface VectorHit {
  id: string;
  score: number;
}

interface VectorOutcome {
  hits: VectorHit[];
  /** Collections whose query vector produced at least one candidate; used for an honest per-collection mode. */
  contributed: Set<string>;
  /** Collections that are configured for vectors but produced no usable query vector. */
  degraded: Set<string>;
}

/** The pinned connection a collection may embed with, or null when it cannot be resolved right now. */
function pinnedEmbedder(collection: CollectionRow): Embedder | null {
  if (collection.embedding_provider === "none" || embeddingNeedsReindex(collection)) return null;
  const providerId = collection.embedding_provider === "compatible" ? collection.embedding_provider_id : collection.embedding_provider;
  if (!providerId) return null;
  const pin = resolvePinnedConnection(collection.user_id, providerId);
  if (!pin || pin.scope !== collection.embedding_connection_scope || pin.createdAt !== collection.embedding_connection_created_at || pin.endpointHash !== collection.embedding_endpoint_hash) return null;
  try {
    return createEmbedder(collection.user_id, {
      provider: collection.embedding_provider,
      ...(collection.embedding_provider_id ? { providerId: collection.embedding_provider_id } : {}),
      ...(collection.embedding_model ? { model: collection.embedding_model } : {}),
    }, {}, { connection: pin.connection, providerId });
  } catch {
    return null;
  }
}

async function vectorRanking(
  viewerId: string,
  collections: CollectionRow[],
  query: string,
  lexicalIds: string[],
  sourceIds: string[] | undefined,
  embedderFor: (row: CollectionRow) => Embedder | null,
  signal: AbortSignal | undefined,
): Promise<VectorOutcome> {
  const scores = new Map<string, number>();
  const queryVectors = new Map<string, Float32Array | null>();
  const contributed = new Set<string>();
  const degraded = new Set<string>();
  for (const collection of collections) {
    // Shared collections are intentionally lexical in this cycle: no embedder, no owner credentials.
    if (collection.embedding_provider === "none" || collection.user_id !== viewerId) continue;
    let embedder: Embedder | null;
    try {
      embedder = embedderFor(collection);
    } catch {
      embedder = null;
    }
    if (!embedder) {
      degraded.add(collection.id);
      continue;
    }
    const key = embeddingKey({ provider: collection.embedding_provider, providerId: collection.embedding_provider_id ?? undefined, model: collection.embedding_model ?? undefined });
    if (!queryVectors.has(key)) {
      try {
        signal?.throwIfAborted();
        const [vector] = await embedder.embed([query], signal);
        if (!vector) degraded.add(collection.id);
        queryVectors.set(key, vector ?? null);
      } catch (error) {
        // A provider outage or a revocation degrades this query to lexical; the label tells the truth.
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        // A token allowance is not an outage: the user must choose keyword-only knowledge instead.
        if (error instanceof AppError && error.code === "token_credit_unmetered") throw error;
        queryVectors.set(key, null);
      }
    }
    const queryVector = queryVectors.get(key);
    if (!queryVector) {
      degraded.add(collection.id);
      continue;
    }
    const candidates = new Map<string, Float32Array>();
    for (const entry of cachedVectors(collection.user_id, collection)) {
      // Metadata filters apply before ranking, so a requested source cannot vanish under unrelated hits.
      if (sourceIds?.length && !sourceIds.includes(entry.sourceId)) continue;
      candidates.set(entry.id, entry.vector);
    }
    // FTS found passages outside the bounded cache: their vectors are indexed and cheap to fetch.
    const missing = lexicalIds.filter((id) => !candidates.has(id) && id);
    if (missing.length) {
      const marks = missing.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT id, embedding FROM knowledge_chunks WHERE user_id = ? AND collection_id = ? AND id IN (${marks})`)
        .all(collection.user_id, collection.id, ...missing) as Array<{ id: string; embedding: Uint8Array }>;
      for (const row of rows) {
        const vector = decodeVector(row.embedding);
        if (vector) candidates.set(row.id, vector);
      }
    }
    let any = false;
    for (const [id, vector] of candidates) {
      const score = cosine(queryVector, vector);
      if (score > 0) {
        scores.set(id, Math.max(score, scores.get(id) ?? 0));
        any = true;
      }
    }
    if (any) contributed.add(collection.id);
  }
  // Merge globally by similarity before RRF: per-collection concatenation would make the first attached
  // collection win ties even when a later one has clearly better passages.
  const hits = [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, MAX_VECTOR_CANDIDATES);
  return { hits, contributed, degraded };
}

interface Fused {
  id: string;
  score: number;
  lexical: boolean;
  vector: boolean;
}

/** Reciprocal rank fusion of two ranked id lists. */
export function fuseRankings(lexical: string[], vector: string[], k = RRF_K): Fused[] {
  const fused = new Map<string, Fused>();
  const add = (id: string, rank: number, kind: "lexical" | "vector") => {
    const entry = fused.get(id) ?? { id, score: 0, lexical: false, vector: false };
    entry.score += 1 / (k + rank + 1);
    entry[kind] = true;
    fused.set(id, entry);
  };
  lexical.forEach((id, index) => add(id, index, "lexical"));
  vector.forEach((id, index) => add(id, index, "vector"));
  return [...fused.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function overlapRatio(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (overlap <= 0) return 0;
  return overlap / Math.max(1, Math.min(a.end - a.start, b.end - b.start));
}

export interface SearchOptions {
  /** The viewer: owns some collections and merely reads others. Never substituted for an owner id. */
  userId: string;
  collectionIds: readonly string[];
  query: string;
  k?: number;
  budgetTokens?: number;
  projectId?: string | null;
  sourceIds?: string[];
  signal?: AbortSignal;
  /** Tests inject a fake embedder; production resolves the collection's pinned backend. */
  embedderFor?: (collection: CollectionRow) => Embedder | null;
}

export interface RetrievalOutcome extends KnowledgeSearchResult {
  /** Collection rows that actually took part; their `user_id` is the owner/payer. */
  collectionRows: CollectionRow[];
}

/**
 * Searches readable, attached collections only. Returns at most `k` passages within the token budget, best
 * first. Authorization is resolved live before FTS, after every awaited embed call, and before returning;
 * a scope can only narrow, so a collection attached mid-call never joins it.
 */
export async function searchKnowledge(opts: SearchOptions): Promise<RetrievalOutcome> {
  // Retrieval itself is the denied action, including the query embedding it may send.
  assertFeature(opts.userId, "knowledge");
  const k = Math.max(1, Math.min(20, Math.floor(opts.k ?? DEFAULT_K)));
  const budget = Math.max(200, Math.min(12_000, Math.floor(opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS)));
  const initial = readableCollectionsForChat(opts.userId, [...new Set(opts.collectionIds)], opts.projectId ?? null);
  if (!initial.length) return { mode: "lexical", hits: [], tokens: 0, collections: [], collectionRows: [] };
  const initialIds = new Set(initial.map((row) => row.id));
  // A live lease: an audience or permission change aborts this retrieval at its next checkpoint, and the
  // caller's own signal (page close, cancel) aborts it too.
  const controller = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  const release = registerKnowledgeOperation(controller, () =>
    initial.every((row) => !!readableCollectionRow(opts.userId, row.id)));
  try {
    signal.throwIfAborted();
    const lexical = lexicalRanking(initial, opts.query, opts.sourceIds);
    signal.throwIfAborted();
    const embedderFor = opts.embedderFor ?? testEmbedder ?? ((row: CollectionRow) => (row.user_id === opts.userId ? pinnedEmbedder(row) : null));
    const vector = await vectorRanking(opts.userId, initial, opts.query, lexical, opts.sourceIds, embedderFor, signal);
    signal.throwIfAborted();
    const fused = fuseRankings(lexical, vector.hits.map((hit) => hit.id));
    const rows = loadRows(initial, fused.map((hit) => hit.id).filter(Boolean));
    const vectorScores = new Map(vector.hits.map((hit) => [hit.id, hit.score]));

    // Access can change during the awaited embed request. Narrow to rows still readable now; never add one.
    const after = new Set(readableCollectionsForChat(opts.userId, [...initialIds], opts.projectId ?? null).map((row) => row.id));
    const chosen: KnowledgeSearchHit[] = [];
    const accepted: Array<{ sourceId: string; start: number; end: number }> = [];
    let tokens = 0;
    for (const hit of fused) {
      signal.throwIfAborted();
      if (chosen.length >= k) break;
      const row = rows.get(hit.id);
      if (!row) continue;
      // A collection can be filtered out between the FTS query and the row load (a concurrent delete/revoke).
      if (!after.has(row.collection_id)) continue;
      if (opts.sourceIds?.length && !opts.sourceIds.includes(row.source_id)) continue;
      if (accepted.some((span) => span.sourceId === row.source_id && overlapRatio(span, { start: row.start, end: row.end }) > 0.35)) continue;
      if (tokens + row.tokens > budget) continue;
      tokens += row.tokens;
      accepted.push({ sourceId: row.source_id, start: row.start, end: row.end });
      chosen.push({
        collectionId: row.collection_id,
        documentId: row.source_id,
        sourceId: row.source_id,
        title: row.title || row.source_name,
        chunkId: row.id,
        offset: row.start,
        end: row.end,
        url: row.source_kind === "url" ? row.source_url ?? undefined : undefined,
        text: row.text,
        score: Number((hit.score + (vectorScores.get(hit.id) ?? 0) * 0.01).toFixed(6)),
        via: hit.lexical && hit.vector ? "both" : hit.vector ? "vector" : "lexical",
      });
    }
    const contributingShare = new Set(chosen.map((hit) => hit.collectionId));
    const outcome = initial.filter((row) => after.has(row.id)).map((row): KnowledgeSearchCollectionOutcome => {
      if (row.user_id !== opts.userId || row.embedding_provider === "none") {
        return { collectionId: row.id, mode: "lexical", degraded: false, reason: row.embedding_provider === "none" ? "not_configured" : "shared_lexical" };
      }
      if (embeddingNeedsReindex(row)) return { collectionId: row.id, mode: "lexical", degraded: true, reason: "reindex_required" };
      if (vector.degraded.has(row.id)) return { collectionId: row.id, mode: "lexical", degraded: true, reason: "embedding_unavailable" };
      if (vector.contributed.has(row.id) && contributingShare.has(row.id)) return { collectionId: row.id, mode: "hybrid", degraded: false, reason: null };
      return { collectionId: row.id, mode: "lexical", degraded: false, reason: null };
    });
    const hybrid = outcome.some((entry) => entry.mode === "hybrid");
    // Recheck the whole result just before release; a revoked collection drops its passages and tokens.
    const final = new Set(readableCollectionsForChat(opts.userId, [...initialIds], opts.projectId ?? null).map((row) => row.id));
    const hits = chosen.filter((hit) => final.has(hit.collectionId));
    const finalTokens = hits.reduce((sum, hit) => sum + (rows.get(hit.chunkId)?.tokens ?? 0), 0);
    return {
      mode: (hybrid ? "hybrid" : "lexical") as KnowledgeRetrievalMode,
      degraded: outcome.some((entry) => entry.degraded),
      hits,
      tokens: finalTokens,
      collections: outcome.filter((entry) => final.has(entry.collectionId)),
      collectionRows: initial.filter((row) => final.has(row.id)),
    };
  } finally {
    release();
  }
}
