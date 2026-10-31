import { db } from "../db.js";
import { extract } from "../files.js";
import { chunkDocument } from "./chunker.js";
import { createEmbedder, type Embedder } from "./embeddings.js";
import { invalidateKnowledgeVectors } from "./retrieval.js";
import {
  failSource,
  getCollectionRow,
  markCollectionStatus,
  replaceChunks,
  setSourceProgress,
  setSourceText,
  sourceRow,
  type CollectionRow,
  type SourceRow,
} from "./store.js";

// In-process ingestion queue. Rows carry the state (`queued|extracting|embedding|ready|failed|cancelled`),
// so a restart resumes by re-enqueuing unfinished rows instead of keeping a timer busy. A generation
// counter per source invalidates writes from a superseded retry, reindex, cancel, or delete.
// docs/implementation/knowledge.md

/** Two ingests per account and three overall keeps embed calls and PDF parsing bounded. */
export const MAX_JOBS_PER_USER = 2;
export const MAX_JOBS_TOTAL = 3;
/** Embed progress is reported in slices so a long document shows movement without holding all batches. */
const EMBED_SLICE = 64;

interface Job {
  sourceId: string;
  userId: string;
  collectionId: string;
}

type EmbedderFactory = (userId: string, collection: CollectionRow) => Embedder | null;

const embedderFactory: EmbedderFactory = (userId, collection) =>
  createEmbedder(userId, {
    provider: collection.embedding_provider,
    providerId: collection.embedding_provider_id ?? undefined,
    model: collection.embedding_model ?? undefined,
  });

let factory: EmbedderFactory = embedderFactory;
/** Tests replace the provider; production never calls this. */
export function setEmbedderFactoryForTests(next: EmbedderFactory | null) {
  factory = next ?? embedderFactory;
}

const queue: Job[] = [];
const running = new Map<string, AbortController>();
/** One job per collection at a time; different collections of one account may run in parallel. */
const runningCollections = new Set<string>();
const perUser = new Map<string, number>();
const inflight = new Set<Promise<void>>();

const isAbort = (error: unknown) => error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError" || (error as { cause?: { name?: string } }).cause?.name === "AbortError");

function capacity(userId: string): boolean {
  if (running.size >= MAX_JOBS_TOTAL) return false;
  return (perUser.get(userId) ?? 0) < MAX_JOBS_PER_USER;
}

function take(): Job | undefined {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i]!;
    if (!sourceRow(job.userId, job.sourceId)) {
      queue.splice(i, 1);
      i--;
      continue;
    }
    if (running.has(job.sourceId) || runningCollections.has(job.collectionId)) continue;
    if (!capacity(job.userId)) continue;
    return queue.splice(i, 1)[0];
  }
  return undefined;
}

function pump() {
  for (;;) {
    const job = take();
    if (!job) return;
    perUser.set(job.userId, (perUser.get(job.userId) ?? 0) + 1);
    runningCollections.add(job.collectionId);
    const controller = new AbortController();
    running.set(job.sourceId, controller);
    const task = runJob(job, controller)
      .catch(() => {})
      .finally(() => {
        running.delete(job.sourceId);
        runningCollections.delete(job.collectionId);
        const left = (perUser.get(job.userId) ?? 1) - 1;
        if (left > 0) perUser.set(job.userId, left);
        else perUser.delete(job.userId);
        inflight.delete(task);
        pump();
      });
    inflight.add(task);
  }
}

export function enqueueSource(userId: string, sourceId: string) {
  if (running.has(sourceId) || queue.some((job) => job.sourceId === sourceId)) return;
  const source = sourceRow(userId, sourceId);
  if (!source) return;
  queue.push({ sourceId, userId, collectionId: source.collection_id });
  pump();
}

export function enqueueSources(userId: string, sourceIds: readonly string[]) {
  for (const id of sourceIds) enqueueSource(userId, id);
}

/** Aborts the job and marks the row cancelled unless it already finished. */
export function cancelSourceIngestion(userId: string, sourceId: string): boolean {
  const controller = running.get(sourceId);
  controller?.abort();
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.sourceId === sourceId) queue.splice(i, 1);
  const row = sourceRow(userId, sourceId);
  if (!row) return false;
  const result = db
    .prepare("UPDATE knowledge_sources SET status = 'cancelled', progress = 0, generation = generation + 1, updated_at = ? WHERE user_id = ? AND id = ? AND status IN ('queued', 'extracting', 'embedding')")
    .run(Date.now(), userId, sourceId);
  return Number(result.changes) > 0;
}

export function cancelCollectionIngestion(userId: string, collectionId: string) {
  const rows = db.prepare("SELECT id FROM knowledge_sources WHERE user_id = ? AND collection_id = ? AND status IN ('queued', 'extracting', 'embedding')").all(userId, collectionId) as Array<{ id: string }>;
  for (const row of rows) cancelSourceIngestion(userId, row.id);
}

