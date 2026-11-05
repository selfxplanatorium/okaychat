import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HANDOFF_TTL_MS,
  clearNoteHandoff,
  noteChatText,
  offerNoteToChat,
  peekNoteHandoff,
  takeNoteHandoff,
} from "./note-chat-handoff.js";

test("the handoff carries title and body only", () => {
  clearNoteHandoff();
  assert.equal(noteChatText({ title: "Plan", body: "Body" }), "# Plan\n\nBody");
  assert.equal(noteChatText({ title: "", body: "Body" }), "Body");
});

test("the handoff is account-bound, single-use, and expires", () => {
  clearNoteHandoff();
  offerNoteToChat("alice", { id: "note_1", title: "Plan", body: "Body" }, 1000);
  assert.equal(takeNoteHandoff("bob", 1000), null);
  assert.equal(peekNoteHandoff(), null);
  offerNoteToChat("alice", { id: "note_1", title: "Plan", body: "Body" }, 1000);
  const first = takeNoteHandoff("alice", 1000);
  assert.equal(first?.text, "# Plan\n\nBody");
  assert.equal(takeNoteHandoff("alice", 1000), null);

  offerNoteToChat("alice", { id: "note_1", title: "Plan", body: "Body" }, 1000);
  assert.equal(takeNoteHandoff("alice", 1000 + HANDOFF_TTL_MS + 1), null);
});
