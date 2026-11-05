import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { ToolSet } from "ai";
import { strToU8, zipSync } from "fflate";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-knowledge-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "knowledge-test-secret-only-not-for-production";
// OCR and the capabilities route depend on the sandbox configuration; these tests run without one.
delete process.env.OKAYCHAT_SANDBOX_URL;
delete process.env.OKAYCHAT_SANDBOX_TOKEN;
const { db } = await import("../db.js");
const { requireUser } = await import("../auth.js");
const { sha256 } = await import("../crypto.js");
const { storageUsed } = await import("../quota.js");
const { handleAppError } = await import("../errors.js");
const { ensureThread, updateThread } = await import("../threads.js");
const { knowledgeRoutes } = await import("./routes.js");
const { attachedCollectionIds, conversationKnowledge, knowledgeTools } = await import("./tools.js");
const { drainKnowledgeJobs, resumeKnowledgeIngestion, setEmbedderFactoryForTests, setOcrExtractorForTests } = await import("./jobs.js");
const { chunkRow, createCollection, createSource, deleteCollection, requeueSource, sourceRow, replaceChunks } = await import("./store.js");
const { searchKnowledge, setRetrievalEmbedderFactoryForTests, fuseRankings, VECTOR_CACHE_LIMIT } = await import("./retrieval.js");
const { saveTurnContext, storedTurnContexts } = await import("../turn-context.js");
const { EmbeddingError, normalizeVector } = await import("./embeddings.js");
const { fileRoutes, storeUpload } = await import("../files.js");
const { MAX_URL_BYTES, setKnowledgeUrlFetchForTests } = await import("./url.js");

const app = new Hono().use(requireUser).onError(handleAppError).route("/knowledge", knowledgeRoutes).route("/", fileRoutes);
for (const [id, role] of [["alice", "user"], ["bob", "user"]] as const) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", role, Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(`${id}-session`), id, Date.now() + 600_000);
}

after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => {
  setEmbedderFactoryForTests(null);
  setRetrievalEmbedderFactoryForTests(null);
  setKnowledgeUrlFetchForTests(null);
  setOcrExtractorForTests(null);
  db.exec(`DELETE FROM knowledge_chunks; DELETE FROM knowledge_sources; DELETE FROM knowledge_collections;
    DELETE FROM turn_context; DELETE FROM messages; DELETE FROM threads; DELETE FROM uploads; DELETE FROM media; DELETE FROM projects;`);
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p1', 'alice', 'Atlas', 1), ('p2', 'alice', 'Other', 1), ('pb', 'bob', 'Bob', 1)").run();
  // A non-lexical collection pins the connection that will produce its vectors; these tests use an
  // injected provider, so the row only needs to exist with a stable identity for the pin.
  for (const user of ["alice", "bob"]) {
    db.prepare("INSERT OR REPLACE INTO provider_connections (user_id, provider_id, api_key_enc, base_url, config_json, enabled, created_at) VALUES (?, 'openai', NULL, NULL, '{}', 1, 1)").run(user);
  }
  ensureThread("alice", "thread-1", null);
  ensureThread("alice", "thread-p1", "p1");
  ensureThread("bob", "bob-thread", null);
});

