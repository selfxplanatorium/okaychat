import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { generateText, streamText } from "ai";

// Custom provider authentication end to end against loopback mocks: the save contract (validation,
// write-only secrets, origin re-entry, legacy defaults), the transport boundary through the real
// compatible SDK, discovery and manual models, embeddings and pins, redirects, guarded publicFetch,
// and failure redaction. Secrets are short arbitrary strings, compared in memory and never printed.

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-provider-auth-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "provider-auth-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));

const KEY = "k7Qz"; // deliberately short and unlike any known key format
const HEADER_SECRET = "hv9w";
const QUERY_VALUE = "2024-10-21";

interface Hit {
  method: string;
  path: string;
  search: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: string;
}
const hits: Hit[] = [];
const sinkHits: Hit[] = [];
let mode503 = 0;

async function record(req: IncomingMessage, into: Hit[]): Promise<Hit> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const url = new URL(req.url ?? "/", "http://mock");
  const hit = { method: req.method ?? "GET", path: url.pathname, search: url.search, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks).toString() };
  into.push(hit);
  return hit;
}

const completion = (stream: boolean) =>
  stream
    ? [
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}`,
        "data: [DONE]",
        "",
      ].join("\n\n")
    : JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });

let sinkPort = 0;
const mock: Server = createServer(async (req, res) => {
  const hit = await record(req, hits);
  if (hit.path.endsWith("/models")) {
    // The list depends on the header value, so cache isolation is observable.
    const tag = String(hit.headers["x-tenant"] ?? "none");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: `model-${tag}` }, { id: "text-embedding-3-small" }] }));
    return;
  }
  if (hit.path.startsWith("/redirect")) {
    const status = parseInt(hit.path.split("/")[2] ?? "302", 10);
    res.writeHead(status, hit.path.includes("nolocation") ? {} : { location: `http://127.0.0.1:${sinkPort}/sink?leak=${KEY}` }).end();
    return;
  }
  if (hit.path.startsWith("/echo")) {
    const echoed = `${KEY} ${HEADER_SECRET} ${QUERY_VALUE} ${hit.headers["x-extra"] ?? ""} ${hit.search}`;
    res.writeHead(hit.path.includes("500") ? 500 : 401, { "content-type": "application/json", "x-request-id": echoed, location: echoed, "retry-after": "0" })
      .end(JSON.stringify({ error: { message: `bad key ${echoed}`, code: `code_${KEY}`, request_id: echoed, param: echoed } }));
    return;
  }
  if (hit.path.endsWith("/embeddings")) {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ embedding: [1, 0, 0], index: 0 }] }));
    return;
  }
  if (hit.path.endsWith("/chat/completions")) {
    if (hit.path.includes("flaky") && mode503-- > 0) {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "busy" } }));
      return;
    }
    const stream = JSON.parse(hit.body || "{}").stream === true;
    res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" }).end(completion(stream));
    return;
  }
  res.writeHead(404).end();
});
const sink: Server = createServer(async (req, res) => {
  await record(req, sinkHits);
  res.writeHead(200).end("{}");
});

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const port = await listen(mock);
sinkPort = await listen(sink);
const origin = `http://127.0.0.1:${port}`;

const { db } = await import("../db.js");
const providers = await import("./providers.js");
const config = await import("./provider-config.js");
const transport = await import("../provider-transport.js");
const { createModel } = await import("../llm.js");
const { admitCreditRoot, closeCreditRoot } = await import("../credits/store.js");
const { createEmbedder } = await import("../knowledge/embeddings.js");
const { describeProviderError } = await import("../provider-errors.js");
const { toWireError } = await import("../errors.js");
const { upstream } = await import("../speech/engines.js");
const { saveConnection, prepareConnectionSave, commitConnectionSave, listProviders, resolveModel, getConnection, resolvePinnedConnection } = providers;
const { parseProviderInput } = config;

for (const [id, role] of [["admin", "admin"], ["alice", "user"], ["bob", "user"]] as const) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', ?, 1)").run(id, `${id}@example.test`, id, role);
}

const permits: Array<ReturnType<typeof admitCreditRoot>> = [];
const permit = (userId: string) => {
  const value = admitCreditRoot(userId, "chat");
  permits.push(value);
  return value;
};

before(() => undefined);
beforeEach(() => {
  hits.length = 0;
  sinkHits.length = 0;
  db.exec("DELETE FROM provider_connections; DELETE FROM shared_connections; DELETE FROM share_audiences;");
});
afterEach(() => {
  for (const value of permits.splice(0)) closeCreditRoot(value);
});
after(() => {
  for (const server of [mock, sink]) {
    server.closeAllConnections();
    server.close();
  }
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const apiKeyGateway = (extra: Record<string, unknown> = {}) => ({
  name: "Gateway",
  baseURL: `${origin}/gateway`,
  apiKey: KEY,
  enabled: true,
  transport: { auth: { mode: "api-key", headerName: "X-Api-Key" }, headers: [{ name: "X-Extra", value: HEADER_SECRET }], query: [{ name: "api-version", value: QUERY_VALUE }] },
  ...extra,
});

/** A route-equivalent save: one schema, then prepare + commit. */
const save = (scope: string | null, id: string, body: unknown) => saveConnection(scope, id, parseProviderInput(id, body));

function rejects(fn: () => unknown, field: string, reason: string) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof config.ConnectionInputError, `expected a field error, got ${(error as Error)?.name}`);
    assert.equal(error.field, field);
    assert.equal(error.reason, reason);
    return true;
  });
}

const rawRow = (userId: string, id: string) =>
  db.prepare("SELECT api_key_enc, base_url, config_json, enabled FROM provider_connections WHERE user_id = ? AND provider_id = ?").get(userId, id) as Record<string, unknown> | undefined;

