// Knowledge collections, sources, chunks, retrieval, and citations. Shared by the server and the web
// app; keep this module free of runtime imports (it is erased at build time).
import type { ShareAudience } from "./types.js";

/** A retrieval embedding backend. `none` means lexical (BM25) retrieval only. */
export type KnowledgeEmbeddingProvider = "none" | "openai" | "google" | "ollama" | "compatible";

export interface KnowledgeEmbeddingSetting {
  provider: KnowledgeEmbeddingProvider;
  /** The provider connection to use. Required for `compatible`; ignored for `none`. */
  providerId?: string;
  model?: string;
}

/** One selectable embedding backend, derived from the account's connected providers. */
export interface KnowledgeEmbeddingOption {
  provider: KnowledgeEmbeddingProvider;
  providerId?: string;
  /** Default model for this backend. The user may change it when creating a collection. */
  model?: string;
  /** Backend label, e.g. "OpenAI" or a custom endpoint name. */
  label: string;
}

export type KnowledgeCollectionStatus = "empty" | "processing" | "ready" | "failed";

export type KnowledgeVisibility = "private" | "shared";

/**
 * Why retrieval is what it is. `null` means the owner's configured embedding connection is working.
 * `shared_lexical` is intentional for another account's collection: reader queries never spend the
 * owner's credentials or embedding budget in this cycle.
 */
export type KnowledgeRetrievalReason =
  | "not_configured"
  | "shared_lexical"
  | "embedding_unavailable"
  | "reindex_required"
  | null;

export interface KnowledgeCollectionCapability {
  mode: "hybrid" | "lexical";
  reason: KnowledgeRetrievalReason;
}

export interface KnowledgeCollection {
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  embedding: KnowledgeEmbeddingSetting;
  status: KnowledgeCollectionStatus;
  sourceCount: number;
  chunkCount: number;
  /** Originals, extracted text, chunks, and vectors owned by this collection. */
  bytes: number;
  createdAt: number;
  updatedAt: number;
}

/** A collection the viewer owns. Embedding configuration, audience, and payer details are owner-only. */
export interface KnowledgeOwnedCollection extends KnowledgeCollection {
  access: "owner";
  visibility: KnowledgeVisibility;
  accessRevision: number;
  /** `null` while private. */
  audience: ShareAudience | null;
  retrieval: KnowledgeCollectionCapability;
  /** A non-lexical collection whose stored connection pin no longer matches; an explicit reindex binds it. */
  embeddingNeedsReindex: boolean;
}

/** Another account's shared collection, reduced to what a reader needs. Never carries owner secrets. */
export interface KnowledgeSharedCollection {
  id: string;
  name: string;
  description: string;
  status: KnowledgeCollectionStatus;
  sourceCount: number;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
  access: "reader";
  visibility: "shared";
  owner: { id: string; displayName: string | null };
  retrieval: KnowledgeCollectionCapability;
}

export type KnowledgeCollectionView = KnowledgeOwnedCollection | KnowledgeSharedCollection;

export type KnowledgeSourceKind = "file" | "paste" | "url";

export type KnowledgeSourceStatus = "queued" | "extracting" | "embedding" | "ready" | "failed" | "cancelled";

export interface KnowledgeSource {
  id: string;
  collectionId: string;
  name: string;
  kind: KnowledgeSourceKind;
  /** Only set for URL sources. */
  url: string | null;
  mime: string;
  /** Original bytes charged as an upload. */
  bytes: number;
  /** Extracted characters. */
  textBytes: number;
  status: KnowledgeSourceStatus;
  /** 0–1. */
  progress: number;
  error: string | null;
  chunkCount: number;
  /** How the text was obtained; null for pasted text, older rows, or a source that never extracted. */
  extraction: KnowledgeExtraction | null;
  createdAt: number;
  updatedAt: number;
}

export type KnowledgeExtraction = "text" | "ocr";
export type KnowledgeOcrReason = "ok" | "not_configured" | "unavailable";
export interface KnowledgeOcrCapability {
  available: boolean;
  reason: KnowledgeOcrReason;
}
/** What this server can ingest beyond plain extraction. OCR depends on the code sandbox, not the account's code feature. */
export interface KnowledgeCapabilities {
  ocr: KnowledgeOcrCapability;
}

/** What a reader may see about a source: no progress, error, mime, bytes, URL, upload id, or text. */
export type KnowledgeSourceSummary = Pick<
  KnowledgeSource,
  "id" | "collectionId" | "name" | "kind" | "status" | "chunkCount" | "createdAt" | "updatedAt"
>;

export interface KnowledgeChunk {
  id: string;
  sourceId: string;
  ordinal: number;
  title: string;
  /** Character offsets into the source's extracted text. */
  start: number;
  end: number;
  text: string;
  tokens: number;
}

/** The stable marker a reply uses to point at a passage. */
export interface KnowledgeCitation {
  collectionId: string;
  documentId: string;
  title: string;
  chunkId: string;
  /** Character offset of the passage in the extracted document text. */
  offset: number;
  url?: string;
}

export interface KnowledgeSearchHit extends KnowledgeCitation {
  sourceId: string;
  text: string;
  end: number;
  score: number;
  /** Which ranking supplied the hit; kept for debugging and honest labels. */
  via: "lexical" | "vector" | "both";
}

export type KnowledgeRetrievalMode = "hybrid" | "lexical";

/** One collection's actual outcome for this query, so a hybrid label cannot imply vectors for shared rows. */
export interface KnowledgeSearchCollectionOutcome {
  collectionId: string;
  mode: KnowledgeRetrievalMode;
  degraded: boolean;
  reason: KnowledgeRetrievalReason;
}

export interface KnowledgeSearchResult {
  mode: KnowledgeRetrievalMode;
  hits: KnowledgeSearchHit[];
  tokens: number;
  /**
   * At least one attached collection has an embedding setting but produced no query vector (missing
   * connection, provider error, or timeout). The label stays `lexical` when no vectors were available.
   */
  degraded?: boolean;
  /** Per-collection outcome; recomputed after access filtering. */
  collections: KnowledgeSearchCollectionOutcome[];
}

/** One source passage shown in the citation panel. */
export interface KnowledgePassage {
  chunk: KnowledgeChunk;
  source: Pick<KnowledgeSource, "id" | "name" | "kind" | "url" | "collectionId">;
  collection: Pick<KnowledgeCollection, "id" | "name" | "projectId">;
}

/** A collection attached to a chat, as the composer and per-turn context show it. */
export interface KnowledgeAttachment {
  id: string;
  name: string;
  access: "owner" | "reader";
  visibility: KnowledgeVisibility;
}

export interface KnowledgeCollectionsResponse {
  collections: KnowledgeCollectionView[];
  embedding: KnowledgeEmbeddingOption[];
  nextCursor: string | null;
}

export type KnowledgeCollectionDetail =
  | { collection: KnowledgeOwnedCollection; sources: KnowledgeSource[] }
  | { collection: KnowledgeSharedCollection; sources: KnowledgeSourceSummary[] };

/** Minimal directory entry for the sharing dialog. Never carries an email, member list, or count. */
export interface KnowledgeAudienceTarget {
  id: string;
  label: string;
}
