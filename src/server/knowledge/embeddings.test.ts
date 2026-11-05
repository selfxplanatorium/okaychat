import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-knowledge-embeddings-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "knowledge-embeddings-test-secret";
const { db } = await import("../db.js");
const { deleteConnection, saveConnection } = await import("../catalog/providers.js");
const { setModelAccessPolicies } = await import("../entitlements.js");
const { EmbeddingError, cosine, createEmbedder, decodeVector, embeddingOptions, encodeVector, normalizeVector, withRetry, MAX_RESPONSE_BYTES, MAX_VECTOR_DIMENSIONS, MAX_RETRY_AFTER_MS } = await import("./embeddings.js");

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
  assert.throws(() => normalizeVector([Number.MAX_VALUE, Number.MAX_VALUE]), /too large|non-finite/i);
  assert.throws(() => normalizeVector(new Array(MAX_VECTOR_DIMENSIONS + 1).fill(1)), /dimensions/i);
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

  // A provider's real Retry-After must not be shortened to the exponential backoff cap.
  const longDelays: number[] = [];
  await assert.rejects(
    withRetry(async () => { throw new EmbeddingError("rate limited", 429, 60_000); }, { attempts: 2, sleep: async (ms) => { longDelays.push(ms); } }),
    /rate limited/,
  );
  assert.deepEqual(longDelays, [60_000]);
  const clamped: number[] = [];
  await assert.rejects(
    withRetry(async () => { throw new EmbeddingError("rate limited", 429, 10 * 60_000); }, { attempts: 2, sleep: async (ms) => { clamped.push(ms); } }),
    /rate limited/,
  );
  assert.deepEqual(clamped, [MAX_RETRY_AFTER_MS], "an absurd wait is bounded but still not hammered at 8 s");

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

test("OpenAI-compatible indexes are sorted, validated, or rejected", async () => {
  const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const outOfOrder = createEmbedder("alice", { provider: "compatible", providerId: "custom-mock", model: "embed" }, {
    fetchImpl: (async () => respond({ data: [{ index: 1, embedding: [0, 4] }, { index: 0, embedding: [3, 0] }] })) as typeof fetch,
  })!;
  const [first, second] = await outOfOrder.embed(["one", "two"]);
  assert.deepEqual([...first!], [1, 0]);
  assert.deepEqual([...second!], [0, 1]);

  const duplicate = createEmbedder("alice", { provider: "compatible", providerId: "custom-mock", model: "embed" }, {
    fetchImpl: (async () => respond({ data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }] })) as typeof fetch,
  })!;
  await assert.rejects(duplicate.embed(["one", "two"]), /duplicate embedding indexes/);

  const mixed = createEmbedder("alice", { provider: "compatible", providerId: "custom-mock", model: "embed" }, {
    fetchImpl: (async () => respond({ data: [{ index: 0, embedding: [1, 0] }, { embedding: [0, 1] }] })) as typeof fetch,
  })!;
  await assert.rejects(mixed.embed(["one", "two"]), /invalid embedding index/);

  const legacy = createEmbedder("alice", { provider: "compatible", providerId: "custom-mock", model: "embed" }, {
    fetchImpl: (async () => respond({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] })) as typeof fetch,
  })!;
  const legacyRows = await legacy.embed(["one", "two"]);
  assert.deepEqual(legacyRows.map((row) => [...row]), [[1, 0], [0, 1]], "providers without indexes keep response order");
});