const hitsFor = (suffix: string) => hits.filter((hit) => hit.path.endsWith(suffix));

// ---- persistence and projections ----

test("secrets are encrypted in both tables and lists expose names and presence only", async () => {
  save("admin", "custom-gw", apiKeyGateway());
  save(null, "custom-team", apiKeyGateway());
  for (const table of ["provider_connections", "shared_connections"]) {
    const rows = db.prepare(`SELECT api_key_enc, config_json FROM ${table}`).all() as Array<{ api_key_enc: string; config_json: string }>;
    assert.equal(rows.length, 1);
    const text = JSON.stringify(rows);
    for (const secret of [KEY, HEADER_SECRET, QUERY_VALUE]) assert.ok(!text.includes(secret), `${table} stores a plaintext value`);
    const stored = JSON.parse(rows[0]!.config_json);
    assert.equal(stored.customTransportVersion, 1);
    assert.deepEqual(stored.transport.headerNames, ["x-extra"]);
    assert.deepEqual(stored.transport.queryNames, ["api-version"]);
  }
  const own = (await listProviders("admin")).find((p) => p.id === "custom-gw")!;
  assert.deepEqual(own.transport, {
    auth: { mode: "api-key", headerName: "x-api-key" },
    hasApiKey: true,
    headers: [{ name: "x-extra", hasValue: true }],
    query: [{ name: "api-version", hasValue: true }],
  });
  const adminView = (await listProviders(null)).find((p) => p.id === "custom-team")!;
  assert.equal(adminView.transport?.hasApiKey, true);
  // An audience member sees the shared row without any advanced configuration.
  const member = (await listProviders("alice")).find((p) => p.id === "custom-team")!;
  assert.equal(member.transport, undefined);
  assert.equal(member.modelSource, undefined);
  const everything = JSON.stringify([await listProviders("admin"), await listProviders(null), await listProviders("alice")]);
  for (const secret of [KEY, HEADER_SECRET, QUERY_VALUE]) assert.ok(!everything.includes(secret));
});

test("enabled-only and old-client name saves keep the v1 configuration", () => {
  save("admin", "custom-gw", apiKeyGateway());
  const before = getConnection("admin", "custom-gw")!;
  save("admin", "custom-gw", { enabled: false });
  save("admin", "custom-gw", { name: "Renamed", enabled: true });
  const after = getConnection("admin", "custom-gw")!;
  assert.equal(after.name, "Renamed");
  assert.deepEqual(after.transport, before.transport);
  assert.equal(after.apiKey, KEY);
});

test("legacy rows decode with defaults on every read, keep wire behavior, and preserve unrelated config", async () => {
  db.prepare("INSERT INTO provider_connections (user_id, provider_id, api_key_enc, base_url, config_json, enabled, created_at) VALUES ('admin', 'custom-old', NULL, ?, ?, 1, 1)")
    .run(`${origin}/gateway`, JSON.stringify({ name: "Old", note: "kept" }));
  for (let i = 0; i < 2; i++) {
    const conn = getConnection("admin", "custom-old")!;
    assert.equal(conn.transport, undefined);
    const info = (await listProviders("admin")).find((p) => p.id === "custom-old")!;
    assert.deepEqual(info.transport, { auth: { mode: "bearer" }, hasApiKey: false, headers: [], query: [] });
    assert.deepEqual(info.modelSource, { mode: "discover" });
  }
  save("admin", "custom-old", { enabled: true });
  const kept = JSON.parse(String(rawRow("admin", "custom-old")!.config_json));
  assert.equal(kept.customTransportVersion, undefined);
  assert.equal(kept.note, "kept");
  // A legacy keyless row still sends the historical placeholder Bearer until it opts in.
  const { model, conn } = await resolveModel("admin", "custom-old/model-none");
  await generateText({ model: createModel(model, conn, { userId: "admin", creditPermit: permit("admin"), usageContext: { kind: "chat" } }).model, prompt: "hi", maxRetries: 0 });
  assert.equal(hitsFor("/chat/completions").at(-1)!.headers.authorization, "Bearer not-needed");
  // Opting in writes v1 and keeps the unrelated key.
  save("admin", "custom-old", { transport: { auth: { mode: "bearer" } } });
  const upgraded = JSON.parse(String(rawRow("admin", "custom-old")!.config_json));
  assert.equal(upgraded.customTransportVersion, 1);
  assert.equal(upgraded.note, "kept");
  // A second database handle sees the same persisted state (reopen check, twice).
  for (let i = 0; i < 2; i++) {
    const reopened = new DatabaseSync(path.join(dataDir, "okaychat.db"), { readOnly: true });
    const row = reopened.prepare("SELECT config_json FROM provider_connections WHERE user_id = 'admin' AND provider_id = 'custom-old'").get() as { config_json: string };
    reopened.close();
    assert.equal(config.decodeConfig("custom-old", row.config_json).transport?.ok, true);
  }
});

test("corrupt or unknown stored configuration fails closed, never falling back to Bearer", async () => {
  save("admin", "custom-gw", apiKeyGateway());
  const row = JSON.parse(String(rawRow("admin", "custom-gw")!.config_json));
  for (const broken of [{ ...row, customTransportVersion: 2 }, { ...row, transport: { ...row.transport, headerNames: ["x-other"] } }, { ...row, transport: { ...row.transport, valuesEnc: "v1.AAAA.BBBB.CCCC" } }]) {
    db.prepare("UPDATE provider_connections SET config_json = ? WHERE provider_id = 'custom-gw'").run(JSON.stringify(broken));
    const conn = getConnection("admin", "custom-gw")!;
    assert.equal(conn.transport?.ok, false);
    assert.deepEqual(await providers.listModelsForConnection(conn), []);
    await assert.rejects(transport.connectionFetch(conn)(`${origin}/gateway/chat/completions`, { method: "POST", body: "{}" }), /configuration is invalid/);
  }
  assert.equal(hits.length, 0);
});