const request = (method: string, route = "", body?: unknown, user = "alice") =>
  app.request(`http://app/knowledge${route}`, {
    method,
    headers: { cookie: `okaychat_session=${user}-session`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function create(embedding = { provider: "none" }, user = "alice", extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request("POST", "/collections", { name: `Collection ${Math.random().toString(36).slice(2, 8)}`, embedding, ...extra }, user);
  assert.equal(res.status, 201);
  return ((await res.json()) as { id: string }).id;
}

async function paste(collectionId: string, text: string, name = "note.md", user = "alice") {
  const res = await request("POST", `/collections/${collectionId}/sources/paste`, { name, text }, user);
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { id: string }).id;
}

const waitFor = async () => {
  await drainKnowledgeJobs();
};

test("unexpected source writes keep database details private and roll back their upload", async (t) => {
  const id = await create();
  const before = storageUsed("alice");
  t.mock.method(console, "error", () => {});
  db.exec("CREATE TRIGGER reject_test_source BEFORE INSERT ON knowledge_sources BEGIN SELECT RAISE(ABORT, 'private database details /data/okaychat.sqlite'); END");
  try {
    const res = await request("POST", `/collections/${id}/sources/paste`, { name: "note.md", text: "Sample note." });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.code, "unknown");
    assert.ok(body.ref);
    assert.doesNotMatch(JSON.stringify(body), /private database|sqlite/);
    assert.equal(storageUsed("alice"), before);
  } finally {
    db.exec("DROP TRIGGER reject_test_source");
  }
});

/** Waits for a job to reach an observable point without depending on a fixed delay. */
async function waitUntil(check: () => boolean, label: string, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const fakeVector = (text: string) => (/quasar|needle/i.test(text) ? normalizeVector([1, 0, 0, 0]) : normalizeVector([0, 1, 0, 0]));
const fakeEmbedder = {
  provider: "openai" as const,
  providerId: "openai",
  model: "fake-embed",
  embed: async (texts: string[]) => texts.map(fakeVector),
};
/** Jobs and retrieval share the fake provider, so no test reaches a real network. */
function useFakeEmbeddings() {
  setEmbedderFactoryForTests(() => fakeEmbedder);
  setRetrievalEmbedderFactoryForTests((collection) => (collection.embedding_provider === "none" ? null : fakeEmbedder));
}

let vectorChunkSeq = 0;
/** Seeds one ready source with explicitly chosen vectors, bypassing ingestion for retrieval ranking tests. */
function seedVectors(collectionId: string, name: string, rows: Array<{ text: string; vector: number[] }>): string {
  const text = rows.map((row) => row.text).join("\n");
  const uploadId = storeUpload("alice", `${name}.txt`, "text/plain", Buffer.from(text));
  const source = createSource("alice", collectionId, { name: `${name}.txt`, kind: "paste", mime: "text/plain", uploadId, bytes: Buffer.byteLength(text), text });
  const chunks = rows.map((row, ordinal) => ({
    chunk: { id: `k_vec_${++vectorChunkSeq}`, ordinal, title: name, start: ordinal * 10, end: ordinal * 10 + row.text.length, text: row.text, tokens: 8 },
    vector: normalizeVector(row.vector),
  }));
  assert.equal(replaceChunks("alice", source.id, sourceRow("alice", source.id)!.generation, collectionId, chunks, 2), true);
  return source.id;
}

const queryEmbedder = (vector: number[]) => ({
  provider: "openai" as const,
  providerId: "openai",
  model: "query",
  embed: async (texts: string[]) => texts.map(() => normalizeVector(vector)),
});

test("reciprocal rank fusion rewards agreement and keeps a deterministic order", () => {
  const fused = fuseRankings(["a", "b", "c"], ["c", "a"]);
  assert.deepEqual(fused.map((row) => row.id).slice(0, 2), ["a", "c"]);
  const a = fused.find((row) => row.id === "a")!;
  assert.ok(Math.abs(a.score - (1 / 61 + 1 / 62)) < 1e-9, "a is rank 0 lexical and rank 1 vector");
  assert.equal(a.lexical && a.vector, true);
  const b = fused.find((row) => row.id === "b")!;
  assert.ok(Math.abs(b.score - 1 / 62) < 1e-9);
});

test("knowledge routes require a session and never leak another account's collection", async () => {
  const unauthenticated = await app.request("http://app/knowledge/collections");
  assert.equal(unauthenticated.status, 401);
  const id = await create();
  for (const [method, route] of [["GET", `/collections/${id}`], ["DELETE", `/collections/${id}`], ["GET", `/collections/${id}/chunks`], ["GET", `/sources/${id}/chunks`]] as const) {
    assert.equal((await request(method, route, undefined, "bob")).status, 404, `${method} ${route}`);
  }
  const post = await request("POST", `/collections/${id}/sources/paste`, { name: "x", text: "secret" }, "bob");
  assert.equal(post.status, 404);
  const listing = (await (await request("GET", "/collections", undefined, "bob")).json()) as { collections: unknown[] };
  assert.equal(listing.collections.length, 0);
});

test("the selector list is narrowed by the chat's own project", async () => {
  const globalId = await create({ provider: "none" }, "alice", { name: "Global" });
  const atlas = await create({ provider: "none" }, "alice", { name: "Atlas", projectId: "p1" });
  const other = await create({ provider: "none" }, "alice", { name: "Other", projectId: "p2" });
  const scoped = (await (await request("GET", "/collections?project=p1")).json()) as { collections: Array<{ id: string }> };
  assert.deepEqual(new Set(scoped.collections.map((row) => row.id)), new Set([globalId, atlas]));
  assert.ok(!scoped.collections.some((row) => row.id === other));
  const globalOnly = (await (await request("GET", "/collections?project=none")).json()) as { collections: Array<{ id: string }> };
  assert.deepEqual(globalOnly.collections.map((row) => row.id), [globalId]);
  const all = (await (await request("GET", "/collections")).json()) as { collections: Array<{ id: string }> };
  assert.equal(all.collections.length, 3, "the management page still lists every owned collection");
});

test("pasted text is chunked, searchable with citations, and charged to the account", async () => {
  const id = await create();
  const text = `# Handbook\n\n${"The quasar calibrates the starboard relay. ".repeat(400)}`;
  const sourceId = await paste(id, text);
  await waitFor();
  const detail = (await (await request("GET", `/collections/${id}`)).json()) as { collection: { sourceCount: number; chunkCount: number; bytes: number; status: string }; sources: Array<{ status: string; chunkCount: number }> };
  assert.equal(detail.collection.sourceCount, 1);
  assert.ok(detail.collection.chunkCount >= 1);
  assert.equal(detail.collection.status, "ready");
  assert.equal(detail.sources[0]!.status, "ready");
  assert.ok(storageUsed("alice") > 0);
  assert.ok(detail.collection.bytes > 0);

  const search = (await (await request("POST", `/collections/${id}/search`, { query: "quasar" })).json()) as { mode: string; hits: Array<{ chunkId: string; documentId: string; title: string; offset: number; text: string; excerpt: string }> };
  assert.equal(search.mode, "lexical");
  assert.ok(search.hits.length >= 1);
  const hit = search.hits[0]!;
  assert.equal(hit.documentId, sourceId);
  assert.ok(hit.text.toLowerCase().includes("quasar"));
  assert.ok(hit.offset >= 0);
  assert.ok(hit.excerpt.length > 0);
  const chunk = chunkRow("alice", hit.chunkId);
  assert.ok(chunk);
  assert.equal(chunk!.text.slice(0, 40), hit.text.slice(0, 40));

  const passage = (await (await request("GET", `/chunks/${hit.chunkId}`)).json()) as { chunk: { text: string }; source: { name: string } };
  assert.equal(passage.chunk.text, hit.text);
  assert.equal(passage.source.name, "note.md");

  // A malformed query must not fail the endpoint.
  assert.equal((await request("POST", `/collections/${id}/search`, { query: "&& || ((" })).status, 200);

  const limited = await searchKnowledge({ userId: "alice", collectionIds: [id], query: "quasar", k: 1, budgetTokens: 10_000 });
  assert.equal(limited.hits.length, 1, "k caps the passage count");
  const starved = await searchKnowledge({ userId: "alice", collectionIds: [id], query: "quasar", k: 8, budgetTokens: 10 });
  assert.equal(starved.hits.length, 0, "a token budget smaller than one passage returns nothing rather than overspending");
});

test("hybrid retrieval uses normalized embeddings and reindexes when the model changes", async () => {
  useFakeEmbeddings();
  const id = await create({ provider: "openai", model: "fake-embed" });
  await paste(id, "The quasar calibrates the starboard relay in the deep field.");
  await waitFor();
  const first = (await (await request("GET", `/collections/${id}`)).json()) as { collection: { chunkCount: number; status: string }; sources: Array<{ id: string }> };
  assert.equal(first.collection.status, "ready");
  const stored = db.prepare("SELECT embedding, embedding_dim FROM knowledge_chunks WHERE collection_id = ?").get(id) as { embedding: Uint8Array; embedding_dim: number };
  assert.ok(stored.embedding.byteLength > 0);
  assert.equal(stored.embedding_dim, 4);

  const search = (await (await request("POST", `/collections/${id}/search`, { query: "quasar" })).json()) as { mode: string; hits: Array<{ chunkId: string; text: string }> };
  assert.equal(search.mode, "hybrid");
  assert.ok(search.hits.length > 0);

  const patched = await request("POST", `/collections/${id}/reindex`, { embedding: { provider: "none" } });
  assert.equal(patched.status, 200);
  await waitFor();
  const after = db.prepare("SELECT id, embedding FROM knowledge_chunks WHERE collection_id = ?").all(id) as Array<{ id: string; embedding: Uint8Array | null }>;
  assert.ok(after.length > 0);
  assert.ok(after.every((row) => row.embedding === null), "old vectors are not mixed with the new model");
  const degraded = (await (await request("POST", `/collections/${id}/search`, { query: "quasar" })).json()) as { mode: string };
  assert.equal(degraded.mode, "lexical");
});

test("vector candidates merge globally before RRF and are independent of attachment order", async () => {
  const a = await create({ provider: "openai", model: "query" }, "alice", { name: "Vector A" });
  const b = await create({ provider: "openai", model: "query" }, "alice", { name: "Vector B" });
  const aSource = seedVectors(a, "A", [{ text: "alpha passage", vector: [0.5, Math.sqrt(3) / 2] }]);
  const bSource = seedVectors(b, "B", [{ text: "beta passage", vector: [1, 0] }]);
  const aChunk = (db.prepare("SELECT id FROM knowledge_chunks WHERE source_id = ?").get(aSource) as { id: string }).id;
  const bChunk = (db.prepare("SELECT id FROM knowledge_chunks WHERE source_id = ?").get(bSource) as { id: string }).id;
  const search = (collectionIds: string[]) =>
    searchKnowledge({ userId: "alice", collectionIds, query: "zebra", projectId: null, k: 2, embedderFor: () => queryEmbedder([1, 0]) });

  const first = await search([a, b]);
  const reversed = await search([b, a]);
  assert.deepEqual(first.hits.map((hit) => hit.chunkId), [bChunk, aChunk]);
  assert.deepEqual(reversed.hits.map((hit) => hit.chunkId), [bChunk, aChunk], "the first attached collection does not win by position");
});

test("a source filter applies before vector ranking", async () => {
  const id = await create({ provider: "openai", model: "query" }, "alice", { name: "Filtered" });
  const high = seedVectors(id, "High", Array.from({ length: 61 }, (_, i) => ({ text: `alpha passage ${i}`, vector: [1, 0] })));
  const target = seedVectors(id, "Target", [{ text: "beta passage", vector: [0.5, Math.sqrt(3) / 2] }]);
  const targetChunk = (db.prepare("SELECT id FROM knowledge_chunks WHERE source_id = ?").get(target) as { id: string }).id;
  const result = await searchKnowledge({ userId: "alice", collectionIds: [id], query: "zebra", projectId: null, k: 8, sourceIds: [target], embedderFor: () => queryEmbedder([1, 0]) });
  assert.deepEqual(result.hits.map((hit) => hit.chunkId), [targetChunk], "a requested source is not dropped under unrelated top hits");
  assert.ok(!result.hits.some((hit) => hit.documentId === high));
});

test("a provider outage degrades honestly to lexical retrieval", async () => {
  const id = await create({ provider: "openai", model: "down" });
  const result = await searchKnowledge({
    userId: "alice",
    collectionIds: [id],
    query: "quasar",
    projectId: null,
    embedderFor: () => ({
      provider: "openai",
      providerId: "openai",
      model: "down",
      embed: async () => { throw new Error("provider is down"); },
    }),
  });
  assert.equal(result.mode, "lexical");
  assert.equal(result.degraded, true);
  assert.ok(result.hits.every((hit) => hit.via !== "vector"));
});

test("a failing embedder marks the source failed, and retry recovers", async () => {
  setEmbedderFactoryForTests(() => ({
    provider: "openai",
    providerId: "openai",
    model: "broken",
    embed: async () => { throw new EmbeddingError("provider is down"); },
  }));
  const id = await create({ provider: "openai", model: "broken" });
  const sourceId = await paste(id, "Quasar notes that should fail to embed.");
  await waitFor();
  const failed = sourceRow("alice", sourceId)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /provider is down/);
  assert.equal((await request("GET", `/collections/${id}`)).status, 200);

  useFakeEmbeddings();
  assert.equal((await request("POST", `/sources/${sourceId}/retry`)).status, 200);
  await waitFor();
  const ready = sourceRow("alice", sourceId)!;
  assert.equal(ready.status, "ready");
  assert.ok(ready.chunk_count > 0);
});

test("a provider timeout fails the source visibly instead of reading as a cancel, and raw errors stay private", async (t) => {
  t.mock.method(console, "error", () => {});
  setEmbedderFactoryForTests(() => ({
    provider: "openai",
    providerId: "openai",
    model: "slow",
    embed: async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
  }));
  const id = await create({ provider: "openai", model: "slow" });
  const timedOut = await paste(id, "Quasar notes that time out.");
  await waitFor();
  assert.equal(sourceRow("alice", timedOut)!.status, "failed");
  assert.equal(sourceRow("alice", timedOut)!.error, "The embedding provider did not respond in time.");

  setEmbedderFactoryForTests(() => ({
    provider: "openai",
    providerId: "openai",
    model: "leaky",
    embed: async () => { throw new Error("socket to /data/okaychat.sqlite closed"); },
  }));
  const leaky = await paste(id, "Quasar notes with an unexpected error.");
  await waitFor();
  assert.equal(sourceRow("alice", leaky)!.status, "failed");
  assert.equal(sourceRow("alice", leaky)!.error, "Ingestion failed.");
  assert.equal(console.error.mock.callCount(), 1);
});

test("cancel stops a running source and leaves no chunks behind", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  setEmbedderFactoryForTests(() => ({
    provider: "openai",
    providerId: "openai",
    model: "slow",
    embed: async (texts: string[]) => { await gate; return texts.map(fakeVector); },
  }));
  const id = await create({ provider: "openai", model: "slow" });
  const sourceId = await paste(id, "Quasar content that will be cancelled before embeddings finish.");
  // Let the job reach the embedder.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cancelled = await request("POST", `/sources/${sourceId}/cancel`);
  assert.equal(cancelled.status, 200);
  release();
  await waitFor();
  const row = sourceRow("alice", sourceId)!;
  assert.equal(row.status, "cancelled");
  assert.equal(row.chunk_count, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM knowledge_chunks WHERE source_id = ?").get(sourceId) as { n: number }).n, 0);
});

test("a forged cancel from another account cannot abort a running ingest", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  setEmbedderFactoryForTests(() => ({
    provider: "openai",
    providerId: "openai",
    model: "blocked",
    embed: async (texts: string[]) => { await gate; return texts.map(fakeVector); },
  }));
  const id = await create({ provider: "openai", model: "blocked" });
  const sourceId = await paste(id, "Quasar text owned by Alice and currently embedding.");
  await waitUntil(() => sourceRow("alice", sourceId)?.status === "embedding", "Alice's job to reach embedding");
  try {
    const forged = await request("POST", `/sources/${sourceId}/cancel`, undefined, "bob");
    assert.equal(forged.status, 403, "Bob cannot change another account's source");
    assert.equal(sourceRow("alice", sourceId)!.status, "embedding", "the running controller was not aborted");
  } finally {
    release();
  }
  await waitFor();
  assert.equal(sourceRow("alice", sourceId)!.status, "ready");
});

