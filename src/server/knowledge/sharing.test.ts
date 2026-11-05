import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-knowledge-sharing-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "knowledge-sharing-test-secret-not-for-production";
const { db } = await import("../db.js");
const { requireUser } = await import("../auth.js");
const { sha256 } = await import("../crypto.js");
const { handleAppError } = await import("../errors.js");
const { knowledgeRoutes } = await import("./routes.js");
const { createCollection, createSource, replaceChunks, sourceRow, deleteCollection, requeueCollection } = await import("./store.js");
const { collectionSharingState, readableCollectionRow, setCollectionSharing, KnowledgeConflictError } = await import("./access.js");
const { applyKnowledgeAttachments, isRestrictedKnowledgeThread, KnowledgeAttachError, restrictedThreadReadable } = await import("./thread-policy.js");
const { registerKnowledgeOperation, requestKnowledgeRevocation, resetKnowledgeRevocationsForTests } = await import("./revocation.js");
const { branchThread, ensureThread, getThread, listThreads, listMessages, updateThread } = await import("../threads.js");
const { exportRoutes } = await import("../export.js");
const { shareRoutes } = await import("../shares.js");
const { archiveRoutes } = await import("../archive-routes.js");
const { searchMessages } = await import("../search.js");
const { appendMessage } = await import("../threads.js");
const { storeUpload } = await import("../files.js");
const { chunkDocument } = await import("./chunker.js");
const { searchKnowledge } = await import("./retrieval.js");
const { storageUsed } = await import("../quota.js");

const app = new Hono().use(requireUser).onError(handleAppError).route("/knowledge", knowledgeRoutes);
const sinks = new Hono().use(requireUser).onError(handleAppError).route("/", exportRoutes).route("/", shareRoutes).route("/", archiveRoutes);
for (const [id, role] of [["alice", "user"], ["bob", "user"], ["carol", "user"], ["admin", "admin"]] as const) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", role, Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(`${id}-session`), id, Date.now() + 600_000);
}
db.prepare("INSERT INTO user_groups (id, name, created_at) VALUES ('g1', 'Group One', 1), ('g2', 'Group Two', 1)").run();
db.prepare("INSERT INTO user_group_members (group_id, user_id) VALUES ('g1', 'bob'), ('g2', 'carol')").run();
db.prepare("INSERT OR REPLACE INTO provider_connections (user_id, provider_id, api_key_enc, base_url, config_json, enabled, created_at) VALUES ('alice', 'openai', NULL, NULL, '{}', 1, 1)").run();

after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => {
  resetKnowledgeRevocationsForTests();
  db.exec(`DELETE FROM knowledge_thread_dependencies; DELETE FROM knowledge_chunks; DELETE FROM knowledge_sources; DELETE FROM knowledge_collections;
    DELETE FROM share_users; DELETE FROM share_groups; DELETE FROM share_audiences;
    DELETE FROM turn_context; DELETE FROM messages; DELETE FROM threads; DELETE FROM uploads; DELETE FROM projects; DELETE FROM shares;`);
  ensureThread("alice", "alice-chat");
  ensureThread("bob", "bob-chat");
});