test("non-custom providers reject the new fields, even for admins", () => {
  rejects(() => parseProviderInput("openai", { transport: { auth: { mode: "bearer" } } }), "transport", "unsupported_field");
  rejects(() => parseProviderInput("speech-azure", { modelSource: { mode: "discover" } }), "modelSource", "unsupported_field");
  rejects(() => parseProviderInput("custom-x", { transport: { auth: { mode: "bearer" }, extra: 1 } }), "transport", "unsupported_field");
});

// ---- validation ----

test("reserved, duplicate, colliding, and malformed header names are refused without writing", () => {
  save("admin", "custom-gw", apiKeyGateway());
  const before = rawRow("admin", "custom-gw");
  const withHeaders = (headers: unknown[], auth: unknown = { mode: "api-key", headerName: "x-api-key" }) => ({ transport: { auth, headers } });
  for (const name of ["Authorization", "HOST", "Cookie", "Content-Type", "User-Agent", "Transfer-Encoding", "Proxy-Foo", "Sec-Fetch-Mode", ":authority", "Accept-Encoding"]) {
    rejects(() => save("admin", "custom-gw", withHeaders([{ name, value: "v" }])), "transport.headers.0.name", "reserved_header");
  }
  rejects(() => save("admin", "custom-gw", withHeaders([{ name: "X-A", value: "1" }, { name: "x-a", value: "2" }])), "transport.headers.1.name", "duplicate");
  rejects(() => save("admin", "custom-gw", withHeaders([{ name: "x-api-key", value: "1" }])), "transport.headers.0.name", "auth_header_collision");
  rejects(() => save("admin", "custom-gw", withHeaders([{ name: "x a", value: "1" }])), "transport.headers.0.name", "invalid_name");
  rejects(() => save("admin", "custom-gw", withHeaders([{ name: " x-a", value: "1" }])), "transport.headers.0.name", "whitespace");
  rejects(() => save("admin", "custom-gw", withHeaders([{ name: "x".repeat(65), value: "1" }])), "transport.headers.0.name", "too_long");
  // Auth header: Authorization only as the chosen api-key header; never Cookie/Host/framing.
  rejects(() => save("admin", "custom-gw", { apiKey: KEY, transport: { auth: { mode: "api-key", headerName: "Cookie" } } }), "transport.auth.headerName", "reserved_header");
  rejects(() => save("admin", "custom-gw", { apiKey: KEY, transport: { auth: { mode: "api-key", headerName: "Content-Length" } } }), "transport.auth.headerName", "reserved_header");
  assert.deepEqual(rawRow("admin", "custom-gw"), before);
});

test("control characters, malformed Unicode, and every byte or count boundary are enforced", () => {
  save("admin", "custom-gw", apiKeyGateway());
  const before = rawRow("admin", "custom-gw");
  const header = (value: string) => ({ transport: { headers: [{ name: "x-extra", value }] } });
  for (const bad of ["a\r\nb", "a\nb", "a\u0000b", "a\u007fb", "a\u0085b", "a\u009bb"]) {
    rejects(() => save("admin", "custom-gw", header(bad)), "transport.headers.0.value", "control_character");
    rejects(() => save("admin", "custom-gw", { transport: { query: [{ name: "api-version", value: bad }] } }), "transport.query.0.value", "control_character");
    rejects(() => save("admin", "custom-gw", { apiKey: bad }), "apiKey", "control_character");
  }
  rejects(() => save("admin", "custom-gw", header("a\uD800b")), "transport.headers.0.value", "invalid_unicode");
  rejects(() => save("admin", "custom-gw", header(" padded")), "transport.headers.0.value", "whitespace");
  rejects(() => save("admin", "custom-gw", header("é")), "transport.headers.0.value", "invalid_value");
  rejects(() => save("admin", "custom-gw", header("")), "transport.headers.0.value", "required");
  rejects(() => save("admin", "custom-gw", header("v".repeat(4097))), "transport.headers.0.value", "too_long");
  rejects(() => save("admin", "custom-gw", { apiKey: "k".repeat(8193) }), "apiKey", "too_long");
  rejects(() => save("admin", "custom-gw", { transport: { query: [{ name: "q", value: "v".repeat(513) }] } }), "transport.query.0.value", "too_long");
  rejects(() => save("admin", "custom-gw", { transport: { query: [{ name: "bad name", value: "v" }] } }), "transport.query.0.name", "invalid_name");
  rejects(() => save("admin", "custom-gw", { transport: { query: [{ name: "q", value: "1" }, { name: "q", value: "2" }] } }), "transport.query.1.name", "duplicate");
  const rows = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => ({ name: `${prefix}${i}`, value: "v" }));
  rejects(() => save("admin", "custom-gw", { transport: { headers: rows(17, "x-h") } }), "transport.headers", "too_many");
  rejects(() => save("admin", "custom-gw", { transport: { query: rows(9, "q") } }), "transport.query", "too_many");
  // Exactly at the limits is accepted; 16 KiB total is then exceeded only by large values.
  save("admin", "custom-gw", { transport: { headers: rows(16, "x-h"), query: rows(8, "q") } });
  const big = Array.from({ length: 5 }, (_, i) => ({ name: `x-b${i}`, value: "v".repeat(4096) }));
  rejects(() => save("admin", "custom-gw", { transport: { headers: big } }), "transport.headers", "too_long");
  rejects(() => save("admin", "custom-gw", { transport: { query: Array.from({ length: 5 }, (_, i) => ({ name: `q${i}`, value: "v".repeat(500) })) } }), "transport.query", "too_long");
  // Base URL rules.
  for (const url of [`${origin}/g?x=1`, `${origin}/g#f`, `http://u:p@127.0.0.1:${port}/g`, `ftp://127.0.0.1/g`, `${origin}/g/chat/completions`, `${origin}\\g`, `${origin}/a%2fb`]) {
    rejects(() => save("admin", "custom-gw", { baseURL: url }), "baseURL", "invalid_url");
  }
  // Manual ids.
  rejects(() => save("admin", "custom-gw", { modelSource: { mode: "manual", ids: [] } }), "modelSource.ids", "required");
  rejects(() => save("admin", "custom-gw", { modelSource: { mode: "manual", ids: ["a/b"] } }), "modelSource.ids.0", "invalid_value");
  rejects(() => save("admin", "custom-gw", { modelSource: { mode: "manual", ids: Array.from({ length: 33 }, (_, i) => `m${i}`) } }), "modelSource.ids", "too_many");
  assert.notDeepEqual(rawRow("admin", "custom-gw"), before); // the at-limit save above is the only write
});