test("retry during an active job aborts it and runs exactly one replacement", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  setEmbedderFactoryForTests(() => ({
    provider: "openai",
    providerId: "openai",
    model: "slow",
    embed: async (texts: string[]) => {
      calls++;
      if (calls === 1) await gate;
      return texts.map(fakeVector);
    },
  }));
  const id = await create({ provider: "openai", model: "slow" });
  const sourceId = await paste(id, "Quasar content retried while the first job is embedding.");
  await waitUntil(() => calls === 1, "the first embed call");
  try {
    assert.equal((await request("POST", `/sources/${sourceId}/retry`)).status, 200);
  } finally {
    release();
  }
  await waitFor();
  const row = sourceRow("alice", sourceId)!;
  assert.equal(row.status, "ready");
  assert.ok(row.chunk_count > 0);
  assert.equal(calls, 2, "the superseded job did not restart and the replacement ran once");
});

test("changing a collection's embeddings during an active job queues the replacement", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  setEmbedderFactoryForTests(() => ({
    provider: "openai",
    providerId: "openai",
    model: "slow",
    embed: async (texts: string[]) => {
      calls++;
      await gate;
      return texts.map(fakeVector);
    },
  }));
  const id = await create({ provider: "openai", model: "slow" });
  const sourceId = await paste(id, "Quasar content whose embedding model changes mid-ingest.");
  await waitUntil(() => calls === 1, "the first embed call");
  try {
    const patched = await request("POST", `/collections/${id}/reindex`, { embedding: { provider: "none" } });
    assert.equal(patched.status, 200);
  } finally {
    release();
  }
  await waitFor();
  const row = sourceRow("alice", sourceId)!;
  assert.equal(row.status, "ready");
  assert.ok(row.chunk_count > 0);
  const rows = db.prepare("SELECT embedding FROM knowledge_chunks WHERE collection_id = ?").all(id) as Array<{ embedding: Uint8Array | null }>;
  assert.ok(rows.length > 0);
  assert.ok(rows.every((chunk) => chunk.embedding === null), "the replacement job used the new lexical-only setting");
});

