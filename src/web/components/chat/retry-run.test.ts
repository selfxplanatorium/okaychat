import assert from "node:assert/strict";
import { test } from "node:test";
import { retryParentId, retryRun } from "./retry-run.js";

test("retry re-answers the user message an assistant reply answered", () => {
  assert.deepEqual(retryRun({ role: "assistant", parentId: "user-1" }, "anthropic/sonnet", false), {
    parentId: "user-1",
    modelRef: "anthropic/sonnet",
  });
});

test("retry never parents on the assistant message or on a missing parent", () => {
  assert.equal(retryRun({ role: "assistant", parentId: null }, "anthropic/sonnet", false), null);
  assert.equal(retryRun({ role: "user", parentId: "assistant-1" }, "anthropic/sonnet", false), null);
  assert.equal(retryRun({ role: "assistant", parentId: "user-1" }, undefined, false), null);
});

test("retry is blocked while history is cached or a run is going", () => {
  assert.equal(retryRun({ role: "assistant", parentId: "user-1" }, "anthropic/sonnet", true), null);
});

test("retry from a user message answers that message, not the preceding assistant", () => {
  const user = { id: "user-2", role: "user", parentId: "assistant-1" };
  assert.equal(retryParentId(user), "user-2");
  assert.deepEqual(retryRun(user, "openai/model", false), { parentId: "user-2", modelRef: "openai/model" });
  assert.equal(retryRun(user, "openai/model", true), null);
});

test("plain retry uses the same parent as a model retry and rejects other roles", () => {
  assert.equal(retryParentId({ id: "reply-1", role: "assistant", parentId: "user-1" }), "user-1");
  assert.equal(retryParentId({ id: "system-1", role: "system", parentId: null }), null);
  assert.equal(retryParentId({ id: "reply-1", role: "assistant", parentId: null }), null);
});
