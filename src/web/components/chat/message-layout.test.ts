import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantBubbleShape, messageRunAt } from "./message-layout.js";

const roles = (...list: string[]) => list.map((role) => ({ role }));
const runs = (messages: { role: string }[]) => messages.map((_, index) => messageRunAt(messages, index));

test("runs follow same-role adjacency", () => {
  assert.deepEqual(runs(roles("user")), ["single"]);
  assert.deepEqual(runs(roles("user", "user")), ["start", "end"]);
  assert.deepEqual(runs(roles("user", "user", "user")), ["start", "middle", "end"]);
  assert.deepEqual(runs(roles("user", "assistant", "assistant", "user")), ["single", "start", "end", "single"]);
  assert.equal(messageRunAt(roles("user", "user"), 5), "single");
  assert.equal(messageRunAt(roles("user", "user"), -1), "single");
  assert.deepEqual(runs(roles("system", "system")), ["single", "single"]);
});

test("prose and compact work rows stay narrow", () => {
  assert.deepEqual(assistantBubbleShape([{ type: "text" }], "complete"), { wide: false, empty: false });
  assert.deepEqual(assistantBubbleShape([{ type: "reasoning" }, { type: "tool-call", toolName: "web_search" }, { type: "text" }], "complete"), { wide: false, empty: false });
});

test("cards, media, files, data and interrupted replies are wide", () => {
  for (const type of ["file", "image", "data"]) assert.equal(assistantBubbleShape([{ type: "text" }, { type }], "complete").wide, true, type);
  for (const toolName of ["create_artifact", "draft_email", "some_unknown_tool"]) {
    assert.equal(assistantBubbleShape([{ type: "tool-call", toolName }], "complete").wide, true, toolName);
  }
  assert.equal(assistantBubbleShape([{ type: "tool-call" }], "complete").wide, true);
  assert.equal(assistantBubbleShape([{ type: "text" }], "incomplete").wide, true);
});

test("only a finished or unknown-status reply with no parts is empty", () => {
  assert.equal(assistantBubbleShape([], "complete").empty, true);
  assert.equal(assistantBubbleShape([], undefined).empty, true);
  assert.equal(assistantBubbleShape([], "running").empty, false);
  assert.equal(assistantBubbleShape([{ type: "text" }], "complete").empty, false);
});
