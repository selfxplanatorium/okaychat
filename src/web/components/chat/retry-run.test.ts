import assert from "node:assert/strict";
import { test } from "node:test";
import { retryRun } from "./retry-run.js";

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