const request = (method: string, route = "", body?: unknown, user = "alice") =>
  app.request(`http://app/knowledge${route}`, {
    method,
    headers: { cookie: `okaychat_session=${user}-session`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function seedCollection(user = "alice", name = "Handbook"): string {
  const collection = createCollection(user, { name: `${name} ${Math.random().toString(36).slice(2, 7)}`, embedding: { provider: "none" } });
  const text = `# Launch\n\nThe quasar calibrates the starboard relay.\n\n${"Checklist item. ".repeat(40)}`;
  const uploadId = storeUpload(user, "handbook.md", "text/markdown", Buffer.from(text));
  const source = createSource(user, collection.id, { name: "handbook.md", kind: "paste", mime: "text/markdown", uploadId, bytes: Buffer.byteLength(text), text });
  const chunks = chunkDocument(text, { sourceId: source.id, title: "Launch" });
  replaceChunks(user, source.id, sourceRow(user, source.id)!.generation, collection.id, chunks.map((chunk) => ({ chunk, vector: null })), null);
  return collection.id;
}

const publish = (id: string, audience = { mode: "all" as const, userIds: [] as string[], groupIds: [] as string[] }, revision = 1) =>
  setCollectionSharing("alice", id, { visibility: "shared", audience, expectedRevision: revision });

async function listIds(user: string, scope: string): Promise<string[]> {
  const response = await request("GET", `/collections?scope=${scope}`, undefined, user);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { collections: Array<{ id: string }> };
  return body.collections.map((row) => row.id);
}

test("publishing is explicit and a private collection never appears to another account", async () => {
  const id = seedCollection();
  assert.deepEqual(await listIds("bob", "shared"), []);
  assert.equal((await request("GET", `/collections/${id}`, undefined, "bob")).status, 404);
  publish(id);
  assert.deepEqual(await listIds("bob", "shared"), [id]);
  const detail = (await (await request("GET", `/collections/${id}`, undefined, "bob")).json()) as Record<string, unknown> & { collection: Record<string, unknown>; sources: Array<Record<string, unknown>> };
  assert.equal(detail.collection.access, "reader");
  assert.equal(detail.collection.visibility, "shared");
  assert.equal((detail.collection.owner as { id: string }).id, "alice");
  for (const secret of ["embedding", "bytes", "projectId", "audience", "accessRevision"]) assert.ok(!(secret in detail.collection), secret);
  assert.deepEqual(Object.keys(detail.sources[0]!).sort(), ["chunkCount", "collectionId", "createdAt", "id", "kind", "name", "status", "updatedAt"]);
});

test("selected-empty never means everyone; direct and group grants survive one another's removal", async () => {
  const id = seedCollection();
  publish(id, { mode: "selected", userIds: [], groupIds: [] });
  assert.deepEqual(await listIds("bob", "shared"), []);
  assert.equal((await request("GET", `/collections/${id}`, undefined, "carol")).status, 404);

  publish(id, { mode: "selected", userIds: ["bob"], groupIds: ["g2"] }, 2);
  assert.deepEqual((await listIds("bob", "shared")).sort(), [id]);
  assert.deepEqual((await listIds("carol", "shared")).sort(), [id]);

  publish(id, { mode: "selected", userIds: [], groupIds: ["g2"] }, 3);
  assert.deepEqual(await listIds("bob", "shared"), []);
  assert.deepEqual(await listIds("carol", "shared"), [id]);

  publish(id, { mode: "selected", userIds: ["bob"], groupIds: [] }, 4);
  assert.deepEqual(await listIds("bob", "shared"), [id]);
  assert.deepEqual(await listIds("carol", "shared"), []);
});

test("an outsider and an administrator outside the audience both answer 404", async () => {
  const id = seedCollection();
  publish(id, { mode: "selected", userIds: ["bob"], groupIds: [] });
  for (const user of ["carol", "admin"]) {
    assert.equal((await request("GET", `/collections/${id}`, undefined, user)).status, 404);
    assert.equal((await request("GET", `/collections/${id}/chunks`, undefined, user)).status, 404);
    assert.equal((await request("POST", `/collections/${id}/search`, { query: "quasar" }, user)).status, 404);
  }
  // Reader mutation authority is checked after read authority, so a reader cannot rename or delete.
  assert.equal((await request("PATCH", `/collections/${id}`, { name: "Mine" }, "bob")).status, 403);
  assert.equal((await request("DELETE", `/collections/${id}`, undefined, "bob")).status, 403);
  assert.equal((await request("POST", `/collections/${id}/sources/paste`, { name: "x", text: "y" }, "bob")).status, 403);
  assert.equal((await request("PUT", `/collections/${id}/sharing`, { visibility: "private", expectedRevision: 2 }, "bob")).status, 403);
});

test("a reader retrieves keyword passages and can open only their citation", async () => {
  const id = seedCollection();
  publish(id);
  const search = (await (await request("POST", `/collections/${id}/search`, { query: "quasar" }, "bob")).json()) as {
    mode: string;
    hits: Array<{ chunkId: string; collectionId: string }>;
    collections: Array<{ collectionId: string; mode: string; reason: string }>;
  };
  assert.equal(search.mode, "lexical");
  assert.ok(search.hits.length > 0);
  assert.equal(search.hits[0]!.collectionId, id);
  assert.deepEqual(search.collections.find((entry) => entry.collectionId === id), { collectionId: id, mode: "lexical", degraded: false, reason: "not_configured" });
  const passage = await request("GET", `/chunks/${search.hits[0]!.chunkId}`, undefined, "bob");
  assert.equal(passage.status, 200);
  const forged = await request("GET", "/chunks/knc_forged", undefined, "bob");
  assert.equal(forged.status, 404);
  assert.deepEqual(await forged.json(), { error: "Passage not found" });
});

test("a reader query never builds an owner embedder or spends the owner's connection", async () => {
  const id = seedCollection();
  // Configure embeddings on the owner's side, but publish before ingestion so no vectors exist.
  const collection = db.prepare("SELECT embedding_provider FROM knowledge_collections WHERE id = ?").get(id) as { embedding_provider: string };
  assert.equal(collection.embedding_provider, "none");
  publish(id);
  let calls = 0;
  const result = await searchKnowledge({
    userId: "bob",
    collectionIds: [id],
    query: "quasar",
    embedderFor: () => {
      calls++;
      return { provider: "openai", providerId: "openai", model: "x", embed: async () => [new Float32Array([1, 0])] };
    },
  });
  assert.equal(calls, 0, "a shared collection is intentionally lexical; no embedder is resolved");
  assert.equal(result.mode, "lexical");
  assert.ok(result.hits.length > 0);
});

test("sharing is a compare-and-set and a stale tab cannot widen the audience", async () => {
  const id = seedCollection();
  publish(id, { mode: "selected", userIds: ["bob"], groupIds: [] });
  const state = collectionSharingState("alice", id)!;
  assert.equal(state.revision, 2);
  assert.throws(
    () => setCollectionSharing("alice", id, { visibility: "shared", audience: { mode: "all", userIds: [], groupIds: [] }, expectedRevision: 1 }),
    (error: unknown) => error instanceof KnowledgeConflictError && error.message === "conflict",
  );
  // The old revision's ambiguous all-audience write did not land.
  assert.deepEqual((await listIds("carol", "shared")), []);
});

test("a project-bound collection cannot be published, and a shared one cannot take a project", async () => {
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p1', 'alice', 'Atlas', 1)").run();
  const collection = createCollection("alice", { name: "Project notes", embedding: { provider: "none" }, projectId: "p1" });
  assert.throws(() => publish(collection.id), (error: unknown) => error instanceof KnowledgeConflictError && error.message === "project_bound");
  const shared = seedCollection();
  publish(shared);
  const patch = await request("PATCH", `/collections/${shared}`, { projectId: "p1" });
  assert.equal(patch.status, 409);
});

test("the first shared attachment requires acknowledgement and stays restricted after detaching", async () => {
  const id = seedCollection();
  publish(id);
  assert.throws(
    () => applyKnowledgeAttachments("bob", "bob-chat", { knowledgeIds: [id], acceptSharedRestrictions: false }),
    (error: unknown) => error instanceof KnowledgeAttachError && error.reason === "ack_required",
  );
  assert.equal(applyKnowledgeAttachments("bob", "bob-chat", { knowledgeIds: [id], acceptSharedRestrictions: true }), "restricted");
  assert.equal(isRestrictedKnowledgeThread("bob-chat"), true);
  assert.equal(restrictedThreadReadable("bob", "bob-chat"), true);
  const summary = getThread("bob", "bob-chat")!;
  assert.equal(summary.sharedKnowledgeRestricted, true);
  assert.equal(summary.knowledgeAccess, "available");
  assert.equal(summary.memoryDisabled, true);

  // Detaching changes only the attachment list; the durable dependency keeps the chat restricted.
  applyKnowledgeAttachments("bob", "bob-chat", { knowledgeIds: [], acceptSharedRestrictions: false });
  assert.equal(isRestrictedKnowledgeThread("bob-chat"), true);
  assert.deepEqual(getThread("bob", "bob-chat")!.knowledgeIds, []);
  assert.equal(applyKnowledgeAttachments("bob", "bob-chat", { knowledgeIds: [id], acceptSharedRestrictions: false }), "restricted");
});

test("revocation locks the whole chat and a regrant restores it; deletion leaves it locked forever", async () => {
  const id = seedCollection();
  publish(id);
  applyKnowledgeAttachments("bob", "bob-chat", { knowledgeIds: [id], acceptSharedRestrictions: true });
  db.prepare("INSERT INTO messages (id, thread_id, format, content, bytes, created_at) VALUES ('m1','bob-chat','ai-sdk/v6','{\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"quasar\"}]}',10,1)").run();
  assert.equal(listMessages("bob", "bob-chat").length, 1);

  publish(id, { mode: "selected", userIds: [], groupIds: [] }, 2);
  assert.equal(restrictedThreadReadable("bob", "bob-chat"), false);
  assert.deepEqual(listMessages("bob", "bob-chat"), [], "locked history is not returned");
  const locked = listThreads("bob").find((thread) => thread.id === "bob-chat")!;
  assert.equal(locked.knowledgeAccess, "revoked");
  assert.equal(locked.title, null);
  assert.deepEqual(locked.tags, []);
  assert.deepEqual(locked.knowledgeIds, []);
  assert.equal(getThread("bob", "bob-chat")!.compaction, null);

  publish(id, { mode: "all", userIds: [], groupIds: [] }, 3);
  assert.equal(restrictedThreadReadable("bob", "bob-chat"), true);
  assert.equal(listMessages("bob", "bob-chat").length, 1);

  deleteCollection("alice", id);
  assert.equal(restrictedThreadReadable("bob", "bob-chat"), false);
  assert.equal(listThreads("bob").find((thread) => thread.id === "bob-chat")!.knowledgeAccess, "revoked");
});

test("a live retrieval is aborted when the collection's audience changes", () => {
  const id = seedCollection();
  publish(id);
  const controller = new AbortController();
  registerKnowledgeOperation(controller, () => !!readableCollectionRow("bob", id));
  publish(id, { mode: "selected", userIds: [], groupIds: [] }, 2);
  requestKnowledgeRevocation();
  assert.equal(controller.signal.aborted, true);
});

test("owner reindex binds a legacy non-lexical collection and readers never see the pin", async () => {
  const id = seedCollection();
  publish(id);
  // A legacy-style non-lexical row has no pin; ingestion must not silently guess one, and an explicit
  // reindex is the only way to bind the connection and rebuild every source.
  db.prepare("UPDATE knowledge_collections SET embedding_provider = 'openai', embedding_model = 'fake' WHERE id = ?").run(id);
  const before = (await (await request("GET", `/collections/${id}`)).json()) as { collection: Record<string, unknown> };
  assert.equal(before.collection.embeddingNeedsReindex, true);
  assert.equal(requeueCollection("alice", id), 1);
  const detail = (await (await request("GET", `/collections/${id}`)).json()) as { collection: Record<string, unknown> };
  assert.equal(detail.collection.embeddingNeedsReindex, false);
  const reader = (await (await request("GET", `/collections/${id}`, undefined, "bob")).json()) as { collection: Record<string, unknown> };
  assert.equal(reader.collection.retrieval && (reader.collection.retrieval as { reason: string }).reason, "shared_lexical");
  assert.equal("embeddingNeedsReindex" in reader.collection, false);
  assert.equal("embedding_connection_scope" in reader.collection, false);
});

test("reader chat context is charged to the reader, not the owner", async () => {
  const id = seedCollection();
  publish(id);
  const ownerBefore = storageUsed("alice");
  const readerBefore = storageUsed("bob");
  applyKnowledgeAttachments("bob", "bob-chat", { knowledgeIds: [id], acceptSharedRestrictions: true });
  const { saveTurnContext } = await import("../turn-context.js");
  saveTurnContext("bob", "bob-chat", "m1", { date: "", memory: "", skills: "", knowledge: "x".repeat(500), knowledgeIds: [id] }, 0);
  assert.ok(storageUsed("bob") > readerBefore);
  assert.equal(storageUsed("alice"), ownerBefore);
});

test("updating an ordinary thread still works and a shared attachment can use the reader's project chat", async () => {
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('pb', 'bob', 'Bob project', 1)").run();
  ensureThread("bob", "bob-project", "pb");
  const id = seedCollection();
  publish(id);
  assert.equal(applyKnowledgeAttachments("bob", "bob-project", { knowledgeIds: [id], acceptSharedRestrictions: true }), "restricted");
  updateThread("bob", "bob-project", { title: "Renamed" });
  assert.equal(getThread("bob", "bob-project")!.title, "Renamed");
});

test("a restricted chat refuses branch, export, archive, share, and locked search", async () => {
  const id = seedCollection();
  publish(id);
  applyKnowledgeAttachments("bob", "bob-chat", { knowledgeIds: [id], acceptSharedRestrictions: true });
  appendMessage("bob", "bob-chat", { id: "m1", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "unique-marker-quasar" }] } });

  assert.throws(() => branchThread("bob", "bob-chat", "m1", "branched"), /shared knowledge/i);
  const sink = (method: string, route: string, body?: unknown) =>
    sinks.request(`http://app${route}`, {
      method,
      headers: { cookie: "okaychat_session=bob-session", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.equal((await sink("GET", "/threads/bob-chat/export?format=markdown")).status, 409);
  assert.equal((await sink("POST", "/threads/bob-chat/shares", { mode: "live" })).status, 409);
  assert.equal((await sink("POST", "/chat-archives/exports", { threads: [{ id: "bob-chat" }] })).status, 409);
  // Detaching does not make those sinks legal.
  applyKnowledgeAttachments("bob", "bob-chat", { knowledgeIds: [], acceptSharedRestrictions: false });
  assert.equal((await sink("GET", "/threads/bob-chat/export?format=markdown")).status, 409);

  // Search never returns a locked restricted chat's snippets or title.
  publish(id, { mode: "selected", userIds: [], groupIds: [] }, 2);
  assert.equal(searchMessages("bob", "unique-marker-quasar").some((hit) => hit.threadId === "bob-chat"), false);
});
