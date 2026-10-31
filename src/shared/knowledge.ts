// Knowledge collections, sources, chunks, retrieval, and citations. Shared by the server and the web
// app; keep this module free of runtime imports (it is erased at build time).

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
  createdAt: number;
  updatedAt: number;
}

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

export interface KnowledgeSearchResult {
  mode: KnowledgeRetrievalMode;
  hits: KnowledgeSearchHit[];
  tokens: number;
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
}

export interface KnowledgeCollectionsResponse {
  collections: KnowledgeCollection[];
  embedding: KnowledgeEmbeddingOption[];
}

export interface KnowledgeCollectionDetail {
  collection: KnowledgeCollection;
  sources: KnowledgeSource[];
}