test("a superseded generation cannot write chunks, and delete frees every owned byte", async () => {
  useFakeEmbeddings();
  const id = await create({ provider: "openai", model: "fake-embed" });
  const sourceId = await paste(id, "Quasar one. ".repeat(80));
  await waitFor();
  const before = storageUsed("alice");
  assert.equal(requeueSource("alice", sourceId), true);
  const stale = sourceRow("alice", sourceId)!;
  const written = replaceChunks("alice", sourceId, stale.generation - 1, id, [], null);
  assert.equal(written, false, "a superseded job cannot write");

  assert.equal((await request("DELETE", `/collections/${id}`)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_sources").get()!["n"], 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_chunks").get()!["n"], 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM uploads").get()!["n"], 0);
  assert.ok(storageUsed("alice") < before);
});

test("unfinished rows resume after a restart", async () => {
  const id = await create({ provider: "none" });
  const sourceId = "kns_resume";
  const uploadId = storeUpload("alice", "resume.txt", "text/plain", Buffer.from("Quasar resume text"));
  db.prepare(`INSERT INTO knowledge_sources (id, collection_id, user_id, upload_id, name, kind, mime, bytes, text, text_bytes, status, progress, created_at, updated_at)
    VALUES (?, ?, 'alice', ?, 'resume.txt', 'file', 'text/plain', 18, ?, 18, 'embedding', 0.4, 1, 1)`).run(sourceId, id, uploadId, "Quasar resume text");
  assert.equal(resumeKnowledgeIngestion(), 1);
  await waitFor();
  assert.equal(sourceRow("alice", sourceId)!.status, "ready");
});

test("startup recovery drains more than one batch of pending rows", async () => {
  const id = await create({ provider: "none" });
  const insert = db.prepare(`INSERT INTO knowledge_sources (id, collection_id, user_id, name, kind, mime, bytes, text, text_bytes, status, progress, created_at, updated_at)
    VALUES (?, ?, 'alice', ?, 'paste', 'text/plain', 0, ?, ?, 'queued', 0, 1, 1)`);
  db.exec("BEGIN");
  try {
    for (let i = 0; i < 501; i++) {
      const sourceId = `kns_bulk_${String(i).padStart(4, "0")}`;
      const text = `Quasar recovery note number ${i}.`;
      insert.run(sourceId, id, `note-${i}.txt`, text, Buffer.byteLength(text));
    }
  } finally {
    db.exec("COMMIT");
  }
  assert.equal(resumeKnowledgeIngestion(), 500, "the first keyset batch is bounded");
  await waitFor();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM knowledge_sources WHERE collection_id = ? AND status = 'ready'").get(id) as { n: number }).n, 501);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM knowledge_sources WHERE collection_id = ? AND status != 'ready'").get(id) as { n: number }).n, 0);
});

