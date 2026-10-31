import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-knowledge-embeddings-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "knowledge-embeddings-test-secret";
const { db } = await import("../db.js");
const { saveConnection } = await import("../catalog/providers.js");
const { EmbeddingError, cosine, createEmbedder, decodeVector, encodeVector, normalizeVector, withRetry } = await import("./embeddings.js");

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'x', 'admin', 1)").run();
saveConnection("alice", "custom-mock", { baseURL: "http://mock.test/v1", apiKey: "test-key" });
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });

test("vectors are normalized, finite, and round-trip through float32 storage", () => {
  const vector = normalizeVector([3, 4]);
  assert.ok(Math.abs(vector[0]! - 0.6) < 1e-6);
  assert.ok(Math.abs(vector[1]! - 0.8) < 1e-6);
  assert.ok(Math.abs(cosine(vector, vector) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(vector, normalizeVector([1, 0])) - 0.6) < 1e-6);
  const decoded = decodeVector(encodeVector(vector))!;
  assert.deepEqual([...decoded], [...vector]);
  assert.equal(decodeVector(new Uint8Array([1, 2, 3])), null);
  assert.throws(() => normalizeVector([]), EmbeddingError);
  assert.throws(() => normalizeVector([1, Number.NaN]), EmbeddingError);
  assert.throws(() => normalizeVector([0, 0]), EmbeddingError);
});

test("retry honors Retry-After and stops on client errors", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const result = await withRetry(async () => {
    attempts++;
    if (attempts < 3) throw new EmbeddingError("rate limited", 429, 7);
    return "ok";
  }, { sleep: async (ms) => { delays.push(ms); } });
  assert.equal(result, "ok");
  assert.deepEqual(delays, [7, 7]);

  const sleep = async (ms: number) => { delays.push(ms); };
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new EmbeddingError("bad request", 400); }, { sleep }),
    /bad request/,
  );
  assert.equal(calls, 1, "a 400 is not retried");
  assert.throws(() => normalizeVector([1, Infinity]), EmbeddingError);
});

test("the compatible endpoint validates count and dimensions", async () => {
  const embedder = createEmbedder("alice", { provider: "compatible", providerId: "custom-mock", model: "embed" })!;
  const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const ok = createEmbedder("alice", { provider: "compatible", providerId: "custom-mock", model: "embed" }, {
    fetchImpl: (async () => respond({ data: [{ embedding: [3, 4] }] })) as typeof fetch,
  })!;
  const [vector] = await ok.embed(["hello"]);
  assert.ok(Math.abs(vector![0]! - 0.6) < 1e-6);

  const wrongCount = createEmbedder("alice", { provider: "compatible", providerId: "custom-mock", model: "embed" }, {
    fetchImpl: (async () => respond({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] })) as typeof fetch,
  })!;
  await assert.rejects(wrongCount.embed(["one"]), /returned 2 embeddings for 1/);

  const malformed = createEmbedder("alice", { provider: "compatible", providerId: "custom-mock", model: "embed" }, {
    fetchImpl: (async () => respond({ data: [{ embedding: [1, "nope"] }] })) as typeof fetch,
  })!;
  await assert.rejects(malformed.embed(["one"]), /non-finite/);

  // The default embedder resolves the stored connection; a missing one fails with an actionable message.
  assert.throws(() => createEmbedder("alice", { provider: "openai" }), /not enabled/);
  assert.equal(createEmbedder("alice", { provider: "none" }), null);
  void embedder;
});

test("a rate-limited response is retried, then succeeds", async () => {
  let calls = 0;
  const delays: number[] = [];
  const embedder = createEmbedder("alice", { provider: "compatible", providerId: "custom-mock", model: "embed" }, {
    fetchImpl: (async () => {
      calls++;
      if (calls === 1) return new Response("slow down", { status: 429, headers: { "Retry-After": "0" } });
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 });
    }) as typeof fetch,
    sleep: async (ms) => { delays.push(ms); },
  })!;
  const [vector] = await embedder.embed(["hello"]);
  assert.equal(calls, 2);
  assert.equal(delays.length, 1);
  assert.deepEqual([...vector!], [1, 0]);
});

test("an aborted request stops before any retry", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new EmbeddingError("rate limited", 429, 1); }, { signal: controller.signal }),
    (error) => (error as Error).name === "AbortError",
  );
  assert.equal(calls, 0);
});