/** Called at startup. Rows keep their state, so nothing is lost when the process stopped mid-ingest. */
export function resumeKnowledgeIngestion() {
  const rows = db
    .prepare("SELECT id, user_id, collection_id FROM knowledge_sources WHERE status IN ('queued', 'extracting', 'embedding') ORDER BY created_at LIMIT 500")
    .all() as Array<{ id: string; user_id: string; collection_id: string }>;
  for (const row of rows) {
    if (running.has(row.id) || queue.some((job) => job.sourceId === row.id)) continue;
    queue.push({ sourceId: row.id, userId: row.user_id, collectionId: row.collection_id });
  }
  pump();
  return rows.length;
}

/** Tests wait for the queue to empty without polling a timer. */
export async function drainKnowledgeJobs() {
  while (inflight.size || queue.length) {
    if (!inflight.size) {
      pump();
      continue;
    }
    await Promise.allSettled([...inflight]);
  }
}

function abortIfStale(userId: string, sourceId: string, generation: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const row = sourceRow(userId, sourceId);
  if (!row || row.generation !== generation) throw new DOMException("Superseded", "AbortError");
}

async function extractSource(row: SourceRow): Promise<string> {
  if (row.text) return row.text;
  if (!row.upload_id) throw new Error("The original file is gone. Add it again.");
  const upload = db.prepare("SELECT name, mime, data FROM uploads WHERE id = ? AND user_id = ?").get(row.upload_id, row.user_id) as
    | { name: string; mime: string; data: Uint8Array }
    | undefined;
  if (!upload) throw new Error("The original file is gone. Add it again.");
  if (/^image\//.test(upload.mime)) throw new Error("Images are not supported yet: this build has no OCR for them. Add a text, PDF, DOCX, or spreadsheet file instead.");
  const { text } = await extract(upload.name, upload.mime, upload.data);
  if (text.startsWith("[This PDF has no text layer")) {
    throw new Error("This PDF has no text layer (it is probably scanned images). No OCR is available; add a text version instead.");
  }
  if (!text.trim()) throw new Error("No text could be read from this file.");
  // A decoded binary usually has NULs or a very high replacement-character rate.
  const sample = text.slice(0, 20_000);
  if (sample.includes("\u0000") || (sample.match(/\uFFFD/g)?.length ?? 0) > sample.length * 0.02) {
    throw new Error("This file does not contain readable text. Use a text, PDF, DOCX, or spreadsheet file.");
  }
  return text;
}

async function runJob(job: Job, controller: AbortController) {
  const { userId, sourceId } = job;
  const signal = controller.signal;
  const row = sourceRow(userId, sourceId);
  if (!row) return;
  const generation = row.generation;
  const collection = getCollectionRow(userId, row.collection_id);
  if (!collection) return;
  setSourceProgress(userId, sourceId, generation, "extracting", 0.04);
  markCollectionStatus(userId, collection.id, "processing");
  try {
    abortIfStale(userId, sourceId, generation, signal);
    const text = await extractSource(row);
    abortIfStale(userId, sourceId, generation, signal);
    if (!setSourceText(userId, sourceId, generation, text)) return;

    const chunks = chunkDocument(text, { sourceId, title: row.name });
    if (!chunks.length) throw new Error("The source has no readable text to index.");
    const current = sourceRow(userId, sourceId);
    if (!current) return;
    const embedder = current.status === "embedding" && collection.embedding_provider !== "none" ? factory(userId, collection) : null;
    let dimensions: number | null = null;
    const stored: Array<{ chunk: (typeof chunks)[number]; vector: Float32Array | null }> = [];
    if (embedder) {
      for (let i = 0; i < chunks.length; i += EMBED_SLICE) {
        abortIfStale(userId, sourceId, generation, signal);
        const slice = chunks.slice(i, i + EMBED_SLICE);
        const vectors = await embedder.embed(slice.map((chunk) => chunk.text), signal);
        if (vectors.length !== slice.length) throw new Error("The embedding provider returned the wrong number of vectors.");
        if (dimensions === null) dimensions = vectors[0]!.length;
        if (vectors.some((vector) => vector.length !== dimensions)) throw new Error("The embedding provider returned vectors with different dimensions.");
        for (let j = 0; j < slice.length; j++) stored.push({ chunk: slice[j]!, vector: vectors[j]! });
        const done = Math.min(chunks.length, i + slice.length) / chunks.length;
        setSourceProgress(userId, sourceId, generation, "embedding", 0.55 + done * 0.4);
      }
    } else {
      for (const chunk of chunks) stored.push({ chunk, vector: null });
    }
    abortIfStale(userId, sourceId, generation, signal);
    const written = replaceChunks(userId, sourceId, generation, collection.id, stored, dimensions);
    if (written) invalidateKnowledgeVectors(collection.id);
  } catch (error) {
    if (isAbort(error) || signal.aborted) {
      // cancelSourceIngestion already marked the row; a delete or reindex removed it.
      const current = sourceRow(userId, sourceId);
      if (current && current.generation === generation && current.status !== "ready") {
        db.prepare("UPDATE knowledge_sources SET status = 'cancelled', progress = 0, updated_at = ? WHERE user_id = ? AND id = ? AND generation = ?")
          .run(Date.now(), userId, sourceId, generation);
      }
      return;
    }
    failSource(userId, sourceId, generation, (error as Error).message || "Ingestion failed.");
    markCollectionStatus(userId, collection.id, "failed");
  }
}