test("attached collections scope chat tools and replay only while still attached", async () => {
  useFakeEmbeddings();
  const globalId = await create({ provider: "openai", model: "fake-embed" }, "alice", { name: "Global handbook" });
  await paste(globalId, "The quasar handbook describes starboard calibration.");
  const projectId = await create({ provider: "none" }, "alice", { name: "Atlas notes", projectId: "p1" });
  await paste(projectId, "The Atlas quasar checklist lives in the project collection.");
  const otherId = await create({ provider: "none" }, "alice", { name: "Other project", projectId: "p2" });
  await paste(otherId, "The other quasar should never appear in this chat.");
  const bobId = await create({ provider: "none" }, "bob", { name: "Bob secret" });
  await paste(bobId, "Bob's quasar secret.", "bob.md", "bob");
  await waitFor();

  updateThread("alice", "thread-p1", { knowledgeIds: [globalId, projectId, otherId, bobId] });
  const attached = attachedCollectionIds("alice", "thread-p1");
  assert.deepEqual(new Set(attached), new Set([globalId, projectId]), "foreign and other-project collections are dropped");

  const turn = await conversationKnowledge("alice", "thread-p1", "quasar", { retrieve: true });
  assert.equal(turn.collections.length, 2);
  assert.match(turn.context, /quasar/i);
  assert.match(turn.context, /retrieval: hybrid/);
  assert.match(turn.context, /documentId/);
  assert.match(turn.context, /score/);
  assert.doesNotMatch(turn.context, /other quasar/i);
  assert.doesNotMatch(turn.context, /Bob's/i);

  const tools = knowledgeTools("alice", "thread-p1") as ToolSet;
  const run = tools.search_knowledge!.execute as (input: unknown, options: unknown) => Promise<unknown>;
  const narrowed = (await run({ query: "quasar", collections: [otherId, bobId] }, { toolCallId: "t", messages: [] })) as { hits: unknown[] };
  assert.equal(narrowed.hits.length, 0, "the collections argument cannot widen scope");
  const scored = (await run({ query: "quasar" }, { toolCallId: "t", messages: [] })) as { mode: string; hits: Array<{ score: number; documentId: string; title: string }> };
  assert.equal(scored.mode, "hybrid");
  assert.ok(scored.hits.length > 0);
  assert.equal(typeof scored.hits[0]!.score, "number");
  assert.ok(scored.hits[0]!.documentId.length > 0);
  assert.ok(scored.hits[0]!.title.length > 0);

  const read = tools.read_knowledge_chunk!.execute as (input: unknown, options: unknown) => Promise<{ error?: string; text?: string }>;
  const firstChunk = db.prepare("SELECT id FROM knowledge_chunks WHERE collection_id IN (?, ?) LIMIT 1").get(globalId, projectId) as { id: string };
  const passage = await read({ chunkId: firstChunk.id }, { toolCallId: "t", messages: [] });
  assert.ok(passage.text && passage.text.length > 0);

  // Replay: a stored block survives while every source collection is still attached.
  saveTurnContext("alice", "thread-p1", "m1", { date: "", memory: "", skills: "", knowledge: "passage data", knowledgeIds: [globalId] }, 0);
  assert.equal(storedTurnContexts("alice", "thread-p1", { memoryRevision: null, skills: false, knowledge: new Set([globalId]) }).get("m1")!.knowledge, "passage data");
  assert.equal(storedTurnContexts("alice", "thread-p1", { memoryRevision: null, skills: false, knowledge: new Set([projectId]) }).get("m1")!.knowledge, "");
  assert.equal(storedTurnContexts("alice", "thread-p1", { memoryRevision: null, skills: false }).get("m1")!.knowledge, "");

  updateThread("alice", "thread-p1", { knowledgeIds: [] });
  assert.deepEqual(attachedCollectionIds("alice", "thread-p1"), []);
  const after = (await run({ query: "quasar" }, { toolCallId: "t", messages: [] })) as { hits: unknown[] };
  assert.equal(after.hits.length, 0);
});

test("a detach during retrieval drops passages and never widens scope", async () => {
  useFakeEmbeddings();
  const id = await create({ provider: "openai", model: "fake-embed" }, "alice", { name: "Race" });
  await paste(id, "The quasar race passage is retrieved while the collection is attached.");
  await waitFor();
  updateThread("alice", "thread-p1", { knowledgeIds: [id] });

  let started = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  setRetrievalEmbedderFactoryForTests(() => ({
    provider: "openai",
    providerId: "openai",
    model: "blocked",
    embed: async (texts: string[]) => { started = true; await gate; return texts.map(fakeVector); },
  }));
  const pending = conversationKnowledge("alice", "thread-p1", "quasar", { retrieve: true });
  await waitUntil(() => started, "automatic retrieval to block");
  updateThread("alice", "thread-p1", { knowledgeIds: [] });
  release();
  const turn = await pending;
  assert.deepEqual(turn.collections, []);
  assert.equal(turn.context, "", "a detached collection contributes no context");

  // The same race for the explicit tool: the scope is re-read after the awaited embedding call.
  updateThread("alice", "thread-p1", { knowledgeIds: [id] });
  let toolStarted = false;
  let releaseTool!: () => void;
  const toolGate = new Promise<void>((resolve) => (releaseTool = resolve));
  setRetrievalEmbedderFactoryForTests(() => ({
    provider: "openai",
    providerId: "openai",
    model: "blocked",
    embed: async (texts: string[]) => { toolStarted = true; await toolGate; return texts.map(fakeVector); },
  }));
  const tools = knowledgeTools("alice", "thread-p1") as ToolSet;
  const run = tools.search_knowledge!.execute as (input: unknown, options: unknown) => Promise<{ hits: unknown[] }>;
  const toolPending = run({ query: "quasar" }, { toolCallId: "t", messages: [] });
  await waitUntil(() => toolStarted, "tool retrieval to block");
  updateThread("alice", "thread-p1", { knowledgeIds: [] });
  releaseTool();
  const result = await toolPending;
  assert.deepEqual(result.hits, [], "passages from a detached collection are not returned");
});

test("search stays bounded with 20k chunks and never scans the whole table per query", async () => {
  useFakeEmbeddings();
  const collection = createCollection("alice", { name: "Large", embedding: { provider: "openai", model: "fake-embed" } });
  const sourceId = "kns_perf";
  db.prepare(`INSERT INTO knowledge_sources (id, collection_id, user_id, name, kind, mime, bytes, text, text_bytes, status, progress, chunk_count, created_at, updated_at)
    VALUES (?, ?, 'alice', 'perf.txt', 'paste', 'text/plain', 0, 'seed', 4, 'ready', 1, 20000, 1, 1)`).run(sourceId, collection.id);
  const vector = normalizeVector([1, 0, 0, 0]);
  const packed = Buffer.from(vector.buffer.slice(0));
  db.exec("BEGIN");
  const insert = db.prepare(`INSERT INTO knowledge_chunks (id, source_id, collection_id, user_id, ordinal, title, start, "end", text, tokens, embedding, embedding_dim, created_at)
    VALUES (?, ?, ?, 'alice', ?, 'Perf', ?, ?, ?, 8, ?, 4, 1)`);
  for (let i = 0; i < 20_000; i++) {
    const text = i % 5000 === 0 ? `needle passage number ${i} about quasar calibration` : `filler passage number ${i} with ordinary words`;
    insert.run(`k_perf_${i}`, sourceId, collection.id, i, i * 10, i * 10 + text.length, text, packed);
  }
  db.exec("COMMIT");

  const started = performance.now();
  const result = await searchKnowledge({ userId: "alice", collectionIds: [collection.id], query: "needle", projectId: null, k: 8, embedderFor: () => fakeEmbedder });
  const elapsed = performance.now() - started;
  assert.ok(result.hits.length > 0);
  assert.ok(result.hits.length <= 8);
  assert.equal(result.mode, "hybrid");
  assert.ok(elapsed < 5000, `retrieval took ${Math.round(elapsed)}ms`);
  assert.equal(VECTOR_CACHE_LIMIT, 4000, "the vector cache is explicitly bounded");
});

test("a URL source keeps the original response and extracts readable text separately", async () => {
  const id = await create();
  const html = `<html><head><title>Quasar guide</title></head><body><article><h1>Quasar guide</h1><p>${"The quasar calibrates the starboard relay. ".repeat(12)}</p><p>${"A second paragraph explains the checklist. ".repeat(8)}</p></article></body></html>`;
  const original = new TextEncoder().encode(html);
  setKnowledgeUrlFetchForTests(async (input) => {
    assert.equal(String(input), "https://example.com/guide");
    return new Response(original, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  });
  const uploaded = await request("POST", `/collections/${id}/sources/url`, { url: "https://example.com/guide" });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const sourceId = ((await uploaded.json()) as { id: string }).id;
  await waitFor();
  const row = sourceRow("alice", sourceId)!;
  assert.equal(row.status, "ready");
  assert.equal(row.url, "https://example.com/guide");
  assert.match(row.text ?? "", /starboard relay/);
  const stored = db.prepare("SELECT data, mime FROM uploads WHERE id = ? AND user_id = 'alice'").get(row.upload_id) as { data: Uint8Array; mime: string };
  assert.equal(Buffer.from(stored.data).toString("utf8"), html, "the original bytes are persisted, not the Markdown extraction");
  assert.equal(stored.mime, "text/html");
  assert.equal(row.bytes, original.byteLength);

  let cancelled = false;
  setKnowledgeUrlFetchForTests(async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/plain", "Content-Length": String(MAX_URL_BYTES + 1) } }));
  const oversized = await request("POST", `/collections/${id}/sources/url`, { url: "https://example.com/large" });
  assert.equal(oversized.status, 422);
  assert.match(((await oversized.json()) as { error: string }).error, /larger/i);
  assert.equal(cancelled, true, "rejecting Content-Length closes the unread response");

  setKnowledgeUrlFetchForTests(async () => new Response("missing", { status: 404, headers: { "Content-Type": "text/html" } }));
  const missing = await request("POST", `/collections/${id}/sources/url`, { url: "https://example.com/missing" });
  assert.equal(missing.status, 422);
  assert.match(((await missing.json()) as { error: string }).error, /HTTP 404/);

  const ftp = await request("POST", `/collections/${id}/sources/url`, { url: "ftp://example.com/guide" });
  assert.ok([400, 422].includes(ftp.status), "non-http schemes are refused before any fetch");
});

test("PDF URLs extract text and queue scans for OCR from the stored original", async () => {
  const id = await create();
  const readable = await PDFDocument.create();
  readable.addPage().drawText("The quasar is in the URL document.");
  const readableBytes = await readable.save();
  setKnowledgeUrlFetchForTests(async () => new Response(readableBytes, { headers: { "Content-Type": "application/pdf" } }));
  const added = await request("POST", `/collections/${id}/sources/url`, { url: "https://example.com/text.pdf" });
  assert.equal(added.status, 201, await added.clone().text());
  const sourceId = ((await added.json()) as { id: string }).id;
  await waitFor();
  assert.equal(sourceRow("alice", sourceId)!.status, "ready");
  assert.match(sourceRow("alice", sourceId)!.text!, /quasar/);
  assert.equal(sourceRow("alice", sourceId)!.extraction, "text");
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bytes = await pdf.save();
  setKnowledgeUrlFetchForTests(async () => new Response(bytes, { headers: { "Content-Type": "application/pdf" } }));
  const response = await request("POST", `/collections/${id}/sources/url`, { url: "https://example.com/scan.pdf" });
  assert.equal(response.status, 201, await response.clone().text());
  const scanId = ((await response.json()) as { id: string }).id;
  await waitFor();
  const failed = sourceRow("alice", scanId)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /OCR/);
  assert.equal(failed.text, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_sources WHERE url = 'https://example.com/scan.pdf'").get()!["n"], 1);
  assert.ok(db.prepare("SELECT 1 FROM uploads WHERE id = ?").get(failed.upload_id), "the scanned original stays for a retry");

  setOcrExtractorForTests(async (req) => {
    assert.equal(req.kind, "pdf");
    return "Quasar scanned URL passage";
  });
  assert.equal((await request("POST", `/sources/${scanId}/retry`)).status, 200);
  await waitFor();
  assert.equal(sourceRow("alice", scanId)!.status, "ready");
  assert.equal(sourceRow("alice", scanId)!.extraction, "ocr");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_sources").get()!["n"], 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM uploads").get()!["n"], 2);
});

test("retrieved knowledge stored in turn_context is charged to the quota", async () => {
  const id = await create();
  await paste(id, "Quasar quota passage.");
  await waitFor();
  const before = storageUsed("alice");
  const knowledge = `Retrieved passages (retrieval: lexical):\n${"quasar passage ".repeat(80)}`;
  const ids = JSON.stringify([id]);
  saveTurnContext("alice", "thread-1", "m1", { date: "", memory: "", skills: "", knowledge, knowledgeIds: [id] }, 0);
  assert.equal(storageUsed("alice"), before + Buffer.byteLength(knowledge) + Buffer.byteLength(ids));
  const replay = storedTurnContexts("alice", "thread-1", { memoryRevision: null, skills: false, knowledge: new Set([id]) }).get("m1")!;
  assert.equal(replay.knowledge, knowledge);

  const smaller = "short passage";
  saveTurnContext("alice", "thread-1", "m1", { date: "", memory: "", skills: "", knowledge: smaller, knowledgeIds: [id] }, 0);
  assert.equal(storageUsed("alice"), before + Buffer.byteLength(smaller) + Buffer.byteLength(ids), "rewriting charges only net growth");

  const used = storageUsed("alice");
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(used + 10);
  try {
    assert.throws(
      () => saveTurnContext("alice", "thread-1", "m2", { date: "", memory: "", skills: "", knowledge: "z".repeat(200), knowledgeIds: [id] }, 0),
      /Storage quota exceeded/,
    );
    assert.equal((db.prepare("SELECT knowledge FROM turn_context WHERE thread_id = 'thread-1' AND message_id = 'm2'").get() as { knowledge?: string } | undefined)?.knowledge, undefined);
  } finally {
    db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
  }
});

test("PDF text is extracted and a scanned PDF fails with an honest message", async () => {
  const id = await create();
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText("The quasar starboard checklist is in this PDF.");
  const form = new FormData();
  form.set("file", new File([await pdf.save()], "guide.pdf", { type: "application/pdf" }));
  const upload = await app.request(`http://app/knowledge/collections/${id}/sources/file`, { method: "POST", body: form, headers: { cookie: "okaychat_session=alice-session" } });
  assert.equal(upload.status, 201);
  const pdfSource = ((await upload.json()) as { id: string }).id;
  await waitFor();
  assert.equal(sourceRow("alice", pdfSource)!.status, "ready");
  const found = (await (await request("POST", `/collections/${id}/search`, { query: "starboard" })).json()) as { hits: Array<{ text: string }> };
  assert.ok(found.hits.some((hit) => hit.text.includes("starboard")));

  const blank = await PDFDocument.create();
  blank.addPage();
  const blankForm = new FormData();
  blankForm.set("file", new File([await blank.save()], "scan.pdf", { type: "application/pdf" }));
  const blankUpload = await app.request(`http://app/knowledge/collections/${id}/sources/file`, { method: "POST", body: blankForm, headers: { cookie: "okaychat_session=alice-session" } });
  assert.equal(blankUpload.status, 201);
  const blankSource = ((await blankUpload.json()) as { id: string }).id;
  await waitFor();
  const failed = sourceRow("alice", blankSource)!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "This PDF has no text layer. Reading it needs OCR, which requires the code sandbox. It is not configured on this server. Add a text version, or ask an admin to enable the sandbox.");
  assert.ok(failed.upload_id && db.prepare("SELECT 1 FROM uploads WHERE id = ?").get(failed.upload_id), "the original is retained");
  const withFailed = storageUsed("alice");
  assert.ok(withFailed >= failed.bytes, "the retained original stays charged");

  setOcrExtractorForTests(async () => "Quasar scanned upload passage");
  assert.equal((await request("POST", `/sources/${blankSource}/retry`)).status, 200);
  await waitFor();
  assert.equal(sourceRow("alice", blankSource)!.status, "ready");
  assert.equal(sourceRow("alice", blankSource)!.extraction, "ocr");
  assert.equal((await request("DELETE", `/sources/${blankSource}`)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE id = ?").get(failed.upload_id)!["n"], 0);
});

test("quota growth is enforced and a rejected source leaves no orphan upload", async () => {
  const id = await create();
  const before = {
    sources: (db.prepare("SELECT COUNT(*) AS n FROM knowledge_sources").get() as { n: number }).n,
    uploads: (db.prepare("SELECT COUNT(*) AS n FROM uploads").get() as { n: number }).n,
  };
  const used = storageUsed("alice");
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(used + 100);
  try {
    const res = await request("POST", `/collections/${id}/sources/paste`, { name: "too big", text: "quasar ".repeat(500) });
    assert.equal(res.status, 413);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM knowledge_sources").get() as { n: number }).n, before.sources);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM uploads").get() as { n: number }).n, before.uploads);
  } finally {
    db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
  }
});

