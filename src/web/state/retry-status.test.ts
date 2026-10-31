import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { applyRetryNotice, clearRetryNotice, retrySecondsLeft, useRetryStatusStore } from "./retry-status.js";

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
