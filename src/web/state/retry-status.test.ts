import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { applyRetryNotice, clearRetryNotice, retryChunkData, retryOwnerId, retrySecondsLeft, useRetryStatusStore } from "./retry-status.js";

const store = () => useRetryStatusStore.getState();

beforeEach(() => {
  for (const id of Object.keys(store().byThread)) clearRetryNotice(id);
});

test("a retry notice shows a countdown and a done notice clears it", () => {
  applyRetryNotice("thr_1", { attempt: 1, delayMs: 4_000, code: "provider_rate_limit" }, 1_000);
  const state = store().byThread.thr_1;
  assert.ok(state);
  assert.equal(retrySecondsLeft(state, 1_000), 4);
  assert.equal(retrySecondsLeft(state, 3_500), 2);
  assert.equal(retrySecondsLeft(state, 99_000), 0);
  applyRetryNotice("thr_1", { status: "done" }, 2_000);
  assert.equal(store().byThread.thr_1, undefined);
});

test("malformed notices and unknown codes are ignored", () => {
  applyRetryNotice("thr_1", { attempt: "one", delayMs: 1_000, code: "network" });
  applyRetryNotice("thr_1", { attempt: 1, delayMs: 1_000, code: "not_a_code" });
  applyRetryNotice("thr_1", null);
  assert.equal(store().byThread.thr_1, undefined);
});

test("a notice follows the owner's remote id, not the active chat's local id", () => {
  const chatA = { id: "local-a", remoteId: "thr_a" };
  const chatB = { id: "local-b", remoteId: "thr_b" };
  // A's runtime callback resolves while B is the chat on screen.
  applyRetryNotice(retryOwnerId(chatA)!, { attempt: 1, delayMs: 2_000, code: "network" }, 1_000);
  assert.ok(store().byThread.thr_a);
  assert.equal(store().byThread.thr_b, undefined);
  assert.equal(store().byThread["local-a"], undefined, "the local assistant-ui id is never a key");

  // B finishing must not clear A's live notice.
  clearRetryNotice(retryOwnerId(chatB));
  assert.ok(store().byThread.thr_a);

  // A finishing clears only A.
  clearRetryNotice(retryOwnerId(chatA));
  assert.equal(store().byThread.thr_a, undefined);
});

test("an optimistic new chat has no key until initialize gives it a remote id", () => {
  assert.equal(retryOwnerId({ id: "local-new" }), undefined);
  assert.equal(retryOwnerId({ id: "local-new", remoteId: null }), undefined);
  assert.equal(retryOwnerId({ id: "local-new", remoteId: "thr_new" }), "thr_new");
  assert.equal(retryOwnerId(undefined), undefined);
});

test("only data-retry chunks are read as retry notices", () => {
  assert.equal(retryChunkData({ type: "data-compaction", data: { status: "done" } }), undefined);
  assert.equal(retryChunkData({ type: "data-retry" }), undefined);
  assert.deepEqual(retryChunkData({ type: "data-retry", data: { attempt: 1, delayMs: 1_000, code: "network" } }), { attempt: 1, delayMs: 1_000, code: "network" });
  assert.equal(retryChunkData(null), undefined);
  assert.equal(retryChunkData("data-retry"), undefined);
});