test("a source file stored as an upload becomes chunks and project filters are rejected", async () => {
  const id = await create();
  const form = new FormData();
  form.set("file", new File(["# Readme\n\nThe quasar launch checklist."], "readme.md", { type: "text/markdown" }));
  const upload = await app.request(`http://app/knowledge/collections/${id}/sources/file`, { method: "POST", body: form, headers: { cookie: "okaychat_session=alice-session" } });
  assert.equal(upload.status, 201);
  await waitFor();
  assert.equal(sourceRow("alice", ((await upload.json()) as { id: string }).id)!.status, "ready");

  const badProject = await request("POST", "/collections", { name: "Bad", projectId: "pb", embedding: { provider: "none" } });
  assert.equal(badProject.status, 404);
  const unknownSource = await request("GET", "/sources/missing/chunks");
  assert.equal(unknownSource.status, 404);
});

// Minimal local fixtures; nothing is downloaded.
const zip = (files: Record<string, string>, stored: string[] = []) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, stored.includes(name) ? [strToU8(text), { level: 0 }] : strToU8(text)])));

function pptxFixture(slide: string, notes: string) {
  const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const rels = (body: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
  const shape = (text: string) => `<p:sld ${ns}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return zip({
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    "ppt/presentation.xml": `<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels(rel("rId1", "slide", "slides/slide1.xml")),
    "ppt/slides/slide1.xml": shape(slide),
    "ppt/slides/_rels/slide1.xml.rels": rels(rel("rId1", "notesSlide", "../notesSlides/notesSlide1.xml")),
    "ppt/notesSlides/notesSlide1.xml": shape(notes).replace("p:sld ", "p:notes ").replace("</p:sld>", "</p:notes>"),
  });
}

