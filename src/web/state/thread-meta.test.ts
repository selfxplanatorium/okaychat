/// <reference types="node" />
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
}, configurable: true });

type Pending = { path: string; resolve: (body: unknown) => void };
let pending: Pending[] = [];
globalThis.fetch = ((input: string) =>
  new Promise((resolve) => {
    pending.push({ path: input, resolve: (body) => resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })) });
  })) as typeof fetch;
const { loadThreadDetail, useThreadMetaStore } = await import("./thread-meta.js");

const detail = (id: string, cacheRead: number) => ({ id, memoryDisabled: false, branchedFrom: null, compaction: null, usage: { cacheRead, input: 1 } });
const usageOf = (id: string) => (useThreadMetaStore.getState().byId[id]?.usage as { cacheRead: number } | undefined)?.cacheRead;
const tick = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
  pending = [];
  useThreadMetaStore.setState({ byId: {} });
});

test("opening a chat shares the request already in flight for it", async () => {
  const fetched = loadThreadDetail("thr_a", { reuse: true });
  const refreshed = useThreadMetaStore.getState().refresh("thr_a", { reuse: true });
  assert.equal(pending.length, 1);
  pending[0]!.resolve(detail("thr_a", 5));
  assert.equal((await fetched).id, "thr_a");
  await refreshed;
  assert.equal(usageOf("thr_a"), 5);
});

test("an explicit refresh starts a new request, and an older answer arriving later is ignored", async () => {
  const first = useThreadMetaStore.getState().refresh("thr_b", { reuse: true });
  // After a compaction: the answer must postdate it, so the open request is not reused.
  const second = useThreadMetaStore.getState().refresh("thr_b");
  assert.equal(pending.length, 2);
  pending[1]!.resolve(detail("thr_b", 2));
  await second;
  assert.equal(usageOf("thr_b"), 2);
  pending[0]!.resolve(detail("thr_b", 1));
  await first;
  assert.equal(usageOf("thr_b"), 2);
});

test("a settled request is not reused, and temporary chats send nothing", async () => {
  const first = useThreadMetaStore.getState().refresh("thr_c", { reuse: true });
  pending[0]!.resolve(detail("thr_c", 1));
  await first;
  await tick();
  void useThreadMetaStore.getState().refresh("thr_c", { reuse: true });
  assert.equal(pending.length, 2);
  await useThreadMetaStore.getState().refresh("tmp_x");
  assert.equal(pending.length, 2);
});
