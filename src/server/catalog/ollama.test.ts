import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";

// A real HTTP server on an ephemeral loopback port stands in for the Ollama daemon. These tests cover
// the native protocol and the app's authorization around it, not the daemon itself.
const calls: Array<{ method: string; url: string; body: unknown }> = [];
let pullMode: "normal" | "error" | "slow" | "hang" | "huge" | "null" = "normal";
let embedMode: "normal" | "malformed" = "normal";
let pullClosed: Promise<void> | null = null;

const tags = {
  models: [
    { name: "llama3.2:latest", size: 2_019_393_189, digest: "sha256:aaa", modified_at: "2026-10-01T10:00:00Z", details: { family: "llama", families: ["llama"], parameter_size: "3.2B", quantization_level: "Q4_K_M" } },
    { name: "qwen3:8b", size: 5_200_000_000, digest: "sha256:bbb", details: { family: "qwen3", families: ["qwen3"], parameter_size: "8.2B", quantization_level: "Q4_K_M" } },
    { name: "nomic-embed-text:latest", size: 274_000_000, digest: "sha256:ccc", details: { family: "nomic-bert", parameter_size: "137M", quantization_level: "F16" } },
    { name: "broken:latest", size: 100, digest: "sha256:ddd", details: { family: "unknown" } },
  ],
};
const shows: Record<string, object> = {
  "llama3.2:latest": {
    details: { family: "llama", families: ["llama"], parameter_size: "3.2B", quantization_level: "Q4_K_M" },
    capabilities: ["completion", "tools", "vision", "thinking"],
    model_info: { "general.architecture": "llama", "llama.context_length": 131072, "llama.embedding_length": 4096 },
  },
  "qwen3:8b": {
    details: { family: "qwen3", families: ["qwen3"], parameter_size: "8.2B", quantization_level: "Q4_K_M" },
    capabilities: ["completion", "tools"],
    model_info: { "general.architecture": "qwen3", "qwen3.context_length": 40960 },
  },
  "nomic-embed-text:latest": {
    details: { family: "nomic-bert", parameter_size: "137M", quantization_level: "F16" },
    capabilities: ["embedding"],
    model_info: { "general.architecture": "bert", "bert.context_length": 8192, "bert.embedding_length": 768 },
  },
};

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const server = createServer(async (req, res) => {
  const payload = await body(req);
  calls.push({ method: req.method!, url: req.url!, body: payload });
  const model = (payload as { model?: string } | undefined)?.model;
  res.setHeader("Content-Type", "application/json");
  if (req.method === "GET" && req.url === "/api/version") return res.end(JSON.stringify({ version: "0.12.3" }));
  if (req.method === "GET" && req.url === "/api/tags") return res.end(JSON.stringify(tags));
  if (req.method === "GET" && req.url === "/api/ps") {
    return res.end(JSON.stringify({ models: [{ name: "llama3.2:latest", model: "llama3.2:latest", size: 2_100_000_000, size_vram: 1_900_000_000, expires_at: "2026-10-31T12:00:00Z" }] }));
  }
  if (req.method === "POST" && req.url === "/api/show") {
    const show = model ? shows[model] : undefined;
    if (!show) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: `metadata for ${model ?? "unknown"} failed` }));
    }
    return res.end(JSON.stringify(show));
  }
  if (req.method === "DELETE" && req.url === "/api/delete") {
    if (model === "missing:latest") {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: `model '${model}' not found` }));
    }
    return res.end("{}");
  }
  if (req.method === "POST" && req.url === "/api/embed") {
    if (embedMode === "malformed") return res.end(JSON.stringify({ embeddings: [[1, "bad"]] }));
    return res.end(JSON.stringify({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }));
  }
  if (req.method === "POST" && req.url === "/api/pull") {
    res.setHeader("Content-Type", "application/x-ndjson");
    if (pullMode === "error") return res.end(`${JSON.stringify({ status: "pulling manifest" })}\n${JSON.stringify({ error: "not enough disk space" })}\n`);
    if (pullMode === "null") return res.end("null\n");
    if (pullMode === "huge") return res.end("x".repeat(2 * 1024 * 1024));
    if (pullMode === "hang") {
      // Never finishes on its own; only an upstream abort closes this socket.
      res.write(`${JSON.stringify({ status: "pulling manifest" })}\n`);
      pullClosed = new Promise<void>((resolve) => res.once("close", () => resolve()));
      await pullClosed;
      return;
    }
    res.write(`${JSON.stringify({ status: "pulling manifest" })}\n{"status":"downloading","digest":"sha256:layer1","total":1000,`);
    if (pullMode === "slow") {
      // The client aborts after the first event; the socket closing ends this response.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (!res.destroyed) res.end();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    res.write(`"completed":250}\n${JSON.stringify({ status: "downloading", digest: "sha256:layer1", total: 1000, completed: 750 })}\n`);
    // No trailing newline: the parser must still take the final line.
    res.end(JSON.stringify({ status: "success" }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const conn = { baseURL };

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-ollama-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "ollama-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("../db.js");
const { requireUser } = await import("../auth.js");
const { sha256 } = await import("../crypto.js");
const { api } = await import("../routes.js");
const { adminRoutes } = await import("../admin.js");
const { getConnection, listModels, listProviders, saveConnection } = await import("./providers.js");
const {
  forgetOllamaModels,
  ollamaDelete,
  ollamaEmbed,
  ollamaInventory,
  ollamaModels,
  ollamaPull,
  ollamaStatus,
  OllamaError,
} = await import("./ollama.js");

for (const [id, role] of [["admin", "admin"], ["alice", "user"]] as const) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", role, Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
}
after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
  pullMode = "normal";
  embedMode = "normal";
  db.exec("DELETE FROM provider_connections; DELETE FROM shared_connections; DELETE FROM share_audiences; DELETE FROM share_users; DELETE FROM share_groups;");
  forgetOllamaModels();
});

const as = (user: string, url: string, init?: RequestInit) => api.request(url, { ...init, headers: { Cookie: `okaychat_session=${user}`, "Content-Type": "application/json", ...init?.headers } });
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
test("lists installed chat models from tags and show, keeping native metadata authoritative", async () => {
  const models = await ollamaModels(conn);
  assert.deepEqual(models.map((m) => m.ref).sort(), ["ollama/llama3.2:latest", "ollama/qwen3:8b"]);
  const llama = models.find((m) => m.id === "llama3.2:latest")!;
  assert.equal(llama.format, "ollama");
  assert.equal(llama.context, 131072);
  assert.equal(llama.toolCall, true);
  assert.equal(llama.attachments, true);
  assert.equal(llama.reasoning, true);
  assert.deepEqual(llama.inputModalities, ["text", "image"]);
  assert.equal(llama.baseURL, baseURL);
  const qwen = models.find((m) => m.id === "qwen3:8b")!;
  assert.equal(qwen.context, 40960);
  assert.equal(qwen.reasoning, false);
  assert.equal(qwen.attachments, false);
  // The embedding-only model never reaches the chat picker.
  assert.equal(models.some((m) => m.id === "nomic-embed-text:latest"), false);
  // A second call is served by the cache instead of re-running show for every model.
  const showCalls = calls.filter((c) => c.url === "/api/show").length;
  await ollamaModels(conn);
  assert.equal(calls.filter((c) => c.url === "/api/show").length, showCalls);
});

test("native thinking controls drive honest efforts, and unusable context metadata falls back", async () => {
  tags.models.push({
    name: "gpt-oss:20b",
    size: 1,
    digest: "sha256:eee",
    details: { family: "gptoss", families: ["gptoss"], parameter_size: "20B", quantization_level: "MXFP4" },
  });
  tags.models.push({
    name: "zeroctx:latest",
    size: 1,
    digest: "sha256:fff",
    details: { family: "llama", families: ["llama"], parameter_size: "1B", quantization_level: "Q4" },
  });
  shows["gpt-oss:20b"] = {
    details: { family: "gptoss", families: ["gptoss"], parameter_size: "20B", quantization_level: "MXFP4" },
    capabilities: ["completion", "tools", "thinking"],
    model_info: { "general.architecture": "gptoss", "gptoss.context_length": 32768 },
    thinking: { values: ["low", "medium", "high"], default: "medium" },
  };
  shows["zeroctx:latest"] = {
    details: { family: "llama", families: ["llama"], parameter_size: "1B", quantization_level: "Q4" },
    capabilities: ["completion"],
    model_info: { "general.architecture": "llama", "llama.context_length": 0 },
  };
  try {
    forgetOllamaModels();
    const models = await ollamaModels(conn);
    const oss = models.find((model) => model.id === "gpt-oss:20b")!;
    assert.equal(oss.reasoning, true);
    assert.deepEqual(oss.reasoningEfforts, ["low", "medium", "high"]);
    assert.deepEqual(oss.thinkingLevels, ["low", "medium", "high"]);
    assert.equal(oss.context, 32768);
    // Older daemons without thinking metadata still get an on/off choice, not fake granularity.
    const llama = models.find((model) => model.id === "llama3.2:latest")!;
    assert.deepEqual(llama.reasoningEfforts, ["none", "high"]);
    assert.equal(llama.thinkingLevels, undefined);
    // Zero or negative context is not usable metadata and must not be advertised.
    assert.equal(models.find((model) => model.id === "zeroctx:latest")!.context, 4096);
  } finally {
    tags.models.splice(-2);
    delete shows["gpt-oss:20b"];
    delete shows["zeroctx:latest"];
    forgetOllamaModels();
  }
});

test("lists loaded models and metadata for the management panel", async () => {
  const inventory = await ollamaInventory(conn);
  assert.equal(inventory.status.version, "0.12.3");
  assert.equal(inventory.status.modelCount, 4);
  assert.equal(inventory.status.loadedCount, 1);
  assert.equal(inventory.models.length, 4);
  const llama = inventory.models.find((m) => m.name === "llama3.2:latest")!;
  assert.equal(llama.loaded, true);
  assert.equal(llama.sizeVram, 1_900_000_000);
  assert.equal(llama.expiresAt, "2026-10-31T12:00:00Z");
  assert.equal(llama.parameterSize, "3.2B");
  assert.equal(llama.quantization, "Q4_K_M");
  assert.deepEqual(llama.capabilities, ["completion", "tools", "vision", "thinking"]);
  const embedding = inventory.models.find((m) => m.name === "nomic-embed-text:latest")!;
  assert.equal(embedding.embeddingLength, 768);
  const broken = inventory.models.find((m) => m.name === "broken:latest")!;
  assert.match(broken.showError ?? "", /failed/);
  assert.equal(broken.loaded, false);
});

test("health reports version and counts, and an unreachable daemon errors actionably", async () => {
  assert.deepEqual(await ollamaStatus(conn), { url: baseURL, version: "0.12.3", modelCount: 4, loadedCount: 1 });
  await assert.rejects(() => ollamaStatus({ baseURL: "http://127.0.0.1:1" }), /Could not reach Ollama/);
});

test("pull streams split NDJSON progress including a final line without a newline", async () => {
  const events = [];
  for await (const event of ollamaPull(conn, "llama3.2:latest")) events.push(event);
  assert.deepEqual(events.map((e) => e.status), ["pulling manifest", "downloading", "downloading", "success"]);
  assert.equal(events[1]!.digest, "sha256:layer1");
  assert.equal(events[1]!.completed, 250);
  assert.equal(events[2]!.completed, 750);
  // A successful pull invalidates the cached model list, so the next chat can pick the new model.
  const before = calls.filter((c) => c.url === "/api/tags").length;
  await ollamaModels(conn);
  assert.equal(calls.filter((c) => c.url === "/api/tags").length, before + 1);
});

test("pull error objects reject with the daemon's message", async () => {
  pullMode = "error";
  await assert.rejects(async () => {
    for await (const _event of ollamaPull(conn, "llama3.2:latest")) {
      // consume
    }
  }, /not enough disk space/);
});

test("pull cancellation stops the generator without hanging", { timeout: 5_000 }, async () => {
  pullMode = "slow";
  const controller = new AbortController();
  const iterator = ollamaPull(conn, "llama3.2:latest", controller.signal);
  const first = await iterator.next();
  assert.equal(first.value?.status, "pulling manifest");
  controller.abort();
  const second = await iterator.next();
  assert.equal(second.done, true);
});

test("malformed and overlong pull progress lines become actionable errors", async () => {
  pullMode = "null";
  await assert.rejects(async () => {
    for await (const _event of ollamaPull(conn, "llama3.2:latest")) {
      // consume
    }
  }, /unexpected progress line/);
  pullMode = "huge";
  await assert.rejects(async () => {
    for await (const _event of ollamaPull(conn, "llama3.2:latest")) {
      // consume
    }
  }, /overlong progress line/);
});

test("consumer cancellation of the pull route aborts upstream and only then releases the lock", { timeout: 10_000 }, async () => {
  await as("admin", "/providers/ollama", { method: "PUT", body: JSON.stringify({ baseURL, enabled: true }) });
  pullMode = "hang";
  pullClosed = null;
  const res = await as("admin", "/providers/ollama/pull", { method: "POST", body: JSON.stringify({ model: "qwen3:8b" }) });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /pulling manifest/);
  // Still running: a second pull must not start an overlapping download.
  const duplicate = await as("admin", "/providers/ollama/pull", { method: "POST", body: JSON.stringify({ model: "qwen3:8b" }) });
  assert.equal(duplicate.status, 409);

  await reader.cancel();
  const closed = pullClosed;
  assert.ok(closed, "the mock daemon never started the hanging pull");
  await Promise.race([
    closed,
    new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => reject(new Error("upstream pull socket stayed open after consumer cancel")), 2_000);
      timeout.unref();
    }),
  ]);

  // The lock is released once cleanup finishes, so a later pull can start again.
  pullMode = "normal";
  let restarted = false;
  for (let attempt = 0; attempt < 40 && !restarted; attempt++) {
    const again = await as("admin", "/providers/ollama/pull", { method: "POST", body: JSON.stringify({ model: "qwen3:8b" }) });
    if (again.status === 200) {
      assert.match(await again.text(), /"success"/);
      restarted = true;
    } else {
      assert.equal(again.status, 409);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.equal(restarted, true);
  pullClosed = null;
});