test("auth changes require key re-entry; headers mode clears and refuses a key", () => {
  save("admin", "custom-gw", apiKeyGateway());
  rejects(() => save("admin", "custom-gw", { transport: { auth: { mode: "bearer" } } }), "apiKey", "secret_reentry_required");
  rejects(() => save("admin", "custom-gw", { transport: { auth: { mode: "api-key", headerName: "x-other" } } }), "apiKey", "secret_reentry_required");
  rejects(() => save("admin", "custom-gw", { apiKey: KEY, transport: { auth: { mode: "headers" } } }), "apiKey", "key_not_allowed");
  rejects(() => save("admin", "custom-gw", { apiKey: "" }), "apiKey", "required");
  save("admin", "custom-gw", { transport: { auth: { mode: "headers" } } });
  assert.equal(rawRow("admin", "custom-gw")!.api_key_enc, null);
  rejects(() => save("admin", "custom-gw", { transport: { auth: { mode: "api-key", headerName: "x-api-key" } } }), "apiKey", "required");
  save("admin", "custom-gw", { apiKey: KEY, transport: { auth: { mode: "api-key", headerName: "Authorization" } } });
  assert.equal(getConnection("admin", "custom-gw")!.apiKey, KEY);
});

test("row patch semantics: keep by name, rename needs a value, empty array removes", () => {
  save("admin", "custom-gw", apiKeyGateway());
  save("admin", "custom-gw", { transport: { headers: [{ name: "X-EXTRA" }, { name: "x-new", value: "n1" }] } });
  let conn = getConnection("admin", "custom-gw")!;
  assert.ok(conn.transport?.ok);
  assert.deepEqual(conn.transport.config.headers, [{ name: "x-extra", value: HEADER_SECRET }, { name: "x-new", value: "n1" }]);
  rejects(() => save("admin", "custom-gw", { transport: { headers: [{ name: "x-renamed" }] } }), "transport.headers.0.value", "required");
  // A masked placeholder is just an ordinary value, never a retain signal.
  save("admin", "custom-gw", { transport: { headers: [{ name: "x-extra", value: "Saved value" }] } });
  conn = getConnection("admin", "custom-gw")!;
  assert.deepEqual(conn.transport?.ok && conn.transport.config.headers, [{ name: "x-extra", value: "Saved value" }]);
  save("admin", "custom-gw", { transport: { headers: [], query: [] } });
  conn = getConnection("admin", "custom-gw")!;
  assert.deepEqual(conn.transport?.ok && [conn.transport.config.headers, conn.transport.config.query], [[], []]);
});

test("an origin change requires every surviving secret again; a same-origin path change keeps them", () => {
  save("admin", "custom-gw", apiKeyGateway());
  // Canonical equivalence: default port and host case are the same origin.
  save("admin", "custom-gw", { baseURL: `http://127.0.0.1:${port}/gateway/` });
  save("admin", "custom-gw", { baseURL: `${origin}/other/path` });
  assert.equal(getConnection("admin", "custom-gw")!.apiKey, KEY);
  const moved = `http://localhost:${port}/gateway`;
  rejects(() => save("admin", "custom-gw", { baseURL: moved }), "apiKey", "secret_reentry_required");
  rejects(() => save("admin", "custom-gw", { baseURL: moved, apiKey: KEY }), "transport.headers", "secret_reentry_required");
  rejects(() => save("admin", "custom-gw", { baseURL: moved, apiKey: KEY, transport: { headers: [{ name: "x-extra" }] } }), "transport.headers.0.value", "secret_reentry_required");
  rejects(() => save("admin", "custom-gw", { baseURL: moved, apiKey: KEY, transport: { headers: [{ name: "x-extra", value: "h2" }] } }), "transport.query", "secret_reentry_required");
  save("admin", "custom-gw", { baseURL: moved, apiKey: KEY, transport: { headers: [], query: [{ name: "api-version", value: QUERY_VALUE }] } });
  const conn = getConnection("admin", "custom-gw")!;
  assert.equal(conn.baseURL, moved);
  // Same for http → https, and a port change.
  rejects(() => save("admin", "custom-gw", { baseURL: `https://localhost:${port}/gateway` }), "apiKey", "secret_reentry_required");
  rejects(() => save("admin", "custom-gw", { baseURL: `http://localhost:${port + 1}/gateway` }), "apiKey", "secret_reentry_required");
});

