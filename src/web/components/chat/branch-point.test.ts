import assert from "node:assert/strict";
import { test } from "node:test";
import { branchPoint } from "./branch-point.js";

test("branching an assistant reply preserves it and never starts a rewrite", () => {
  assert.deepEqual(branchPoint({ id: "assistant-1", role: "assistant" }), { messageId: "assistant-1", run: false });
});

test("branching a user message copies through it and queues a new answer", () => {
  assert.deepEqual(branchPoint({ id: "user-1", role: "user" }), { messageId: "user-1", run: true });
});

test("other message roles cannot start a fork", () => {
  assert.equal(branchPoint({ id: "system-1", role: "system" }), null);
});
