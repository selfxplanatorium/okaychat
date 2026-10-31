/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS } from "../keyboard/commands.js";
import { applyEditWhenReady, editBlock, replaceMessageParts, textsOf, undoBlock } from "./message-edit.js";
import { editedAtOf, isEdited, rememberEdits, setEditedAt } from "../state/message-edits.js";

const gate = {
  enabled: true,
  remoteId: "t1",
  temporary: false,
  role: "assistant",
  complete: true,
  hasText: true,
  running: false,
  syncing: false,
  summarized: false,
};

test("the pencil is hidden unless a completed stored assistant reply has text", () => {
  assert.equal(editBlock(gate), null);
  assert.equal(editBlock({ ...gate, enabled: false }), "hidden");
  assert.equal(editBlock({ ...gate, remoteId: undefined }), "hidden");
  assert.equal(editBlock({ ...gate, temporary: true }), "hidden");
  assert.equal(editBlock({ ...gate, role: "user" }), "hidden");
  assert.equal(editBlock({ ...gate, complete: false }), "hidden", "streaming, stopped, and waiting replies");
  assert.equal(editBlock({ ...gate, hasText: false }), "hidden");
});

test("a run, cached history, or a summary blocks saving but not Undo's setting independence", () => {
  assert.equal(editBlock({ ...gate, running: true }), "busy");
  assert.equal(editBlock({ ...gate, syncing: true }), "busy");
  assert.equal(editBlock({ ...gate, summarized: true }), "summarized");
  const undo = { remoteId: "t1", temporary: false, running: false, syncing: false, summarized: false };
  assert.equal(undoBlock(undo), false);
  assert.equal(undoBlock({ ...undo, remoteId: undefined }), true);
  assert.equal(undoBlock({ ...undo, temporary: true }), true);
  assert.equal(undoBlock({ ...undo, running: true }), true);
  assert.equal(undoBlock({ ...undo, syncing: true }), true);
  assert.equal(undoBlock({ ...undo, summarized: true }), true);
});

test("text parts keep their order and count", () => {
  assert.deepEqual(textsOf([{ type: "text", text: "a" }, { type: "tool-x" }, { type: "text", text: "b" }]), ["a", "b"]);
  assert.deepEqual(textsOf([{ type: "reasoning", text: "hidden" }]), []);
  assert.deepEqual(textsOf([{ type: "text" }]), [""]);
});

test("importing an edited message keeps the head, parents, metadata, and every other message", () => {
  const state = {
    headId: "b",
    messages: [
      { parentId: null, message: { id: "a", parts: [{ type: "text", text: "old" }], metadata: { custom: { modelRef: "m/x" } } } },
      { parentId: "a", message: { id: "b", parts: [{ type: "text", text: "reply" }] } },
    ],
  };
  const next = replaceMessageParts(state, "a", [{ type: "text", text: "new" }]);
  assert.equal(next.headId, "b");
  assert.deepEqual(next.messages[0]!.message.parts, [{ type: "text", text: "new" }]);
  assert.deepEqual(next.messages[0]!.message.metadata, { custom: { modelRef: "m/x" } });
  assert.equal(next.messages[1], state.messages[1]);
  assert.equal(state.messages[0]!.message.parts[0]!.text, "old", "the source state is not mutated");
  assert.deepEqual(replaceMessageParts(state, "missing", []), state);
});

test("the edit and undo commands are message-scoped and registered", () => {
  const edit = COMMANDS.find((command) => command.id === "message.editReply");
  assert.equal(edit?.scope, "message");
  assert.deepEqual(edit?.keys, ["Y"]);
  const undo = COMMANDS.find((command) => command.id === "message.undoEdit");
  assert.equal(undo?.scope, "message");
  assert.deepEqual(undo?.keys, []);
});

test("server rows remember which replies were edited, and Undo clears the badge", () => {
  rememberEdits("t1", [{ id: "a", edited_at: 10 }, { id: "b" }]);
  assert.equal(isEdited("t1", "a"), true);
  assert.equal(isEdited("t1", "b"), false);
  assert.equal(editedAtOf("t1", "a"), 10);
  setEditedAt("t1", "a", null);
  assert.equal(isEdited("t1", "a"), false);
  assert.equal(editedAtOf("t1", "a"), undefined);
  setEditedAt("t1", "a", 20);
  assert.equal(editedAtOf("t1", "a"), 20);
});

test("a late edit waits for its owning chat and an idle runtime, then imports only once", () => {
  let active = false;
  let running = false;
  let listener: (() => void) | undefined;
  let imports = 0;
  let unsubscribed = false;
  applyEditWhenReady(() => active && !running, (callback) => {
    listener = callback;
    return () => { unsubscribed = true; };
  }, () => { imports++; listener?.(); });
  listener!();
  assert.equal(imports, 0, "switching to another chat cannot apply the edit there");
  active = true;
  running = true;
  listener!();
  assert.equal(imports, 0, "a late save cannot interrupt a new run");
  running = false;
  listener!();
  assert.equal(imports, 1, "synchronous import notifications do not import recursively");
  assert.equal(unsubscribed, true);
});
