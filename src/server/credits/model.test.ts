import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import type { LanguageModelV4, LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import type { ModelInfo } from "../../shared/types.js";
import { db } from "../db.js";
import { creditModelMiddleware, rawCreditUsage } from "./model.js";
import { admitCreditRoot, closeCreditRoot, getCreditBalance, type CreditPermit } from "./store.js";
import { recoverCreditOperations } from "./recovery.js";
const info = { id: "test", providerId: "test", cost: undefined } as ModelInfo;
const raw = (input: number | undefined, output: number | undefined): LanguageModelV4Usage => ({ inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: output, text: undefined, reasoning: undefined } });
beforeEach(() => {
  db.exec("DELETE FROM users");
  db.exec("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES ('meter','meter@example.test','Meter','unused','user',1)");
});
function adapter(permit: CreditPermit, parts: LanguageModelV4StreamPart[], onCancel = () => {}) {
  const model: LanguageModelV4 = {
    specificationVersion: "v4", provider: "test", modelId: "test", supportedUrls: {},
    doGenerate: async () => ({ content: [], finishReason: { unified: "stop", raw: "stop" }, usage: raw(10, 2), warnings: [] }),
    doStream: async () => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({
      pull(c) { const p = parts.shift(); if (p) c.enqueue(p); else c.close(); }, cancel() { onCancel(); },
    }, { highWaterMark: 0 }), warnings: [] }),
  };
  return wrapLanguageModel({ model, middleware: creditModelMiddleware({ permit, userId: "meter", model: info, kind: "chat" }) });
}
const finish = (): LanguageModelV4StreamPart => ({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: raw(10, 2) });
test("raw totals preserve missing telemetry and reject invalid totals", () => {
  assert.equal(rawCreditUsage(undefined), undefined);
  for (const n of [undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.equal(rawCreditUsage(raw(n, 1)), undefined);
  assert.deepEqual(rawCreditUsage(raw(0, 0)), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  const usage = raw(100, 30);
  usage.inputTokens.cacheRead = 200; usage.inputTokens.cacheWrite = 20; usage.outputTokens.reasoning = 50;
  assert.deepEqual(rawCreditUsage(usage), { input: 100, output: 30, cacheRead: 100, cacheWrite: 0, reasoning: 30 });
});
test("generate reports once and records canonical usage", async () => {
  const permit = admitCreditRoot("meter", "chat");
  await adapter(permit, []).doGenerate({ prompt: [] });
  assert.equal(getCreditBalance("meter").consumedTokens, 12);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage").get()?.n, 1);
  closeCreditRoot(permit);
});
test("finish is persisted before being forwarded and later cancel cannot replace it", async () => {
  const permit = admitCreditRoot("meter", "chat");
  let cancelled = false;
  const { stream } = await adapter(permit, [finish()], () => { cancelled = true; }).doStream({ prompt: [] });
  const reader = stream.getReader();
  assert.equal(getCreditBalance("meter").consumedTokens, 0);
  await reader.read();
  assert.equal(getCreditBalance("meter").consumedTokens, 12);
  await reader.cancel();
  assert.equal(cancelled, true);
  assert.equal(getCreditBalance("meter").unknownRequests, 0);
  closeCreditRoot(permit);
});
test("cancel without pulling marks usage unknown and cancels upstream", async () => {
  const permit = admitCreditRoot("meter", "chat");
  let cancelled = false;
  const { stream } = await adapter(permit, [finish()], () => { cancelled = true; }).doStream({ prompt: [] });
  await stream.cancel();
  assert.equal(cancelled, true);
  assert.equal(getCreditBalance("meter").consumedTokens, 0);
  assert.equal(getCreditBalance("meter").unknownRequests, 1);
  closeCreditRoot(permit);
});
test("EOF without a finish is unknown", async () => {
  const permit = admitCreditRoot("meter", "chat");
  const { stream } = await adapter(permit, []).doStream({ prompt: [] });
  for await (const _ of stream) { /* consume */ }
  assert.equal(getCreditBalance("meter").unknownRequests, 1);
  closeCreditRoot(permit);
});
test("abort before dispatch is free with no unknown hold", async () => {
  const permit = admitCreditRoot("meter", "chat");
  await assert.rejects(adapter(permit, []).doGenerate({ prompt: [], abortSignal: AbortSignal.abort() }));
  assert.equal(getCreditBalance("meter").unknownRequests, 0);
  assert.equal(getCreditBalance("meter").consumedTokens, 0);
  closeCreditRoot(permit);
});
test("settlement failure leaves request open and root held", async () => {
  const permit = admitCreditRoot("meter", "chat");
  db.exec("CREATE TRIGGER credit_block BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT,'failure'); END");
  try {
    const { stream } = await adapter(permit, [finish()]).doStream({ prompt: [] });
    await assert.rejects(stream.getReader().read());
    assert.equal(db.prepare("SELECT state FROM token_credit_requests").get()?.state, "open");
    assert.equal(getCreditBalance("meter").unknownRequests, 0);
    assert.throws(() => closeCreditRoot(permit));
  } finally { db.exec("DROP TRIGGER credit_block"); }
  recoverCreditOperations();
});
test("recovery settles dispatched unknown and undispatched free exactly once", async () => {
  const { beginCreditRequest, markCreditDispatched, assertCreditPermit } = await import("./store.js");
  const permit = admitCreditRoot("meter", "chat");
  const dispatched = beginCreditRequest(permit, { providerId: "test", modelId: "test", kind: "chat" });
  markCreditDispatched(dispatched);
  const pending = beginCreditRequest(permit, { providerId: "test", modelId: "test", kind: "chat" });
  recoverCreditOperations(); recoverCreditOperations();
  assert.equal(getCreditBalance("meter").unknownRequests, 1);
  assert.equal(getCreditBalance("meter").consumedTokens, 0);
  assert.equal(getCreditBalance("meter").activeOperations, 0);
  assert.equal(db.prepare("SELECT state FROM token_credit_requests WHERE id=?").get(pending)?.state, "not_dispatched");
  assert.equal(db.prepare("SELECT state FROM token_credit_requests WHERE id=?").get(dispatched)?.state, "unknown");
  assert.throws(() => assertCreditPermit(permit, "meter"));
  closeCreditRoot(permit); closeCreditRoot(permit);
});
test("error frames without final usage stay unknown, but errors after finish preserve the debit", async () => {
  for (const reported of [false, true]) {
    const permit = admitCreditRoot("meter", "chat");
    const parts: LanguageModelV4StreamPart[] = [...(reported ? [finish()] : []), { type: "error", error: new Error("connection lost") }];
    const { stream } = await adapter(permit, parts).doStream({ prompt: [] });
    for await (const _ of stream) { /* consume */ }
    closeCreditRoot(permit);
  }
  assert.equal(getCreditBalance("meter").unknownRequests, 1);
  assert.equal(getCreditBalance("meter").consumedTokens, 12);
});
