/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "ai";

process.env.OKAYCHAT_SECRET ??= "voice-turn-test-secret-0123456789";
const { isVoiceTurn, withVoiceNotes } = await import("./turn.js");

const user = (id: string, metadata?: Record<string, unknown>): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text: "hello" }], metadata }) as unknown as UIMessage;

test("a spoken turn is recognised with metadata at the top level or under custom", () => {
  assert.equal(isVoiceTurn(user("a", { voiceCall: "local" })), true);
  assert.equal(isVoiceTurn(user("b", { custom: { voiceCall: "local" } })), true);
  assert.equal(isVoiceTurn(user("c", { voiceCall: "realtime" })), false);
  assert.equal(isVoiceTurn({ ...user("d"), role: "assistant" } as UIMessage), false);
});

test("the voice note is added beside every spoken user message and nowhere else", () => {
  const messages = [user("a", { voiceCall: "local" }), { ...user("b"), role: "assistant" } as UIMessage, user("c", { custom: { voiceCall: "local" } })];
  const contexts = new Map([
    ["a", "date"],
    ["b", "should not change"],
    ["c", "memory"],
  ]);
  const out = withVoiceNotes(messages, contexts);
  assert.match(out.get("a")!, /^date\n\nThe user said the next message out loud/);
  assert.match(out.get("c")!, /^memory\n\nThe user said the next message out loud/);
  assert.equal(out.get("b"), "should not change");
  assert.equal(withVoiceNotes([user("d")], contexts), contexts);
});