test("delete and embed use the native endpoints and report failures", async () => {
  await ollamaDelete(conn, "qwen3:8b");
  const remove = calls.find((c) => c.url === "/api/delete");
  assert.deepEqual(remove?.body, { model: "qwen3:8b" });
  await assert.rejects(() => ollamaDelete(conn, "missing:latest"), /not installed/);
  assert.deepEqual(await ollamaEmbed(conn, "nomic-embed-text:latest", ["one", "two"]), [[0.1, 0.2], [0.3, 0.4]]);
  embedMode = "malformed";
  await assert.rejects(() => ollamaEmbed(conn, "nomic-embed-text:latest", "one"), /no usable embeddings/);
});

test("a stored admin connection is listed first-class and resolves native chat models", async () => {
  saveConnection("admin", "ollama", { baseURL, enabled: true });
  const stored = getConnection("admin", "ollama");
  assert.equal(stored?.baseURL, baseURL);
  assert.equal(stored?.guarded, undefined);
  assert.equal((db.prepare("SELECT api_key_enc FROM provider_connections WHERE provider_id = 'ollama'").get() as { api_key_enc: string | null }).api_key_enc, null);
  const providers = await listProviders("admin");
  const card = providers.find((p) => p.id === "ollama");
  assert.equal(card?.connected, true);
  assert.equal(card?.baseURL, baseURL);
  const models = (await listModels("admin")).filter((m) => m.providerId === "ollama");
  assert.deepEqual(models.map((m) => m.ref).sort(), ["ollama/llama3.2:latest", "ollama/qwen3:8b"]);
  // The disconnected card exists too, with the documented default.
  db.exec("DELETE FROM provider_connections");
  const disconnected = (await listProviders("admin")).find((p) => p.id === "ollama");
  assert.equal(disconnected?.connected, false);
  assert.equal(disconnected?.baseURL, "http://127.0.0.1:11434");
});