test("embedding requests time out, cancel, and bound the response body", async () => {
  const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })) as typeof fetch;
  const timed = createEmbedder("alice", { provider: "compatible", providerId: "custom-mock", model: "embed" }, { fetchImpl: hanging, timeoutMs: 25 })!;
  // AbortSignal.timeout does not keep the event loop alive, so hold it open or node:test cancels the rest of the file.
  const hold = setInterval(() => {}, 1_000);
  await assert.rejects(timed.embed(["hello"]).finally(() => clearInterval(hold)),(error) => (error as Error).name === "TimeoutError" || (error as Error).name === "AbortError");

  const controller = new AbortController();
  const cancelled = createEmbedder("alice", { provider: "compatible", providerId: "custom-mock", model: "embed" }, { fetchImpl: hanging, timeoutMs: 5_000 })!;
  const pending = cancelled.embed(["hello"], controller.signal);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, (error) => (error as Error).name === "AbortError");

  const oversized = createEmbedder("alice", { provider: "compatible", providerId: "custom-mock", model: "embed" }, {
    fetchImpl: (async () => new Response("x".repeat(MAX_RESPONSE_BYTES + 1), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch,
  })!;
  await assert.rejects(oversized.embed(["hello"]), /larger than/);
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

test("embedding failures never store provider bodies containing credentials or document text", async () => {
  const privateText = "CONFIDENTIAL document excerpt";
  for (const status of [401, 500]) {
    const embedder = createEmbedder("alice", { provider: "compatible", providerId: "custom-mock", model: "embed" }, {
      fetchImpl: (async () => Response.json({ error: { message: `apiKey=sk-private-value ${privateText}` } }, { status })) as typeof fetch,
      sleep: async () => {},
    })!;
    await assert.rejects(embedder.embed([privateText]), (error: unknown) => {
      assert.ok(error instanceof EmbeddingError);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /sk-private-value|CONFIDENTIAL/);
      assert.match(error.message, /credentials|overloaded/);
      return true;
    });
  }
});

test("a shared key serves embeddings only when the user's model policy allows the embedding model", async () => {
  saveConnection(null, "openai", { apiKey: "sk-shared", enabled: true });
  const everyone = { kind: "everyone" as const, id: "" };
  try {
    const offered = async () => (await embeddingOptions("alice")).some((option) => option.provider === "openai");
    assert.equal(await offered(), true);
    assert.ok(createEmbedder("alice", { provider: "openai" }));

    setModelAccessPolicies("openai", [{ target: everyone, mode: "selected", modelIds: ["gpt-a"] }]);
    assert.equal(await offered(), false);
    assert.throws(() => createEmbedder("alice", { provider: "openai" }), (error) => error instanceof EmbeddingError && /administrator/.test(error.message));

    setModelAccessPolicies("openai", [{ target: everyone, mode: "selected", modelIds: ["text-embedding-3-small"] }]);
    assert.equal(await offered(), true);
    assert.ok(createEmbedder("alice", { provider: "openai" }));
  } finally {
    deleteConnection(null, "openai");
  }
});

test("a pinned embedder stops remaining batches when its owner is demoted", async () => {
  const { resolvePinnedConnection } = await import("../catalog/providers.js");
  const { requestKnowledgeRevocation } = await import("./revocation.js");
  const pin = resolvePinnedConnection("alice", "custom-mock")!;
  let calls = 0;
  const embedder = createEmbedder("alice", { provider: "compatible", providerId: "custom-mock", model: "embed" }, {
    fetchImpl: (async () => {
      calls++;
      db.prepare("UPDATE users SET role = 'user' WHERE id = 'alice'").run();
      requestKnowledgeRevocation();
      return Response.json({ data: Array.from({ length: 16 }, () => ({ embedding: [1, 0] })) });
    }) as typeof fetch,
  }, { connection: pin.connection, providerId: "custom-mock" })!;
  try {
    await assert.rejects(embedder.embed(new Array(32).fill("private text")));
    assert.equal(calls, 1);
  } finally {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = 'alice'").run();
  }
});

test("a shared embedding model revocation aborts a batch already in flight", async () => {
  const { resolvePinnedConnection } = await import("../catalog/providers.js");
  saveConnection(null, "openai", { apiKey: "sk-shared", enabled: true });
  setModelAccessPolicies("openai", [{ target: { kind: "everyone", id: "" }, mode: "all", modelIds: [] }]);
  const pin = resolvePinnedConnection("alice", "openai")!;
  let calls = 0;
  const embedder = createEmbedder("alice", { provider: "openai" }, {
    fetchImpl: (async () => {
      calls++;
      setModelAccessPolicies("openai", [{ target: { kind: "everyone", id: "" }, mode: "selected", modelIds: ["gpt-a"] }]);
      return Response.json({ data: [{ embedding: [1, 0] }] });
    }) as typeof fetch,
  }, { connection: pin.connection, providerId: "openai" })!;
  try {
    await assert.rejects(embedder.embed(["private text"]));
    assert.equal(calls, 1);
  } finally {
    deleteConnection(null, "openai");
  }
});
