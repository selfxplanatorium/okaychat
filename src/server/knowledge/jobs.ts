import { HTTPException } from "hono/http-exception";
import { redactSecrets } from "../errors.js";
import { db } from "../db.js";
import { extract } from "../files.js";
import { chunkDocument } from "./chunker.js";
import { createEmbedder, EmbeddingError, type Embedder } from "./embeddings.js";
import { invalidateKnowledgeVectors } from "./retrieval.js";
import {
  failSource,
  getCollectionRow,
  KnowledgeInputError,
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
  /** The source generation this queued work belongs to; a newer generation supersedes it. */
  generation: number;
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
/** Generation of the job in `running`, so a superseding retry can tell it is stale. */
const runningGenerations = new Map<string, number>();
/** One job per collection at a time; different collections of one account may run in parallel. */
const runningCollections = new Set<string>();
const perUser = new Map<string, number>();
const inflight = new Set<Promise<void>>();
const RESUMED_BATCH = 500;
/** Keyset cursor for unfinished rows at startup; batches load as the queue drains, with no idle timer. */
let resumeCursor: { createdAt: number; id: string } | null = null;

const activeStatus = (status: string) => status === "queued" || status === "extracting" || status === "embedding";

function capacity(userId: string): boolean {
  if (running.size >= MAX_JOBS_TOTAL) return false;
  return (perUser.get(userId) ?? 0) < MAX_JOBS_PER_USER;
}

function take(): Job | undefined {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i]!;
    const row = sourceRow(job.userId, job.sourceId);
    // Cancelled, failed, ready, or superseded work must leave the queue instead of waiting forever.
    if (!row || !activeStatus(row.status) || row.generation !== job.generation) {
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

/** Loads the next batch of unfinished rows found at startup, moving the keyset forward once per call. */
function refillResumeQueue(): number {
  if (!resumeCursor) return 0;
  const rows = db
    .prepare(
      `SELECT id, user_id, collection_id, generation, created_at FROM knowledge_sources
       WHERE status IN ('queued', 'extracting', 'embedding') AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at, id LIMIT ${RESUMED_BATCH}`,
    )
    .all(resumeCursor.createdAt, resumeCursor.createdAt, resumeCursor.id) as Array<{ id: string; user_id: string; collection_id: string; generation: number; created_at: number }>;
  if (!rows.length) {
    resumeCursor = null;
    return 0;
  }
  const last = rows[rows.length - 1]!;
  resumeCursor = rows.length < RESUMED_BATCH ? null : { createdAt: last.created_at, id: last.id };
  for (const row of rows) {
    if (running.has(row.id) || queue.some((job) => job.sourceId === row.id)) continue;
    queue.push({ sourceId: row.id, userId: row.user_id, collectionId: row.collection_id, generation: row.generation });
  }
  return rows.length;
}

function pump() {
  for (;;) {
    const job = take();
    if (!job) {
      // Startup recovery is paginated, so more than one batch of pending rows still drains.
      if (refillResumeQueue()) continue;
      return;
    }
    perUser.set(job.userId, (perUser.get(job.userId) ?? 0) + 1);
    runningCollections.add(job.collectionId);
    const controller = new AbortController();
    running.set(job.sourceId, controller);
    runningGenerations.set(job.sourceId, job.generation);
    const task = runJob(job, controller)
      .catch(() => {})
      .finally(() => {
        if (running.get(job.sourceId) === controller) {
          running.delete(job.sourceId);
          runningGenerations.delete(job.sourceId);
        }
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
  const source = sourceRow(userId, sourceId);
  if (!source || !activeStatus(source.status)) return;
  const runningGeneration = runningGenerations.get(sourceId);
  if (running.has(sourceId)) {
    // Same generation: the running job already covers this request. A newer one must abort it and
    // queue exactly one replacement, which starts only after the old job releases its slot.
    if (runningGeneration === source.generation) return;
    running.get(sourceId)?.abort();
  }
  // Drop any queued entry for this source, including one for a superseded generation.
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.sourceId === sourceId) {
      if (queue[i]!.generation === source.generation) return;
      queue.splice(i, 1);
    }
  }
  queue.push({ sourceId, userId, collectionId: source.collection_id, generation: source.generation });
  pump();
}

export function enqueueSources(userId: string, sourceIds: readonly string[]) {
  for (const id of sourceIds) enqueueSource(userId, id);
}

/** Aborts the job and marks the row cancelled unless it already finished. */
export function cancelSourceIngestion(userId: string, sourceId: string): boolean {
  // Ownership first: a forged id from another account must not abort that account's running job.
  const row = sourceRow(userId, sourceId);
  if (!row) return false;
  const controller = running.get(sourceId);
  controller?.abort();
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.sourceId === sourceId) queue.splice(i, 1);
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
  resumeCursor = { createdAt: 0, id: "" };
  const count = refillResumeQueue();
  pump();
  return count;
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

/** Pasted and fetched text skips extraction, so the readability check runs on every source's text. */
function readable(text: string): string {
  // A decoded binary usually has NULs or a very high replacement-character rate; FTS stops at a NUL.
  const sample = text.slice(0, 20_000);
  if (text.includes("\u0000") || (sample.match(/\uFFFD/g)?.length ?? 0) > sample.length * 0.02) {
    throw new KnowledgeInputError("This file does not contain readable text. Use a text, PDF, DOCX, or spreadsheet file.");
  }
  return text;
}

async function extractSource(row: SourceRow): Promise<string> {
  if (row.text) return readable(row.text);
  if (!row.upload_id) throw new KnowledgeInputError("The original file is gone. Add it again.");
  const upload = db.prepare("SELECT name, mime, data FROM uploads WHERE id = ? AND user_id = ?").get(row.upload_id, row.user_id) as
    | { name: string; mime: string; data: Uint8Array }
    | undefined;
  if (!upload) throw new KnowledgeInputError("The original file is gone. Add it again.");
  if (/^image\//.test(upload.mime)) throw new KnowledgeInputError("Images are not supported yet: this build has no OCR for them. Add a text, PDF, DOCX, or spreadsheet file instead.");
  const { text } = await extract(upload.name, upload.mime, upload.data);
  if (text.startsWith("[This PDF has no text layer")) {
    throw new KnowledgeInputError("This PDF has no text layer (it is probably scanned images). No OCR is available; add a text version instead.");
  }
  if (!text.trim()) throw new KnowledgeInputError("No text could be read from this file.");
  return readable(text);
}

const isSuperseded = (error: unknown) => error instanceof DOMException && error.message === "Superseded";

/** Only messages this module or the embedder wrote are stored; anything else is logged and replaced. */
function ingestFailureMessage(error: unknown): string {
  if (error instanceof KnowledgeInputError || error instanceof EmbeddingError || error instanceof HTTPException) return error.message;
  if (error instanceof DOMException && error.name === "TimeoutError") return "The embedding provider did not respond in time.";
  console.error("[knowledge] ingest failed", redactSecrets(String((error as Error)?.stack ?? error)).slice(0, 500));
  return "Ingestion failed.";
}

async function runJob(job: Job, controller: AbortController) {
  const { userId, sourceId } = job;
  const signal = controller.signal;
  const row = sourceRow(userId, sourceId);
  if (!row || row.generation !== job.generation || !activeStatus(row.status)) return;
  const generation = job.generation;
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
    if (!chunks.length) throw new KnowledgeInputError("The source has no readable text to index.");
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
        if (vectors.length !== slice.length) throw new EmbeddingError("The embedding provider returned the wrong number of vectors.");
        if (dimensions === null) dimensions = vectors[0]!.length;
        if (vectors.some((vector) => vector.length !== dimensions)) throw new EmbeddingError("The embedding provider returned vectors with different dimensions.");
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
    // Only this job's own signal (cancel, delete, or a newer generation) means the user stopped it. A provider
    // timeout also throws an AbortError-type error, but it is a failure the user must see.
    if (signal.aborted || isSuperseded(error)) {
      // cancelSourceIngestion already marked the row; a delete or reindex removed it.
      const current = sourceRow(userId, sourceId);
      if (current && current.generation === generation && current.status !== "ready") {
        db.prepare("UPDATE knowledge_sources SET status = 'cancelled', progress = 0, updated_at = ? WHERE user_id = ? AND id = ? AND generation = ?")
          .run(Date.now(), userId, sourceId, generation);
      }
      return;
    }
    failSource(userId, sourceId, generation, ingestFailureMessage(error));
    markCollectionStatus(userId, collection.id, "failed");
  }
}
