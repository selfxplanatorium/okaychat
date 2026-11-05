/// <reference types="node" />
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { insertPromptText, type InsertOutcome } from "./prompt-insert.js";

// The composer is represented by its two methods; the focus helper finds no textarea in this environment.
const composer = (text: string) => {
  const state = { text };
  const aui = {
    composer: {
      getState: () => ({ text: state.text }),
      setText: (next: string) => {
        state.text = next;
      },
    },
  };
  return { aui: aui as unknown as Parameters<typeof insertPromptText>[0], text: () => state.text };
};

const realRaf = globalThis.requestAnimationFrame;
const realDocument = globalThis.document;
Object.defineProperty(globalThis, "requestAnimationFrame", { value: (frame: FrameRequestCallback) => (frame(0), 0), configurable: true });
Object.defineProperty(globalThis, "document", { value: { querySelector: () => null }, configurable: true });
after(() => {
  Object.defineProperty(globalThis, "requestAnimationFrame", { value: realRaf, configurable: true });
  Object.defineProperty(globalThis, "document", { value: realDocument, configurable: true });
});

const append = { kind: "append" as const };
const replace = (text: string, threadKey = "t1", accountId = "u1") => ({ kind: "replace" as const, text, threadKey, accountId });

test("append keeps the typed text and adds one blank line when needed", () => {
  const one = composer("Hello");
  assert.equal(insertPromptText(one.aui, "Summary", append, "t1"), "inserted");
  assert.equal(one.text(), "Hello\n\nSummary");
  const two = composer("Hello\n\n");
  insertPromptText(two.aui, "Summary", append, "t1");
  assert.equal(two.text(), "Hello\n\nSummary");
  const empty = composer("");
  insertPromptText(empty.aui, "Summary", append, "t1");
  assert.equal(empty.text(), "Summary");
  const spaced = composer("  keep me  ");
  insertPromptText(spaced.aui, "x", append, "t1");
  assert.equal(spaced.text(), "  keep me  \n\nx", "existing whitespace is never trimmed");
});

test("a slash replacement only writes into the chat and text it captured", () => {
  const live = composer("/sum");
  assert.equal(insertPromptText(live.aui, "Expanded", replace("/sum"), "t1", "u1"), "inserted");
  assert.equal(live.text(), "Expanded");

  const changed = composer("/summarize");
  assert.equal(insertPromptText(changed.aui, "Expanded", replace("/sum"), "t1", "u1"), "changed" satisfies InsertOutcome);
  assert.equal(changed.text(), "/summarize");

  const otherChat = composer("/sum");
  assert.equal(insertPromptText(otherChat.aui, "Expanded", replace("/sum", "t2"), "t1", "u1"), "changed");
  assert.equal(otherChat.text(), "/sum");

  const otherAccount = composer("/sum");
  assert.equal(insertPromptText(otherAccount.aui, "Expanded", replace("/sum", "t1", "u2"), "t1", "u1"), "changed");
  assert.equal(otherAccount.text(), "/sum");
});
