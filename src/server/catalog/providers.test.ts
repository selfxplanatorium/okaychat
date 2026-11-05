import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { performance } from "node:perf_hooks";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-providers-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "providers-test-secret-only-not-for-production";
// A tiny offline catalog: the healthy connection needs no network beyond this file.
writeFileSync(
  path.join(dataDir, "models-dev.json"),
  JSON.stringify({
    data: {
      openai: {
        id: "openai",
        name: "OpenAI",
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        models: Object.fromEntries(
          ["gpt-a", "gpt-b"].map((id) => [
            id,
            { id, name: id.toUpperCase(), tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 100_000, output: 8_000 } },
          ]),
        ),
      },
    },
    fetchedAt: Date.now(),
  }),
);

const { db } = await import("../db.js");
const { resolveModel, saveConnection, listModels } = await import("./providers.js");

for (const id of ["admin", "alice"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', ?, 1)").run(
    id,
    `${id}@example.test`,
    id,
    id === "admin" ? "admin" : "user",
  );
}

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const servers: Server[] = [];
after(async () => {
  for (const server of servers) await close(server);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
before(() => {
  db.exec("DELETE FROM provider_connections; DELETE FROM shared_connections;");
});

test("resolving a selected model never contacts an unrelated stalled provider", async () => {
  let slowHits = 0;
  const slow = createServer((_req, res) => {
    slowHits += 1;
    // Long enough that the old whole-account enumeration would block on it; the fetch timeout is eight seconds.
    setTimeout(() => res.end(JSON.stringify({ data: [{ id: "slow-model" }] })), 8_000).unref();
  });
  servers.push(slow);
  const port = await listen(slow);
  saveConnection("admin", "openai", { apiKey: "sk-healthy", enabled: true });
  saveConnection("admin", "custom-slow", { baseURL: `http://127.0.0.1:${port}`, enabled: true });

  const started = performance.now();
  const { model, conn } = await resolveModel("admin", "openai/gpt-a");
  const elapsed = performance.now() - started;
  assert.equal(model.ref, "openai/gpt-a");
  assert.equal(conn.providerId, "openai");
  assert.equal(slowHits, 0, "the stalled/unknown connection must not be enumerated");
  assert.ok(elapsed < 1_000, `resolveModel took ${elapsed.toFixed(1)}ms`);
  db.exec("DELETE FROM provider_connections");
});

test("settings inventory still lists every permitted provider and reuses a live list", async () => {
  let hits = 0;
  const fast = createServer((req, res) => {
    if (req.url !== "/models") return res.writeHead(404).end();
    hits += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "fast-model" }, { id: "answer-model" }, { id: "text-embedding-3" }] }));
  });
  servers.push(fast);
  const port = await listen(fast);
  saveConnection("admin", "openai", { apiKey: "sk-healthy", enabled: true });
  saveConnection("admin", "custom-fast", { baseURL: `http://127.0.0.1:${port}`, enabled: true });

  // The selected provider resolves through its own connection only.
  const { model } = await resolveModel("admin", "custom-fast/fast-model");
  assert.equal(model.ref, "custom-fast/fast-model");
  assert.equal(hits, 1);

  // The settings inventory still enumerates every enabled connection, and the live list is reused.
  const ids = (await listModels("admin")).map((entry) => entry.ref).sort();
  assert.deepEqual(ids, ["custom-fast/answer-model", "custom-fast/fast-model", "openai/gpt-a", "openai/gpt-b"]);
  assert.equal(hits, 1);

  await assert.rejects(resolveModel("admin", "custom-fast/missing-model"), /Unknown model/);
  await assert.rejects(resolveModel("alice", "openai/gpt-a"), /not connected/);
  db.exec("DELETE FROM provider_connections");
});
