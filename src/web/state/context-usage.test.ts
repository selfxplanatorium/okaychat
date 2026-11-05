import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompactionState } from "../../shared/types";
import { contextUsage } from "./context-usage";

const messages = [
  { id: "u1", role: "user", metadata: {} },
  { id: "a1", role: "assistant", metadata: { custom: { contextTokens: 100_000, contextWindow: 1_100_000 } } },
  { id: "u2", role: "user", metadata: {} },
  { id: "a2", role: "assistant", metadata: { custom: { contextTokens: 143_000, contextWindow: 1_100_000 } } },
];
const compaction: CompactionState = {
  trim: { throughMessageId: "a1", lastMessageId: "a2", tokensBefore: 143_000, tokensAfter: 7_000, createdAt: 1 },
};

const tokensOf = (usage: ReturnType<typeof contextUsage>) => (usage && "tokens" in usage ? usage : null);

test("the meter switches from the provider count to the trim estimate when metadata refreshes", () => {
  assert.deepEqual(tokensOf(contextUsage(messages, null)), { tokens: 143_000, window: 1_100_000 });
  assert.deepEqual(tokensOf(contextUsage(messages, compaction)), { tokens: 7_000, window: 1_100_000 });
  assert.equal(tokensOf(contextUsage(messages, { trim: { ...compaction.trim!, tokensAfter: 0 } }))?.tokens, 0);
});

test("the trim estimate persists through an unreported reply, then yields to newer provider usage", () => {
  const later = [...messages, { id: "u3", role: "user", metadata: {} }, { id: "a3", role: "assistant", metadata: {} }];
  assert.equal(tokensOf(contextUsage(later, compaction))?.tokens, 7_000);
  later[5] = { id: "a3", role: "assistant", metadata: { custom: { contextTokens: 8_000, contextWindow: 1_100_000 } } };
  assert.equal(tokensOf(contextUsage(later, compaction))?.tokens, 8_000);
});

test("trim estimates do not apply to another branch or history already covered by a summary", () => {
  for (const missing of ["a1", "a2"]) {
    const branch = messages.filter((m) => m.id !== missing);
    assert.deepEqual(contextUsage(branch, compaction), contextUsage(branch, null));
  }
  assert.equal(tokensOf(contextUsage(messages, { ...compaction, boundaryMessageId: "a1", summary: "Earlier work" }))?.tokens, 143_000);
});

test("empty history has no usage, while a trim can supply an estimate without provider metadata", () => {
  assert.equal(contextUsage([], compaction), null);
  assert.deepEqual(tokensOf(contextUsage(messages.map((m) => ({ ...m, metadata: {} })), compaction)), { tokens: 7_000, window: 0 });
});

test("an agent reply ends managed context instead of walking back to an older LLM measurement", () => {
  const agentReply = { id: "a3", role: "assistant", metadata: { custom: { modelRef: "n8n/agt_x", usageMode: "agent" } } };
  assert.deepEqual(contextUsage([...messages, { id: "u3", role: "user", metadata: {} }, agentReply], compaction), { unmanaged: "agent" });
  // Switching back to an LLM without a new reply must not resurrect the previous measurement either.
  assert.deepEqual(contextUsage([...messages, { id: "u3", role: "user", metadata: {} }, agentReply], null), { unmanaged: "agent" });
  assert.deepEqual(contextUsage([{ id: "u1", role: "user", metadata: {} }, agentReply], compaction), { unmanaged: "agent" });
});
