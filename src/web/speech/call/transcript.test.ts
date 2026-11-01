import assert from "node:assert/strict";
import { test } from "node:test";
import { isSpokenMessage } from "./transcript";

test("local chat replies belong to the spoken exchange even without copied metadata", () => {
  const messages = [
    { role: "user", metadata: { modality: "voice" } },
    { role: "assistant" },
    { role: "assistant" },
    { role: "user" },
    { role: "assistant" },
  ];
  assert.equal(isSpokenMessage(messages, 0), true);
  assert.equal(isSpokenMessage(messages, 1), true);
  assert.equal(isSpokenMessage(messages, 2), true);
  assert.equal(isSpokenMessage(messages, 3), false);
  assert.equal(isSpokenMessage(messages, 4), false);
});

test("Realtime's explicit voice metadata works without a preceding spoken user", () => {
  const messages = [{ role: "assistant", metadata: { modality: "voice" } }];
  assert.equal(isSpokenMessage(messages, 0), true);
  assert.equal(isSpokenMessage(messages, -1), false);
  assert.equal(isSpokenMessage(messages, 1), false);
});
