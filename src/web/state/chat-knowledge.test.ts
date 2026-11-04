/// <reference types="node" />
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  configurable: true,
});

const { persistKnowledgeAttachments, useChatKnowledgeStore, useKnowledgeCitationStore } = await import("./chat-knowledge.js");

beforeEach(() => {
  useChatKnowledgeStore.setState({ byId: {}, collections: null, loading: false });
  useKnowledgeCitationStore.setState({ chunkId: null });
});

test("a choice made before the thread exists binds to its remote id", () => {
  const store = useChatKnowledgeStore.getState();
  store.set("local-1", ["knc_a", "knc_b", "knc_a"]);
  assert.deepEqual(useChatKnowledgeStore.getState().byId["local-1"], ["knc_a", "knc_b"], "duplicates are dropped");
  store.bind("local-1", "thr_1");
  assert.deepEqual(useChatKnowledgeStore.getState().byId["thr_1"], ["knc_a", "knc_b"]);
  assert.deepEqual(useChatKnowledgeStore.getState().byId["local-1"], ["knc_a", "knc_b"], "the local key is kept for the optimistic row");
});

test("server hydration replaces stale attachments and clearing detaches", () => {
  const store = useChatKnowledgeStore.getState();
  store.set("thr_1", ["knc_old"]);
  store.hydrate("thr_1", ["knc_new"]);
  assert.deepEqual(useChatKnowledgeStore.getState().byId["thr_1"], ["knc_new"]);
  store.hydrate("thr_1", []);
  assert.deepEqual(useChatKnowledgeStore.getState().byId["thr_1"], []);
});

test("list hydration updates attachments in one notification and clears stale choices", () => {
  const store = useChatKnowledgeStore.getState();
  store.set("stale", ["knc_old"]);
  store.set("outside-list", ["knc_keep"]);
  let notifications = 0;
  const unsubscribe = useChatKnowledgeStore.subscribe(() => notifications++);
  store.hydrateMany([
    ...Array.from({ length: 100_000 }, (_, i) => ({ id: `chat_${i}`, knowledgeIds: [] })),
    { id: "stale", knowledgeIds: [] },
    { id: "attached", knowledgeIds: ["knc_new"] },
  ]);
  unsubscribe();
  assert.equal(notifications, 1);
  assert.deepEqual(useChatKnowledgeStore.getState().byId, { "outside-list": ["knc_keep"], attached: ["knc_new"] });
});

test("a failed first attachment PATCH clears the stored chat instead of claiming it", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "nope" }), { status: 400, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    // A remote entry may already exist from a list/detail fetch; the failed PATCH must clear it.
    useChatKnowledgeStore.getState().hydrate("thr_new", ["knc_a"]);
    await assert.rejects(persistKnowledgeAttachments("thr_new", ["knc_a"]), /nope/);
    assert.deepEqual(useChatKnowledgeStore.getState().byId["thr_new"], [], "the stored chat mirrors no attachment");
    useChatKnowledgeStore.getState().set("local_new", ["knc_a"]);
    assert.deepEqual(useChatKnowledgeStore.getState().byId["local_new"], ["knc_a"], "the optimistic choice survives for a retry");
  } finally {
    globalThis.fetch = original;
  }
});

test("the citation store opens exactly one passage and closes cleanly", () => {
  useKnowledgeCitationStore.getState().open("k_abc");
  assert.equal(useKnowledgeCitationStore.getState().chunkId, "k_abc");
  useKnowledgeCitationStore.getState().open("k_def");
  assert.equal(useKnowledgeCitationStore.getState().chunkId, "k_def");
  useKnowledgeCitationStore.getState().close();
  assert.equal(useKnowledgeCitationStore.getState().chunkId, null);
});