test("a fixed deployment URL needs exactly its manual id; the save refuses a racing row change", () => {
  const deployment = `${origin}/openai/deployments/team-chat`;
  rejects(() => save("admin", "custom-az", { baseURL: deployment, apiKey: KEY, transport: { auth: { mode: "api-key", headerName: "api-key" } } }), "modelSource", "deployment_mismatch");
  rejects(() => save("admin", "custom-az", { baseURL: deployment, apiKey: KEY, transport: { auth: { mode: "api-key", headerName: "api-key" } }, modelSource: { mode: "manual", ids: ["other"] } }), "modelSource", "deployment_mismatch");
  rejects(() => save("admin", "custom-az", { baseURL: `${origin}/openai/deployments/a/openai/deployments/b`, apiKey: KEY }), "baseURL", "invalid_url");
  const prepared = prepareConnectionSave("admin", "custom-az", parseProviderInput("custom-az", { baseURL: deployment, apiKey: KEY, transport: { auth: { mode: "api-key", headerName: "api-key" } }, modelSource: { mode: "manual", ids: ["team-chat"] } }));
  // Another write lands while the route awaits its DNS check.
  save("admin", "custom-az", { baseURL: deployment, apiKey: "other", transport: { auth: { mode: "api-key", headerName: "api-key" } }, modelSource: { mode: "manual", ids: ["team-chat"] } });
  rejects(() => commitConnectionSave(prepared), "body", "changed");
  assert.equal(getConnection("admin", "custom-az")!.apiKey, "other");
});

// ---- transport through the real SDK ----

const chatHandle = async (userId: string, ref: string, extra: Record<string, unknown> = {}) => {
  const { model, conn } = await resolveModel(userId, ref);
  return createModel(model, conn, { userId, creditPermit: permit(userId), usageContext: { kind: "chat" }, retry: { sleep: async () => {} }, ...extra });
};

test("api-key mode: discovery, streaming and non-streaming chat send the raw key, extra header, and query once", async () => {
  save("admin", "custom-gw", apiKeyGateway());
  const models = await providers.listModels("admin");
  assert.ok(models.some((m) => m.ref === "custom-gw/model-none"));
  const list = hitsFor("/gateway/models")[0]!;
  assert.equal(list.headers["x-api-key"], KEY);
  assert.equal(list.headers.authorization, undefined);
  const handle = await chatHandle("admin", "custom-gw/model-none");
  const result = streamText({ model: handle.model, prompt: "hi", maxRetries: 0 });
  assert.equal(await result.text, "Hello");
  await generateText({ model: handle.model, prompt: "hi", maxRetries: 0 });
  const chats = hitsFor("/chat/completions");
  assert.equal(chats.length, 2);
  for (const hit of chats) {
    assert.equal(hit.path, "/gateway/chat/completions");
    assert.equal(hit.search, `?api-version=${QUERY_VALUE}`);
    assert.deepEqual(hit.query.getAll("api-version"), [QUERY_VALUE]);
    assert.equal(hit.headers["x-api-key"], KEY);
    assert.equal(hit.headers["x-extra"], HEADER_SECRET);
    assert.equal(hit.headers.authorization, undefined);
    assert.equal(JSON.parse(hit.body).model, "model-none");
  }
  assert.equal(JSON.parse(chats[0]!.body).stream, true);
});

test("bearer, keyless bearer, headers-only, and raw Authorization auth", async () => {
  save("admin", "custom-b", { name: "B", baseURL: `${origin}/gateway`, apiKey: KEY, transport: { auth: { mode: "bearer" } }, modelSource: { mode: "manual", ids: ["m1"] } });
  save("admin", "custom-n", { name: "N", baseURL: `${origin}/gateway`, transport: { auth: { mode: "bearer" } }, modelSource: { mode: "manual", ids: ["m1"] } });
  save("admin", "custom-h", { name: "H", baseURL: `${origin}/gateway`, transport: { auth: { mode: "headers" }, headers: [{ name: "x-token", value: HEADER_SECRET }] }, modelSource: { mode: "manual", ids: ["m1"] } });
  save("admin", "custom-r", { name: "R", baseURL: `${origin}/gateway`, apiKey: `Token ${KEY}`, transport: { auth: { mode: "api-key", headerName: "Authorization" } }, modelSource: { mode: "manual", ids: ["m1"] } });
  const expected: Record<string, string | undefined> = { "custom-b": `Bearer ${KEY}`, "custom-n": undefined, "custom-h": undefined, "custom-r": `Token ${KEY}` };
  for (const id of Object.keys(expected)) {
    hits.length = 0;
    await generateText({ model: (await chatHandle("admin", `${id}/m1`)).model, prompt: "hi", maxRetries: 0 });
    const hit = hitsFor("/chat/completions")[0]!;
    assert.equal(hit.headers.authorization, expected[id], id);
    if (id === "custom-h") assert.equal(hit.headers["x-token"], HEADER_SECRET);
    // Manual mode makes zero /models probes.
    assert.equal(hitsFor("/models").length, 0);
  }
});

test("fixed deployment path: manual id, zero /models probes, missing id fails before upstream", async () => {
  save("admin", "custom-az", {
    name: "Azure team chat",
    baseURL: `${origin}/openai/deployments/team-chat`,
    apiKey: KEY,
    transport: { auth: { mode: "api-key", headerName: "api-key" }, query: [{ name: "api-version", value: QUERY_VALUE }] },
    modelSource: { mode: "manual", ids: ["team-chat"] },
  });
  await assert.rejects(resolveModel("admin", "custom-az/gpt-4o"), /Unknown model/);
  await generateText({ model: (await chatHandle("admin", "custom-az/team-chat")).model, prompt: "hi", maxRetries: 0 });
  const hit = hitsFor("/chat/completions")[0]!;
  assert.equal(hit.path, "/openai/deployments/team-chat/chat/completions");
  assert.equal(hit.search, `?api-version=${QUERY_VALUE}`);
  assert.equal(hit.headers["api-key"], KEY);
  assert.equal(JSON.parse(hit.body).model, "team-chat");
  assert.equal(hitsFor("/models").length, 0);
  assert.equal(hits.length, 1);
});

