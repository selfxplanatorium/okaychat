/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearStoredMessages,
  forgetStoredThread,
  reportStoredMessage,
  reportStoredRows,
  storedMessageExists,
  subscribeStoredMessages,
} from "./message-persistence.js";

test("only acknowledged rows enable a message, and ids are scoped to their chat", () => {
  clearStoredMessages();
  reportStoredRows("t1", ["a", "b"]);
  assert.equal(storedMessageExists("t1", "a"), true);
  assert.equal(storedMessageExists("t1", "missing"), false);
  assert.equal(storedMessageExists("t2", "a"), false, "the same id in another chat is not stored");
  reportStoredMessage("t2", "a");
  assert.equal(storedMessageExists("t2", "a"), true);
  forgetStoredThread("t1");
  assert.equal(storedMessageExists("t1", "a"), false);
  assert.equal(storedMessageExists("t2", "a"), true);
});

test("subscribers hear every change, and sign-out clears everything", () => {
  clearStoredMessages();
  let calls = 0;
  const off = subscribeStoredMessages(() => {
    calls++;
  });
  reportStoredMessage("t1", "a");
  reportStoredMessage("t1", "a");
  assert.equal(calls, 1, "an already known id is not a change");
  reportStoredRows("t1", ["b"]);
  assert.equal(calls, 2);
  clearStoredMessages();
  assert.equal(calls, 3);
  assert.equal(storedMessageExists("t1", "a"), false);
  off();
  reportStoredMessage("t1", "c");
  assert.equal(calls, 3, "an unsubscribed listener is not called");
  clearStoredMessages();
});
