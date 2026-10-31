import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { ToolSet } from "ai";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-knowledge-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "knowledge-test-secret-only-not-for-production";
const { db } = await import("../db.js");
const { requireUser } = await import("../auth.js");
const { sha256 } = await import("../crypto.js");
const { storageUsed } = await import("../quota.js");
const { ensureThread, updateThread } = await import("../threads.js");
const { knowledgeRoutes } = await import("./routes.js");
const { attachedCollectionIds, conversationKnowledge, knowledgeTools } = await import("./tools.js");
const { drainKnowledgeJobs, resumeKnowledgeIngestion, setEmbedderFactoryForTests } = await import("./jobs.js");
const { chunkRow, createCollection, deleteCollection, requeueSource, sourceRow, replaceChunks } = await import("./store.js");
const { searchKnowledge, setRetrievalEmbedderFactoryForTests, fuseRankings, VECTOR_CACHE_LIMIT } = await import("./retrieval.js");
const { saveTurnContext, storedTurnContexts } = await import("../turn-context.js");
const { normalizeVector } = await import("./embeddings.js");
const { storeUpload } = await import("../files.js");

const app = new Hono().use(requireUser).onError((error, c) => (error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: "failed" }, 500))).route("/knowledge", knowledgeRoutes);
for (const [id, role] of [["alice", "user"], ["bob", "user"]] as const) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", role, Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(`${id}-session`), id, Date.now() + 600_000);
}

after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => {
  setEmbedderFactoryForTests(null);
  setRetrievalEmbedderFactoryForTests(null);
  db.exec(`DELETE FROM knowledge_chunks; DELETE FROM knowledge_sources; DELETE FROM knowledge_collections;
    DELETE FROM turn_context; DELETE FROM messages; DELETE FROM threads; DELETE FROM uploads; DELETE FROM projects;`);
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p1', 'alice', 'Atlas', 1), ('p2', 'alice', 'Other', 1), ('pb', 'bob', 'Bob', 1)").run();
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
  assert.equal(res.status, 200);
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

  const patched = await request("PATCH", `/collections/${id}`, { embedding: { provider: "none" } });
  assert.equal(patched.status, 200);
  await waitFor();
  const after = db.prepare("SELECT id, embedding FROM knowledge_chunks WHERE collection_id = ?").all(id) as Array<{ id: string; embedding: Uint8Array | null }>;
  assert.ok(after.length > 0);
  assert.ok(after.every((row) => row.embedding === null), "old vectors are not mixed with the new model");
  const degraded = (await (await request("POST", `/collections/${id}/search`, { query: "quasar" })).json()) as { mode: string };
  assert.equal(degraded.mode, "lexical");
});

test("a failing embedder marks the source failed, and retry recovers", async () => {
  setEmbedderFactoryForTests(() => ({
    provider: "openai",
    providerId: "openai",
    model: "broken",
    embed: async () => { throw new Error("provider is down"); },
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
  assert.doesNotMatch(turn.context, /other quasar/i);
  assert.doesNotMatch(turn.context, /Bob's/i);

  const tools = knowledgeTools("alice", "thread-p1") as ToolSet;
  const run = tools.search_knowledge!.execute as (input: unknown, options: unknown) => Promise<unknown>;
  const narrowed = (await run({ query: "quasar", collections: [otherId, bobId] }, { toolCallId: "t", messages: [] })) as { hits: unknown[] };
  assert.equal(narrowed.hits.length, 0, "the collections argument cannot widen scope");

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
  assert.match(failed.error ?? "", /no text layer|OCR/i);
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