test("retries keep auth, headers, and query on every attempt; 401 is not retried or re-authenticated", async () => {
  save("admin", "custom-fl", { name: "F", baseURL: `${origin}/flaky`, apiKey: KEY, transport: { auth: { mode: "api-key", headerName: "x-api-key" }, headers: [{ name: "x-extra", value: HEADER_SECRET }], query: [{ name: "api-version", value: QUERY_VALUE }] }, modelSource: { mode: "manual", ids: ["m1"] } });
  mode503 = 1;
  await generateText({ model: (await chatHandle("admin", "custom-fl/m1")).model, prompt: "hi", maxRetries: 0 });
  const attempts = hitsFor("/chat/completions");
  assert.equal(attempts.length, 2);
  for (const hit of attempts) {
    assert.equal(hit.headers["x-api-key"], KEY);
    assert.equal(hit.headers["x-extra"], HEADER_SECRET);
    assert.equal(hit.search, `?api-version=${QUERY_VALUE}`);
    assert.equal(hit.headers.authorization, undefined);
  }
  hits.length = 0;
  save("admin", "custom-e", { name: "E", baseURL: `${origin}/echo`, apiKey: KEY, transport: { auth: { mode: "api-key", headerName: "x-api-key" } }, modelSource: { mode: "manual", ids: ["m1"] } });
  await assert.rejects(generateText({ model: (await chatHandle("admin", "custom-e/m1")).model, prompt: "hi", maxRetries: 0 }));
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.headers.authorization, undefined);
});

test("SDK auth and caller query conflicts are replaced or refused; Request/URL/string, multipart, and abort are preserved", async () => {
  save("admin", "custom-gw", apiKeyGateway({ modelSource: { mode: "manual", ids: ["m1"] } }));
  const conn = getConnection("admin", "custom-gw")!;
  const send = transport.connectionFetch(conn);
  await send(`${origin}/gateway/embeddings`, { method: "POST", headers: { Authorization: "Bearer sdk", "X-API-KEY": "sdk", "x-extra": "sdk" }, body: "{}" });
  let hit = hits.at(-1)!;
  assert.equal(hit.headers.authorization, undefined);
  assert.equal(hit.headers["x-api-key"], KEY);
  assert.equal(hit.headers["x-extra"], HEADER_SECRET);
  // The same value already present is kept once; a different value or a repeat is refused before network.
  await send(new URL(`${origin}/gateway/embeddings?api-version=${QUERY_VALUE}`), { method: "POST", body: "{}" });
  assert.deepEqual(hits.at(-1)!.query.getAll("api-version"), [QUERY_VALUE]);
  const count = hits.length;
  await assert.rejects(send(`${origin}/gateway/embeddings?api-version=other`, { method: "POST" }), /query parameter/);
  await assert.rejects(send(`${origin}/gateway/embeddings?api-version=${QUERY_VALUE}&api-version=${QUERY_VALUE}`, { method: "POST" }), /query parameter/);
  // Encoded CRLF in a query value stays data: it cannot add a header.
  await send(`${origin}/gateway/embeddings?note=${encodeURIComponent("a\r\nx-injected: 1")}`, { method: "POST", body: "{}" });
  assert.equal(hits.at(-1)!.headers["x-injected"], undefined);
  assert.equal(hits.length, count + 1);
  // Request input and multipart bodies keep their boundary.
  const form = new FormData();
  form.append("file", new Blob(["abc"]), "a.wav");
  await send(new Request(`${origin}/gateway/audio/transcriptions`, { method: "POST", body: form }));
  hit = hits.at(-1)!;
  assert.match(String(hit.headers["content-type"]), /^multipart\/form-data; boundary=/);
  assert.match(hit.body, /name="file"; filename="a.wav"/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(send(`${origin}/gateway/embeddings`, { method: "POST", body: "{}", signal: controller.signal }), (error: Error) => error.name === "AbortError");
});

test("requests outside the connection's origin or base path never receive its credentials", async () => {
  save("admin", "custom-gw", apiKeyGateway());
  const conn = getConnection("admin", "custom-gw")!;
  const send = transport.connectionFetch(conn);
  for (const url of [`http://127.0.0.1:${sinkPort}/gateway/x`, `${origin}/gatewayx/chat`, `${origin}/other`, `${origin}/gateway/%2e%2e/x`, `http://u:p@127.0.0.1:${port}/gateway/x`, `${origin}/gateway/x#frag`]) {
    await assert.rejects(send(url, { method: "POST" }), /does not target/);
  }
  // A forged ModelInfo pointing elsewhere is refused before any request.
  const { model } = await resolveModel("admin", "custom-gw/model-none");
  assert.throws(() => createModel({ ...model, baseURL: `http://127.0.0.1:${sinkPort}/gateway` }, conn, { userId: "admin", creditPermit: permit("admin"), usageContext: { kind: "chat" } }), /do not match/);
  assert.equal(sinkHits.length, 0);
});

test("redirects are never followed, never retried, and never expose Location", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    for (const suffix of ["", "-nolocation"]) {
      db.exec("DELETE FROM provider_connections");
      save("admin", "custom-rd", { name: "R", baseURL: `${origin}/redirect/${status}${suffix}`, apiKey: KEY, modelSource: { mode: "manual", ids: ["m1"] } });
      hits.length = 0;
      const error = await generateText({ model: (await chatHandle("admin", "custom-rd/m1")).model, prompt: "hi", maxRetries: 0 }).then(() => null, (e: unknown) => e);
      assert.ok(error);
      const wire = JSON.stringify(toWireError(describeProviderError(error, { log: false })));
      assert.ok(!wire.includes(KEY) && !wire.includes("/sink"));
      assert.equal(hits.length, 1, "a redirect is not retried");
    }
  }
  // A test-seam leaf answering a manual 3xx is refused too.
  save("admin", "custom-seam", { name: "S", baseURL: `${origin}/gateway`, apiKey: KEY, modelSource: { mode: "manual", ids: ["m1"] } });
  const seam = transport.connectionFetch(getConnection("admin", "custom-seam")!, async () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${sinkPort}/` } }));
  await assert.rejects(seam(`${origin}/gateway/chat/completions`, { method: "POST" }), (e: Error) => /redirect/.test(e.message) && (e as { retryable?: boolean }).retryable === false);
  assert.equal(sinkHits.length, 0);
});

test("a non-admin's own connection runs through real publicFetch: loopback and rebinding names are blocked at connection time", async () => {
  // Saved directly, as if the host resolved publicly when it was saved and rebinds to loopback now.
  for (const host of ["127.0.0.1", "localhost"]) {
    db.exec("DELETE FROM provider_connections");
    save("alice", "custom-own", { name: "Own", baseURL: `http://${host}:${port}/gateway`, apiKey: KEY, transport: { auth: { mode: "api-key", headerName: "x-api-key" } }, modelSource: { mode: "manual", ids: ["m1"] } });
    const conn = getConnection("alice", "custom-own")!;
    assert.equal(conn.guarded, true);
    hits.length = 0;
    const error = await generateText({ model: (await chatHandle("alice", "custom-own/m1")).model, prompt: "hi", maxRetries: 0 }).then(() => null, (e: unknown) => e);
    assert.ok(error);
    assert.equal(describeProviderError(error, { log: false }).code, "forbidden");
    assert.equal(hits.length, 0);
  }
  // The route's save-time check refuses a private destination for a non-admin, and allows the admin.
  assert.ok(await providers.privateUrlError("alice", `${origin}/gateway`));
  assert.equal(await providers.privateUrlError("admin", `${origin}/gateway`), null);
});

