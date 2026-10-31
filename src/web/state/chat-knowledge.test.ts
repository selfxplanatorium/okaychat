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

const { useChatKnowledgeStore, useKnowledgeCitationStore } = await import("./chat-knowledge.js");

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

test("the citation store opens exactly one passage and closes cleanly", () => {
  useKnowledgeCitationStore.getState().open("k_abc");
  assert.equal(useKnowledgeCitationStore.getState().chunkId, "k_abc");
  useKnowledgeCitationStore.getState().open("k_def");
  assert.equal(useKnowledgeCitationStore.getState().chunkId, "k_def");
  useKnowledgeCitationStore.getState().close();
  assert.equal(useKnowledgeCitationStore.getState().chunkId, null);
});
