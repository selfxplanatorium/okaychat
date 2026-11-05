import type { KnowledgeRetrievalMode, KnowledgeSearchHit, KnowledgeSearchResult } from "../../shared/knowledge.js";
import { db } from "../db.js";
import { cosine, createEmbedder, decodeVector, embeddingKey, type Embedder } from "./embeddings.js";
import { getCollectionRow, type CollectionRow } from "./store.js";
import { assertFeature } from "../permissions/guard.js";

// Hybrid retrieval: FTS5 BM25 over chunks and cosine over normalized embeddings, fused with reciprocal
// rank fusion. Vectors are never scanned table-wide per query: the per-collection cache is bounded and
// keyed by `vectors_revision`, and FTS supplies a small prefiltered candidate set. When a collection has
// no embeddings (or the provider fails), the result is labelled lexical rather than pretending otherwise.

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

function loadRows(userId: string, ids: string[]): Map<string, ChunkHitRow> {
  const out = new Map<string, ChunkHitRow>();
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const marks = batch.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT c.id, c.source_id, c.collection_id, c.title, c.start, c."end", c.text, c.tokens,
          s.name AS source_name, s.kind AS source_kind, s.url AS source_url
         FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id
         WHERE c.user_id = ? AND c.id IN (${marks})`,
      )
      .all(userId, ...batch) as unknown as ChunkHitRow[];
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

function lexicalRanking(userId: string, collections: CollectionRow[], query: string, sourceIds?: string[]): string[] {
  const match = ftsExpression(query);
  if (!match || !collections.length) return [];
  const marks = collections.map(() => "?").join(",");
  const sourceFilter = sourceIds?.length ? ` AND source_id IN (${sourceIds.map(() => "?").join(",")})` : "";
  try {
    const rows = db
      .prepare(
        `SELECT chunk_id FROM knowledge_chunks_fts
         WHERE knowledge_chunks_fts MATCH ? AND user_id = ? AND collection_id IN (${marks})${sourceFilter}
         ORDER BY rank LIMIT ${MAX_LEXICAL_CANDIDATES}`,
      )
      .all(match, userId, ...collections.map((c) => c.id), ...(sourceIds ?? [])) as Array<{ chunk_id: string }>;
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
  /** An embedding setting exists but no query vector could be produced. */
  degraded: boolean;
}

async function vectorRanking(
  userId: string,
  collections: CollectionRow[],
  query: string,
  lexicalIds: string[],
  sourceIds: string[] | undefined,
  embedderFor: (row: CollectionRow) => Embedder | null,
): Promise<VectorOutcome> {
  const scores = new Map<string, number>();
  const queryVectors = new Map<string, Float32Array | null>();
  let degraded = false;
  for (const collection of collections) {
    let embedder: Embedder | null;
    try {
      embedder = embedderFor(collection);
    } catch {
      embedder = null;
    }
    if (!embedder) {
      if (collection.embedding_provider !== "none") degraded = true;
      continue;
    }
    const key = embeddingKey({ provider: collection.embedding_provider, providerId: collection.embedding_provider_id ?? undefined, model: collection.embedding_model ?? undefined });
    if (!queryVectors.has(key)) {
      try {
        const [vector] = await embedder.embed([query]);
        if (!vector) degraded = true;
        queryVectors.set(key, vector ?? null);
      } catch {
        // A provider outage degrades this query to lexical; the label tells the truth.
        queryVectors.set(key, null);
        degraded = true;
      }
    }
    const queryVector = queryVectors.get(key);
    if (!queryVector) {
      degraded = true;
      continue;
    }
    const candidates = new Map<string, Float32Array>();
    for (const entry of cachedVectors(userId, collection)) {
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
        .all(userId, collection.id, ...missing) as Array<{ id: string; embedding: Uint8Array }>;
      for (const row of rows) {
        const vector = decodeVector(row.embedding);
        if (vector) candidates.set(row.id, vector);
      }
    }
    for (const [id, vector] of candidates) {
      const score = cosine(queryVector, vector);
      if (score > 0) scores.set(id, Math.max(score, scores.get(id) ?? 0));
    }
  }
  // Merge globally by similarity before RRF: per-collection concatenation would make the first attached
  // collection win ties even when a later one has clearly better passages.
  const hits = [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, MAX_VECTOR_CANDIDATES);
  return { hits, degraded };
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
  userId: string;
  collectionIds: readonly string[];
  query: string;
  k?: number;
  budgetTokens?: number;
  projectId?: string | null;
  sourceIds?: string[];
  /** Tests inject a fake embedder; production resolves the collection's chosen backend. */
  embedderFor?: (collection: CollectionRow) => Embedder | null;
}

export interface RetrievalOutcome extends KnowledgeSearchResult {
  /** Collections that actually took part, after ownership/project filtering. */
  collections: CollectionRow[];
}

/**
 * Searches attached, accessible collections only. Returns at most `k` passages within the token budget,
 * best first, with overlapping passages from the same document collapsed to the better one.
 */
export async function searchKnowledge(opts: SearchOptions): Promise<RetrievalOutcome> {
  // Retrieval itself is the denied action, including the query embedding it may send.
  assertFeature(opts.userId, "knowledge");
  const k = Math.max(1, Math.min(20, Math.floor(opts.k ?? DEFAULT_K)));
  const budget = Math.max(200, Math.min(12_000, Math.floor(opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS)));
  const collections = [...new Set(opts.collectionIds)]
    .map((id) => getCollectionRow(opts.userId, id))
    .filter((row): row is CollectionRow => !!row)
    .filter((row) => row.project_id === null || row.project_id === (opts.projectId ?? null));
  if (!collections.length) return { mode: "lexical", hits: [], tokens: 0, collections };

  const lexical = lexicalRanking(opts.userId, collections, opts.query, opts.sourceIds);
  const embedderFor = opts.embedderFor ?? testEmbedder ?? ((row: CollectionRow) => {
    try {
      return createEmbedder(opts.userId, {
        provider: row.embedding_provider,
        providerId: row.embedding_provider_id ?? undefined,
        model: row.embedding_model ?? undefined,
      });
    } catch {
      return null;
    }
  });
  const vector = await vectorRanking(opts.userId, collections, opts.query, lexical, opts.sourceIds, embedderFor);
  const fused = fuseRankings(lexical, vector.hits.map((hit) => hit.id));
  const rows = loadRows(opts.userId, fused.map((hit) => hit.id).filter(Boolean));
  const vectorScores = new Map(vector.hits.map((hit) => [hit.id, hit.score]));

  const chosen: KnowledgeSearchHit[] = [];
  const accepted: Array<{ sourceId: string; start: number; end: number }> = [];
  let tokens = 0;
  for (const hit of fused) {
    if (chosen.length >= k) break;
    const row = rows.get(hit.id);
    if (!row) continue;
    // A collection can be filtered out between the FTS query and the row load (a concurrent delete).
    if (!collections.some((collection) => collection.id === row.collection_id)) continue;
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
  const mode: KnowledgeRetrievalMode = vector.hits.length ? "hybrid" : "lexical";
  return { mode, degraded: vector.degraded, hits: chosen, tokens, collections };
}