test("an admin's shared loopback connection stays usable for an entitled viewer", async () => {
  save(null, "custom-team", apiKeyGateway({ modelSource: { mode: "manual", ids: ["m1"] } }));
  const conn = getConnection("alice", "custom-team")!;
  assert.equal(conn.shared, true);
  assert.equal(conn.guarded, undefined);
  await generateText({ model: (await chatHandle("alice", "custom-team/m1")).model, prompt: "hi", maxRetries: 0 });
  assert.equal(hitsFor("/chat/completions")[0]!.headers["x-api-key"], KEY);
  // Disabled shared rows stay unavailable.
  save(null, "custom-team", { enabled: false });
  await assert.rejects(resolveModel("alice", "custom-team/m1"));
});

test("live list caches are isolated by header value and by scope", async () => {
  const tenant = (value: string) => ({ name: "T", baseURL: `${origin}/gateway`, transport: { auth: { mode: "headers" }, headers: [{ name: "x-tenant", value }] } });
  save("admin", "custom-t", tenant("one"));
  save("bob", "custom-t", tenant("two"));
  const admin = await providers.listModels("admin");
  const bob = await providers.listModels("bob");
  assert.ok(admin.some((m) => m.ref === "custom-t/model-one"));
  assert.ok(!bob.some((m) => m.ref === "custom-t/model-one"));
  // bob is guarded, so his list is fetched through publicFetch and refused on loopback; nothing leaks across.
  assert.ok(!bob.some((m) => m.ref.startsWith("custom-t/")));
  save("admin", "custom-t", { transport: { headers: [{ name: "x-tenant", value: "three" }] } });
  const changed = await providers.listModels("admin");
  assert.ok(changed.some((m) => m.ref === "custom-t/model-three"));
  assert.ok(!changed.some((m) => m.ref === "custom-t/model-one"));
});

test("failure bodies, headers, request ids, codes, and Location echoing secrets never reach errors or logs", async () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  try {
    for (const path of ["/echo", "/echo500"]) {
      db.exec("DELETE FROM provider_connections");
      save("admin", "custom-e", { name: "E", baseURL: `${origin}${path}`, apiKey: KEY, transport: { auth: { mode: "api-key", headerName: "x-api-key" }, headers: [{ name: "x-extra", value: HEADER_SECRET }], query: [{ name: "api-version", value: QUERY_VALUE }] }, modelSource: { mode: "manual", ids: ["m1"] } });
      const error = await generateText({ model: (await chatHandle("admin", "custom-e/m1", { retry: { sleep: async () => {}, policy: { maxAttempts: 1 } } })).model, prompt: "hi", maxRetries: 0 }).then(() => null, (e: unknown) => e);
      const app = describeProviderError(error, { provider: "custom-e", model: "custom-e/m1" });
      const exposed = [
        JSON.stringify(toWireError(app)),
        app.message,
        String(app.requestId ?? ""),
        String(app.providerCode ?? ""),
        String((error as { message?: string }).message ?? ""),
        String((error as { responseBody?: string }).responseBody ?? ""),
        JSON.stringify((error as { responseHeaders?: unknown }).responseHeaders ?? {}),
        logged.join("\n"),
      ].join("\n");
      for (const secret of [KEY, HEADER_SECRET, QUERY_VALUE, `code_${KEY}`]) assert.ok(!exposed.includes(secret), `${path} exposed a configured value`);
    }
    // Embedding ingestion status text is built from the same safe response.
    db.exec("DELETE FROM provider_connections");
    save("admin", "custom-ee", { name: "E", baseURL: `${origin}/echo`, apiKey: KEY, transport: { auth: { mode: "api-key", headerName: "x-api-key" }, query: [{ name: "api-version", value: QUERY_VALUE }] }, modelSource: { mode: "manual", ids: ["m1"] } });
    const embedder = createEmbedder("admin", { provider: "compatible", providerId: "custom-ee", model: "m1" }, { sleep: async () => {} })!;
    const failure = await embedder.embed(["text"]).then(() => null, (e: Error) => e);
    assert.ok(failure);
    for (const secret of [KEY, QUERY_VALUE]) assert.ok(!failure.message.includes(secret));
    // Speech upstream suppresses custom failure prose.
    const conn = getConnection("admin", "custom-ee")!;
    const speech = await upstream({ conn, apiKey: conn.apiKey, baseURL: conn.baseURL }, `${conn.baseURL}/audio/speech`, { method: "POST", body: "{}" }, "The server").then(() => null, (e: Error) => e);
    assert.ok(speech && !speech.message.includes(KEY) && !speech.message.includes(QUERY_VALUE));
  } finally {
    console.error = original;
  }
});