function epubFixture(chapter: string) {
  return zip({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    "OEBPS/book.opf": '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
    "OEBPS/one.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h1>Chapter one</h1><p>${chapter}</p></body></html>`,
  }, ["mimetype"]);
}

function odtFixture(paragraph: string) {
  return zip({
    mimetype: "application/vnd.oasis.opendocument.text",
    "content.xml": `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h text:outline-level="1">Manual</text:h><text:p>${paragraph}</text:p></office:text></office:body></office:document-content>`,
  }, ["mimetype"]);
}

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function uploadFile(collectionId: string, name: string, data: Uint8Array | string, type = "") {
  const form = new FormData();
  form.set("file", new File([typeof data === "string" ? data : new Uint8Array(data)], name, { type }));
  const res = await app.request(`http://app/knowledge/collections/${collectionId}/sources/file`, { method: "POST", body: form, headers: { cookie: "okaychat_session=alice-session" } });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { id: string }).id;
}

test("PPTX, PPSX, EPUB, HTML, and ODT uploads become ready, searchable, exact-offset text sources", async () => {
  const id = await create();
  const cases: Array<[string, Uint8Array | string, string, RegExp]> = [
    ["deck.pptx", pptxFixture("Quasar slide token", "Pulsarnotes speaker token"), "application/vnd.openxmlformats-officedocument.presentationml.presentation", /Pulsarnotes speaker token/],
    ["show.ppsx", pptxFixture("Quasar slideshow token", "Nebulanotes"), "", /Nebulanotes/],
    ["book.epub", epubFixture("Quasar chapter token Magnetar."), "application/epub+zip", /Magnetar/],
    ["page.html", "<html><head><title>T</title><script>secretScript()</script></head><body><h1>Quasar page</h1><p>Blazar <a href=\"https://example.com/hidden\">linked</a> token.</p></body></html>", "text/html", /Blazar linked token/],
    ["manual.odt", odtFixture("Quasar odt token Kilonova."), "application/vnd.oasis.opendocument.text", /Kilonova/],
  ];
  for (const [name, data, type, token] of cases) {
    const sourceId = await uploadFile(id, name, data, type);
    await waitFor();
    const row = sourceRow("alice", sourceId)!;
    assert.equal(row.status, "ready", `${name}: ${row.error}`);
    assert.equal(row.extraction, "text", name);
    assert.match(row.text ?? "", token, name);
    assert.doesNotMatch(row.text ?? "", /secretScript|example\.com/, name);
    const chunks = db.prepare("SELECT start, \"end\", text FROM knowledge_chunks WHERE source_id = ?").all(sourceId) as Array<{ start: number; end: number; text: string }>;
    assert.ok(chunks.length > 0, name);
    for (const chunk of chunks) assert.equal(row.text!.slice(chunk.start, chunk.end), chunk.text, name);
  }
  for (const query of ["Pulsarnotes", "Nebulanotes", "Magnetar", "Blazar", "Kilonova"]) {
    const found = (await (await request("POST", `/collections/${id}/search`, { query })).json()) as { hits: Array<{ text: string }> };
    assert.ok(found.hits.some((hit) => hit.text.includes(query)), query);
  }
});

test("an image upload is read with OCR, charged, and released on delete", async () => {
  const id = await create();
  const before = storageUsed("alice");
  let calls = 0;
  setOcrExtractorForTests(async (req) => {
    calls++;
    assert.equal(req.kind, "image");
    assert.deepEqual(Buffer.from(req.data), ONE_PIXEL_PNG);
    return "Quasar image passage";
  });
  const sourceId = await uploadFile(id, "scan.png", ONE_PIXEL_PNG, "image/png");
  await waitFor();
  const row = sourceRow("alice", sourceId)!;
  assert.equal(row.status, "ready", row.error ?? "");
  assert.equal(row.extraction, "ocr");
  assert.equal(calls, 1);
  const upload = db.prepare("SELECT media_id FROM uploads WHERE id = ?").get(row.upload_id) as { media_id: string | null };
  assert.ok(upload.media_id && db.prepare("SELECT 1 FROM media WHERE id = ?").get(upload.media_id), "the raster original lives in the media store");
  const chunkBytes = (db.prepare("SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS n FROM knowledge_chunks WHERE source_id = ?").get(sourceId) as { n: number }).n;
  assert.equal(storageUsed("alice"), before + ONE_PIXEL_PNG.byteLength + Buffer.byteLength("Quasar image passage") + chunkBytes);
  const found = (await (await request("POST", `/collections/${id}/search`, { query: "Quasar image" })).json()) as { hits: Array<{ text: string }> };
  assert.ok(found.hits.some((hit) => hit.text.includes("Quasar image passage")));
  const listed = (await (await request("GET", `/collections/${id}`)).json()) as { sources: Array<{ id: string; extraction: string | null }> };
  assert.equal(listed.sources.find((source) => source.id === sourceId)?.extraction, "ocr");

  assert.equal((await request("DELETE", `/sources/${sourceId}`)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM uploads").get()!["n"], 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM media WHERE id = ?").get(upload.media_id)!["n"], 0);
  assert.equal(storageUsed("alice"), before);
});

