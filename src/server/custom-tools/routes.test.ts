import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-custom-routes-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "custom-routes-test-secret-not-for-production";
const { db } = await import("../db.js");
const { handleAppError } = await import("../errors.js");
const { customToolRoutes } = await import("./routes.js");
const type = await import("../auth.js");
void type;

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u', 'u@example.test', 'U', 'unused', 'user', ?)").run(Date.now());

const app = new Hono<{ Variables: { user: { id: string; email: string; name: string; role: "user" }; session: string } }>()
  .use("*", async (c, next) => {
    c.set("user", { id: "u", email: "u@example.test", name: "U", role: "user" });
    c.set("session", "session-hash");
    await next();
  })
  .route("/custom-tools", customToolRoutes)
  .onError(handleAppError);

const call = (method: string, path: string, json?: unknown) => app.request(`http://local/custom-tools${path === "/" ? "" : path}`, {
  method,
  ...(json !== undefined ? { body: JSON.stringify(json), headers: { "Content-Type": "application/json" } } : {}),
});

const write = {
  name: "Lookup",
  description: "HTTP lookup.",
  icon: "globe",
  enabled: false,
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  config: {
    kind: "http", origin: "https://api.example.com", path: "/items/{{id}}", method: "GET",
    query: [], headers: [{ name: "authorization", secret: "apiKey" }], body: null, response: "json", timeoutMs: 5000,
  },
};

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("management routes create, list, CAS-update and delete without echoing secrets", async () => {
  const created = await call("POST", "/", { tool: write, secrets: { set: { apiKey: "super-secret" }, remove: [] } });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { tool: { id: string; revision: number; secretNames: string[] } };
  assert.equal(createdBody.tool.revision, 1);
  assert.deepEqual(createdBody.tool.secretNames, ["apiKey"]);
  assert.ok(!JSON.stringify(createdBody).includes("super-secret"));

  const list = await call("GET", "/");
  assert.equal(list.status, 200);
  const listBody = await list.json() as { items: Array<{ id: string; lastRun: unknown }> };
  assert.equal(listBody.items.length, 1);
  assert.equal(listBody.items[0]!.lastRun, null);

  const stale = await call("PUT", `/${createdBody.tool.id}`, { expectedRevision: 99, tool: write });
  assert.equal(stale.status, 409);

  const updated = await call("PUT", `/${createdBody.tool.id}`, { expectedRevision: 1, tool: { ...write, name: "Lookup v2" } });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json() as { tool: { revision: number; name: string } };
  assert.equal(updatedBody.tool.revision, 2);
  assert.equal(updatedBody.tool.name, "Lookup v2");

  const enabled = await call("PATCH", `/${createdBody.tool.id}/enabled`, { expectedRevision: 2, enabled: true });
  assert.equal(enabled.status, 200);
  const enabledBody = await enabled.json() as { tool: { revision: number; enabled: boolean } };
  assert.equal(enabledBody.tool.revision, 3);
  assert.equal(enabledBody.tool.enabled, true);

  const cleanup = await call("GET", "/cleanup");
  assert.equal(cleanup.status, 200);
  assert.deepEqual((await cleanup.json() as { items: Array<{ id: string }> }).items.map((item) => item.id), [createdBody.tool.id]);

  const deleted = await call("DELETE", `/${createdBody.tool.id}`, { expectedRevision: 3 });
  assert.equal(deleted.status, 204);
  const missing = await call("GET", `/${createdBody.tool.id}`);
  assert.equal(missing.status, 404);
});

test("malformed bodies and unknown fields are refused", async () => {
  const duplicate = await app.request("http://local/custom-tools", {
    method: "POST",
    body: "{\"tool\":{},\"tool\":{}}",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(duplicate.status, 400);
  const unknown = await call("POST", "/", { tool: write, extra: true });
  assert.equal(unknown.status, 400);
  const missingRevision = await call("PATCH", "/nope/enabled", { enabled: true });
  assert.equal(missingRevision.status, 400);
});

test("cancelling a running workspace test stops the live request", async () => {
  const created = await call("POST", "/", { tool: { ...write, enabled: true }, secrets: { set: { apiKey: "secret-key" }, remove: [] } });
  assert.equal(created.status, 201);
  const { tool } = await created.json() as { tool: { id: string; revision: number } };
  const { setExecutionDeps } = await import("./execute.js");
  // Request ids are UUIDv7: the timestamp prefix must be recent, so a fixed id cannot pass.
  const uuidv7 = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const stamp = Date.now();
    for (let i = 0; i < 6; i++) bytes[i] = Math.floor(stamp / 2 ** (8 * (5 - i))) & 0xff;
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  let started = false;
  setExecutionDeps({
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      started = true;
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })) as typeof fetch,
  });
  try {
    const review = await call("POST", `/${tool.id}/test`, { expectedRevision: tool.revision, input: { id: "a" }, requestId: uuidv7() });
    assert.equal(review.status, 202);
    const body = await review.json() as { review: { runId: string; token: string } };
    const execution = call("POST", `/${tool.id}/test/execute`, { runId: body.review.runId, token: body.review.token });
    for (let i = 0; i < 200 && !started; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(started, true, "the request must be in flight before cancelling");
    const cancelled = await call("POST", `/${tool.id}/runs/${body.review.runId}/cancel`, {});
    assert.equal(cancelled.status, 200);
    const finished = await execution;
    const run = await finished.json() as { run: { state: string } };
    assert.equal(run.run.state, "cancelled");
  } finally {
    setExecutionDeps(null);
  }
});