test("embeddings and image/speech boundaries apply the connection transport", async () => {
  save("admin", "custom-gw", apiKeyGateway({ modelSource: { mode: "manual", ids: ["m1"] } }));
  const embedder = createEmbedder("admin", { provider: "compatible", providerId: "custom-gw", model: "text-embedding-3-small" })!;
  const vectors = await embedder.embed(["hello"]);
  assert.equal(vectors.length, 1);
  const embed = hitsFor("/embeddings")[0]!;
  assert.equal(embed.path, "/gateway/embeddings");
  assert.equal(embed.search, `?api-version=${QUERY_VALUE}`);
  assert.equal(embed.headers["x-api-key"], KEY);
  assert.equal(embed.headers.authorization, undefined);
  assert.equal(JSON.parse(embed.body).model, "text-embedding-3-small");
  // Image route mapping through the factory a resolved connection would use.
  const conn = getConnection("admin", "custom-gw")!;
  await transport.connectionFetch(conn)(`${conn.baseURL}/images/generations`, { method: "POST", headers: { Authorization: "Bearer placeholder" }, body: "{}" });
  const image = hits.at(-1)!;
  assert.equal(image.headers.authorization, undefined);
  assert.equal(image.headers["x-api-key"], KEY);
  assert.equal(image.search, `?api-version=${QUERY_VALUE}`);
  // Speech HTTP upstream.
  await upstream({ conn, apiKey: conn.apiKey, baseURL: conn.baseURL }, `${conn.baseURL}/embeddings`, { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: "{}" }, "The server");
  const speech = hits.at(-1)!;
  assert.equal(speech.headers.authorization, undefined);
  assert.equal(speech.headers["x-api-key"], KEY);
  // Fixed deployment embeddings require the path deployment as model.
  save("admin", "custom-azemb", { name: "Emb", baseURL: `${origin}/openai/deployments/emb`, apiKey: KEY, transport: { auth: { mode: "api-key", headerName: "api-key" } }, modelSource: { mode: "manual", ids: ["emb"] } });
  assert.throws(() => createEmbedder("admin", { provider: "compatible", providerId: "custom-azemb", model: "text-embedding-3-small" }), /deployment name/);
  await createEmbedder("admin", { provider: "compatible", providerId: "custom-azemb", model: "emb" })!.embed(["x"]);
  assert.equal(hits.at(-1)!.path, "/openai/deployments/emb/embeddings");
});

test("knowledge pins: a query change alters the endpoint hash; key rotation alters only the fingerprint", () => {
  db.prepare("INSERT INTO provider_connections (user_id, provider_id, api_key_enc, base_url, config_json, enabled, created_at) VALUES ('admin', 'custom-k', NULL, ?, ?, 1, 1)")
    .run(`${origin}/gateway`, JSON.stringify({ name: "K" }));
  const legacy = resolvePinnedConnection("admin", "custom-k")!;
  // Opting into v1 with no query keeps the old endpoint hash, so existing collections need no reindex.
  save("admin", "custom-k", { transport: { auth: { mode: "bearer" } } });
  const v1 = resolvePinnedConnection("admin", "custom-k")!;
  assert.equal(v1.endpointHash, legacy.endpointHash);
  save("admin", "custom-k", { transport: { query: [{ name: "api-version", value: "2024-01-01" }] } });
  const versioned = resolvePinnedConnection("admin", "custom-k")!;
  assert.notEqual(versioned.endpointHash, v1.endpointHash);
  assert.ok(!versioned.endpointHash.includes("2024"));
  save("admin", "custom-k", { transport: { query: [{ name: "api-version", value: "2025-01-01" }] } });
  const changed = resolvePinnedConnection("admin", "custom-k")!;
  assert.notEqual(changed.endpointHash, versioned.endpointHash);
  save("admin", "custom-k", { apiKey: "rotated" });
  const rotated = resolvePinnedConnection("admin", "custom-k")!;
  assert.equal(rotated.endpointHash, changed.endpointHash);
  assert.notEqual(rotated.fingerprint, changed.fingerprint);
  // A pin resolves only the owner's row; no fallback to a shared row with the same id.
  save(null, "custom-k", apiKeyGateway());
  assert.equal(resolvePinnedConnection("admin", "custom-k")!.scope, "own");
});

test("connection settings never appear in ModelInfo", async () => {
  save("admin", "custom-gw", apiKeyGateway({ modelSource: { mode: "manual", ids: ["m1"] } }));
  const text = JSON.stringify(await providers.listModels("admin"));
  for (const secret of [KEY, HEADER_SECRET, QUERY_VALUE, "x-extra", "api-version"]) assert.ok(!text.includes(secret));
});