test("user routes expose health, inventory, pull and delete for the owner", { timeout: 5_000 }, async () => {
  assert.equal((await as("admin", "/providers/ollama/status")).status, 404);
  assert.equal((await as("admin", "/providers/ollama", { method: "PUT", body: JSON.stringify({ baseURL, enabled: true }) })).status, 200);
  const status = await json(await as("admin", "/providers/ollama/status"));
  assert.equal(status.ok, true);
  assert.equal(status.version, "0.12.3");
  assert.equal(status.modelCount, 4);
  const inventory = await json(await as("admin", "/providers/ollama/models"));
  assert.equal((inventory.models as unknown[]).length, 4);
  const tested = await json(await as("admin", "/providers/ollama/test", { method: "POST", body: JSON.stringify({ baseURL }) }));
  assert.equal(tested.ok, true);
  const pulled = await as("admin", "/providers/ollama/pull", { method: "POST", body: JSON.stringify({ model: "qwen3:8b" }) });
  assert.equal(pulled.status, 200);
  assert.match(pulled.headers.get("content-type") ?? "", /ndjson/);
  const lines = (await pulled.text()).trim().split("\n").map((line) => JSON.parse(line) as { status?: string });
  assert.equal(lines.at(-1)?.status, "success");
  assert.equal((await as("admin", "/providers/ollama/models", { method: "DELETE", body: JSON.stringify({ model: "qwen3:8b" }) })).status, 200);
});