test("without the sandbox an image fails with the OCR message, keeps its original, and retry recovers", async () => {
  const id = await create();
  const sourceId = await uploadFile(id, "photo.jpg", ONE_PIXEL_PNG, "");
  await waitFor();
  const failed = sourceRow("alice", sourceId)!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "This image needs OCR. OCR requires the code sandbox, which this server has not configured. Add a text version, or ask an admin to enable the sandbox.");
  assert.equal(failed.extraction, null);
  assert.ok(db.prepare("SELECT 1 FROM uploads WHERE id = ?").get(failed.upload_id));

  setOcrExtractorForTests(async () => "Quasar recovered image text");
  assert.equal((await request("POST", `/sources/${sourceId}/retry`)).status, 200);
  await waitFor();
  assert.equal(sourceRow("alice", sourceId)!.status, "ready");
  assert.equal(sourceRow("alice", sourceId)!.extraction, "ocr");

  setOcrExtractorForTests(async () => "");
  const empty = await uploadFile(id, "blank.png", ONE_PIXEL_PNG, "image/png");
  await waitFor();
  assert.equal(sourceRow("alice", empty)!.error, "OCR did not find any text in this file.");
});

test("reindex never calls OCR and keeps the stored OCR text and label", async () => {
  const id = await create();
  let calls = 0;
  setOcrExtractorForTests(async () => {
    calls++;
    return "Quasar reindex passage";
  });
  const sourceId = await uploadFile(id, "scan.png", ONE_PIXEL_PNG, "image/png");
  await waitFor();
  assert.equal(calls, 1);
  const text = sourceRow("alice", sourceId)!.text;
  calls = 0;
  assert.equal((await request("POST", `/sources/${sourceId}/reindex`)).status, 200);
  await waitFor();
  assert.equal((await request("POST", `/collections/${id}/reindex`, {})).status, 200);
  await waitFor();
  const row = sourceRow("alice", sourceId)!;
  assert.equal(calls, 0);
  assert.equal(row.status, "ready");
  assert.equal(row.text, text);
  assert.equal(row.extraction, "ocr");
  assert.ok(row.chunk_count > 0);
});

test("the capabilities route reports OCR as not configured without a sandbox", async () => {
  const res = await request("GET", "/capabilities");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ocr: { available: false, reason: "not_configured" } });
});

test("malformed, legacy, zip-bombed, and unsupported uploads fail specifically and keep their originals", async () => {
  const id = await create();
  const before = storageUsed("alice");
  const bomb = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "ppt/presentation.xml": new Uint8Array(210 * 1024 * 1024).fill(32) });
  const cases: Array<[string, Uint8Array | string, RegExp]> = [
    ["broken.pptx", zip({ "[Content_Types].xml": "<Types/>", "ppt/presentation.xml": "<p:presentation" }), /^Could not open this presentation\. It may be damaged\.$/],
    ["old.doc", Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]), /legacy Office file/],
    ["bomb.pptx", bomb, /expands to more than 200 MB/],
    ["notes.rtf", "{\\rtf1 hello}", /RTF files are not supported/],
    ["archive.zip", zip({ "a.txt": "hello" }), /not a supported document/],
    ["sheet.ods", zip({ mimetype: "application/vnd.oasis.opendocument.spreadsheet" }, ["mimetype"]), /Only OpenDocument text/],
    ["blob.bin", Buffer.from([1, 0, 2, 0, 3, 0, 255, 254]), /not a supported document or readable text/],
  ];
  const ids: string[] = [];
  for (const [name, data, message] of cases) {
    const sourceId = await uploadFile(id, name, data, "");
    ids.push(sourceId);
    await waitFor();
    const row = sourceRow("alice", sourceId)!;
    assert.equal(row.status, "failed", name);
    assert.match(row.error ?? "", message, name);
    assert.ok(db.prepare("SELECT 1 FROM uploads WHERE id = ?").get(row.upload_id), `${name} keeps its original`);
  }
  assert.ok(storageUsed("alice") > before);
  for (const sourceId of ids) assert.equal((await request("DELETE", `/sources/${sourceId}`)).status, 200);
  assert.equal(storageUsed("alice"), before);
});

test("a quota rejection during extraction fails the source, keeps the original, and retry succeeds after raising the limit", async () => {
  const id = await create();
  const text = `Quasar quota extraction ${"payload ".repeat(400)}`;
  const used = storageUsed("alice");
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(used + Buffer.byteLength(text) + 100);
  try {
    const sourceId = await uploadFile(id, "big.txt", text, "text/plain");
    await waitFor();
    const failed = sourceRow("alice", sourceId)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /Storage quota exceeded/);
    assert.ok(db.prepare("SELECT 1 FROM uploads WHERE id = ?").get(failed.upload_id));
    db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
    assert.equal((await request("POST", `/sources/${sourceId}/retry`)).status, 200);
    await waitFor();
    const row = sourceRow("alice", sourceId)!;
    assert.equal(row.status, "ready");
    assert.equal(row.progress, 1);
  } finally {
    db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
  }
});

test("chat extraction maps failures to 413/422 and stores an upload only after success", async () => {
  const extractFile = async (name: string, data: Uint8Array | string, type = "") => {
    const form = new FormData();
    form.set("file", new File([typeof data === "string" ? data : new Uint8Array(data)], name, { type }));
    return app.request("http://app/files/extract", { method: "POST", body: form, headers: { cookie: "okaychat_session=alice-session" } });
  };
  const uploads = () => (db.prepare("SELECT COUNT(*) AS n FROM uploads").get() as { n: number }).n;
  const bomb = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "ppt/presentation.xml": new Uint8Array(210 * 1024 * 1024).fill(32) });
  const tooLarge = await extractFile("bomb.pptx", bomb);
  assert.equal(tooLarge.status, 413);
  const legacy = await extractFile("old.doc", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
  assert.equal(legacy.status, 422);
  assert.match(((await legacy.json()) as { message: string }).message, /legacy Office file/);
  const image = await extractFile("photo.png", ONE_PIXEL_PNG, "image/png");
  assert.equal(image.status, 422);
  assert.match(((await image.json()) as { message: string }).message, /knowledge collection to read it with OCR/);
  assert.equal(uploads(), 0, "a failed extraction stores nothing");

  const deck = await extractFile("deck.pptx", pptxFixture("Quasar chat slide", "Chat notes"));
  assert.equal(deck.status, 200);
  const body = (await deck.json()) as { text: string; fileId?: string; truncated: boolean };
  assert.match(body.text, /## Slide 1\n\nQuasar chat slide\n\n### Notes\nChat notes/);
  assert.equal(body.truncated, false);
  assert.ok(body.fileId);
  const blank = await PDFDocument.create();
  blank.addPage();
  const scan = await extractFile("scan.pdf", await blank.save(), "application/pdf");
  assert.equal(scan.status, 200);
  assert.match(((await scan.json()) as { text: string }).text, /^\[This PDF has no text layer\..*knowledge collection where OCR can read it/);
  assert.equal(uploads(), 2);
});
