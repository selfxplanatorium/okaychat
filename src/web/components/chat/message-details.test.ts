/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMetadata } from "../../../shared/types.js";
import { compactUsage, hasReplyDetails, replyDetailRows } from "./message-details.js";

const usage = { input: 12_000, output: 3_400, reasoning: 900, cacheRead: 8_000, cacheWrite: 400 };

const row = (meta: AssistantMetadata, key: string) => replyDetailRows(meta, "Model name")!.find((r) => r.key === key)!;

test("an entirely empty metadata block has nothing to show", () => {
  assert.equal(hasReplyDetails({}), false);
  assert.equal(replyDetailRows({}, undefined), null);
});

test("missing values stay missing while reported zeros stay zero", () => {
  const meta: AssistantMetadata = { modelRef: "acme/unknown", usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, durationMs: 0 };
  const rows = replyDetailRows(meta, undefined)!;
  assert.deepEqual(rows.map((r) => r.key), ["model", "input", "cacheRead", "cacheWrite", "output", "reasoning", "cost", "duration"]);
  assert.deepEqual(row(meta, "model").value, { kind: "text", text: "Model name" }, "a known catalog name wins over the ref");
  assert.deepEqual(
    replyDetailRows(meta, undefined)!.find((r) => r.key === "model")!.value,
    { kind: "text", text: "acme/unknown" },
    "an unknown model falls back to its stored ref",
  );
  assert.deepEqual(row(meta, "input").value, { kind: "tokens", value: 0 });
  assert.deepEqual(row(meta, "cost").value, { kind: "cost", value: 0 });
  assert.deepEqual(row(meta, "duration").value, { kind: "seconds", value: 0 });

  const partial: AssistantMetadata = { modelRef: "acme/one", durationMs: 41_000 };
  assert.equal(row(partial, "input").value, null, "no usage means not reported, not zero");
  assert.equal(row(partial, "cost").value, null);
  assert.deepEqual(row(partial, "duration").value, { kind: "seconds", value: 41 });
  assert.deepEqual(row(partial, "model").value, { kind: "text", text: "Model name" });
});

test("totals are the stored multi-step values, and cost is not recalculated", () => {
  const meta: AssistantMetadata = { modelRef: "acme/one", usage, cost: 0.1234 };
  assert.deepEqual(row(meta, "input").value, { kind: "tokens", value: 12_000 });
  assert.deepEqual(row(meta, "cacheRead").value, { kind: "tokens", value: 8_000 });
  assert.deepEqual(row(meta, "output").value, { kind: "tokens", value: 3_400 });
  assert.deepEqual(row(meta, "reasoning").value, { kind: "tokens", value: 900 });
  assert.deepEqual(row(meta, "cost").value, { kind: "cost", value: 0.1234 });
});

test("the compact footer only carries present values", () => {
  assert.deepEqual(compactUsage({ usage }), { usage });
  assert.deepEqual(compactUsage({ usage, cost: 0, durationMs: 1500 }), { usage, cost: 0, durationMs: 1500 });
  assert.deepEqual(compactUsage({ modelRef: "acme/one" }), { usage: undefined });
});