test("non-admins cannot connect, test, or use local addresses", async () => {
  const put = await as("alice", "/providers/ollama", { method: "PUT", body: JSON.stringify({ baseURL, enabled: true }) });
  assert.equal(put.status, 400);
  assert.match((await json(put)).error as string, /Only admins/);
  const testUrl = await as("alice", "/providers/ollama/test", { method: "POST", body: JSON.stringify({ baseURL }) });
  assert.equal(testUrl.status, 400);
  assert.match((await json(testUrl)).error as string, /Only admins/);
  // Omitting the address means loopback, which is still private.
  const implicit = await as("alice", "/providers/ollama", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  assert.equal(implicit.status, 400);
  assert.match((await json(implicit)).error as string, /Only admins/);
  // Even a row written outside the route stays guarded at request time.
  saveConnection("alice", "ollama", { baseURL, enabled: true });
  assert.equal(getConnection("alice", "ollama")?.guarded, true);
  const status = await as("alice", "/providers/ollama/status");
  assert.equal(status.status, 502);
  assert.equal((await json(status)).code, "forbidden");
});

test("a legacy non-admin Ollama row without a URL is still treated as loopback and guarded", async () => {
  db.prepare("INSERT INTO provider_connections (user_id, provider_id, api_key_enc, base_url, config_json, enabled, created_at) VALUES (?, ?, NULL, NULL, '{}', 1, ?)").run("alice", "ollama", Date.now());
  assert.equal(getConnection("alice", "ollama")?.guarded, true);
  const status = await as("alice", "/providers/ollama/status");
  assert.equal(status.status, 502);
  assert.equal((await json(status)).code, "forbidden");
  // An admin saving without an address gets the documented default stored.
  saveConnection("admin", "ollama", { enabled: true });
  assert.equal(getConnection("admin", "ollama")?.baseURL, "http://127.0.0.1:11434");
  assert.equal(getConnection("admin", "ollama")?.guarded, undefined);
});

test("a shared connection is readable by its viewers but only the admin scope can change its models", async () => {
  saveConnection(null, "ollama", { baseURL, enabled: true });
  const models = await as("alice", "/providers/ollama/models");
  assert.equal(models.status, 200);
  // A viewer may test the admin's stored address; the admin's private-host trust carries over.
  const tested = await as("alice", "/providers/ollama/test", { method: "POST", body: JSON.stringify({ baseURL }) });
  assert.equal(tested.status, 200);
  assert.equal((await json(tested)).version, "0.12.3");
  const pull = await as("alice", "/providers/ollama/pull", { method: "POST", body: JSON.stringify({ model: "qwen3:8b" }) });
  assert.equal(pull.status, 403);
  assert.match((await json(pull)).error as string, /owner/);
  const remove = await as("alice", "/providers/ollama/models", { method: "DELETE", body: JSON.stringify({ model: "qwen3:8b" }) });
  assert.equal(remove.status, 403);
  // The admin's shared scope can pull through the same daemon.
  const adminApp = new Hono<{ Variables: { user: { id: string; role: string }; session: string } }>().use(requireUser).route("/", adminRoutes);
  const res = await adminApp.request("/admin/providers/ollama/pull", {
    method: "POST",
    headers: { Cookie: "okaychat_session=admin", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3:8b" }),
  });
  assert.equal(res.status, 200);
  // A regular user never reaches the admin management routes.
  const denied = await adminApp.request("/admin/providers/ollama/status", { headers: { Cookie: "okaychat_session=alice" } });
  assert.equal(denied.status, 403);
});

test("management errors are surfaced instead of swallowed", async () => {
  await as("admin", "/providers/ollama", { method: "PUT", body: JSON.stringify({ baseURL, enabled: true }) });
  const missing = await as("admin", "/providers/ollama/models", { method: "DELETE", body: JSON.stringify({ model: "missing:latest" }) });
  assert.equal(missing.status, 404);
  // The raw daemon sentence ("not installed") stays in the log; the wire carries the taxonomy.
  assert.equal((await json(missing)).code, "model_not_found");
  const invalid = await as("admin", "/providers/ollama/pull", { method: "POST", body: JSON.stringify({ model: "bad model" }) });
  assert.equal(invalid.status, 400);
  // A daemon that is no longer running still gets a taxonomy code, without echoing the attempted URL.
  db.exec("DELETE FROM provider_connections");
  saveConnection("admin", "ollama", { baseURL: "http://127.0.0.1:1", enabled: true });
  const down = await as("admin", "/providers/ollama/status");
  assert.equal(down.status, 502);
  assert.equal((await json(down)).code, "network");
});

test("the native error type is used for actionable failures", () => {
  assert.ok(new OllamaError("x") instanceof Error);
});


test("shared Ollama inventory follows model policies while admin and own inventories stay complete", async () => {
  const { setModelAccessPolicies } = await import("../entitlements.js");
  saveConnection(null, "ollama", { baseURL, enabled: true });
  setModelAccessPolicies("ollama", [{ target: { kind: "everyone", id: "" }, mode: "selected", modelIds: ["qwen3:8b"] }]);
  const inventory = await json(await as("alice", "/providers/ollama/models"));
  assert.deepEqual((inventory.models as Array<{ name: string }>).map((model) => model.name), ["qwen3:8b"]);
  assert.equal((inventory.status as { modelCount: number }).modelCount, 1);
  assert.equal((inventory.status as { loadedCount: number }).loadedCount, 0);
  const adminApp = new Hono().use(requireUser).route("/", adminRoutes);
  const adminInventory = await json(await adminApp.request("/admin/providers/ollama/models", { headers: { Cookie: "okaychat_session=admin" } }));
  assert.equal((adminInventory.models as unknown[]).length, 4);
  saveConnection("admin", "ollama", { baseURL, enabled: true });
  assert.equal(((await json(await as("admin", "/providers/ollama/models"))).models as unknown[]).length, 4);
  setModelAccessPolicies("ollama", [{ target: { kind: "everyone", id: "" }, mode: "selected", modelIds: [] }]);
  assert.deepEqual((await json(await as("alice", "/providers/ollama/models"))).models, []);
});
