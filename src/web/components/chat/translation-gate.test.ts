/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { translationGateState, type TranslationGateInput } from "./translation-gate.js";

// The disabled matrix for Translate. Temporary, unsaved, syncing, and running replies must never look
// usable, and the account switch, a missing model, and empty text each name their own reason.

const base: TranslationGateInput = {
  threadId: "thr_1",
  temporary: false,
  sync: undefined,
  stored: true,
  running: false,
  editing: false,
  enabled: true,
  hasModel: true,
  hasText: true,
};

const reasonOf = (patch: Partial<TranslationGateInput>) => translationGateState({ ...base, ...patch });

test("a saved, idle message with text and a model is translatable", () => {
  assert.deepEqual(reasonOf({}), { available: true, reason: null });
});

test("temporary and unsaved chats ask the user to save the chat first", () => {
  assert.deepEqual(reasonOf({ temporary: true }), { available: false, reason: "annotations.saveChatFirst" });
  assert.deepEqual(reasonOf({ threadId: null }), { available: false, reason: "annotations.saveChatFirst" });
});

test("an unacknowledged message waits for storage, and a stale sync asks for a reload", () => {
  assert.deepEqual(reasonOf({ stored: false }), { available: false, reason: "annotations.savingMessage" });
  assert.deepEqual(reasonOf({ sync: "stale", stored: false }), { available: false, reason: "annotations.messageNotStored" });
  assert.deepEqual(reasonOf({ sync: "pending" }), { available: false, reason: "annotations.syncRequired" });
});

test("a running reply or an open editor blocks the action", () => {
  assert.deepEqual(reasonOf({ running: true }), { available: false, reason: "annotations.busy" });
  assert.deepEqual(reasonOf({ editing: true }), { available: false, reason: "annotations.busy" });
});

test("the account switch, a missing model, and empty text have their own reasons", () => {
  assert.deepEqual(reasonOf({ enabled: false }), { available: false, reason: "translation.off" });
  assert.deepEqual(reasonOf({ hasModel: false }), { available: false, reason: "translation.noModel" });
  assert.deepEqual(reasonOf({ hasText: false }), { available: false, reason: "translation.empty" });
});
