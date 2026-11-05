import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INPUT_JSON_LIMITS,
  canonicalJson,
  parseToolJson,
  redactResult,
  resolveHttpRequest,
  resolvePath,
  validateInput,
  validateInputSchema,
  validateSecretPatch,
  validateSecretReferences,
  validateToolWrite,
  type HttpConfig,
  type InputSchema,
  newRequestId,
  validRequestId,
  type ToolWrite,
} from "./custom-tools.js";

const empty: InputSchema = { type: "object", properties: {}, required: [], additionalProperties: false };

const schema = (over: Partial<InputSchema> = {}): InputSchema => ({
  type: "object",
  properties: {
    values: { type: "array", items: { type: "number" }, maxItems: 10 },
    id: { type: "string", maxLength: 4, enum: ["a", "bb"] },
    limit: { type: "integer", minimum: 1, maximum: 5 },
    on: { type: "boolean" },
  },
  required: ["values", "id", "limit"],
  additionalProperties: false,
  ...over,
});

const baseTool = (over: Partial<ToolWrite> = {}): ToolWrite => ({
  name: "Sum",
  description: "Adds numbers.",
  icon: "calculator",
  enabled: false,
  inputSchema: schema(),
  config: { kind: "python", code: "def main(input):\n    return input\n", timeoutMs: 10_000 },
  ...over,
});

const httpConfig = (over: Partial<HttpConfig> = {}): HttpConfig => ({
  kind: "http",
  origin: "https://api.example.com",
  path: "/items/{{id}}",
  method: "GET",
  query: [{ name: "q", value: { input: "limit" } }],
  headers: [{ name: "accept", value: "application/json" }],
  body: null,
  response: "json",
  timeoutMs: 10_000,
  ...over,
});

test("schema subset accepts an empty root and rejects unsupported shapes", () => {
  assert.equal(validateInputSchema(empty).ok, true);
  assert.equal(validateInputSchema({ type: "object", properties: {}, required: [], additionalProperties: false, $ref: "#/x" }).ok, false);
  assert.equal(validateInputSchema({ type: "object", properties: {}, required: [], additionalProperties: true }).ok, false);
  assert.equal(validateInputSchema({ type: "object", properties: {}, required: ["missing"], additionalProperties: false }).ok, false);
  assert.equal(validateInputSchema({ type: "string" }).ok, false);
  assert.equal(validateInputSchema({ type: "array", items: { type: "string" }, maxItems: 101 }).ok, false);
  assert.equal(validateInputSchema({
    type: "object",
    properties: { a: { type: "string", enum: ["x", "x"] } },
    required: [],
    additionalProperties: false,
  }).ok, false);
  const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, { type: "string" }]));
  assert.equal(validateInputSchema({ type: "object", properties: tooMany, required: [], additionalProperties: false }).ok, false);
});

test("input validation reports fixed reasons and pointer paths", () => {
  const ok = validateInput(schema(), { values: [1, 2.5], id: "a", limit: 2 });
  assert.equal(ok.ok, true);
  const missing = validateInput(schema(), { values: [1], id: "a" } as never);
  assert.equal(missing.ok, false);
  assert.ok(!missing.ok && missing.issues.some((issue) => issue.reason === "required" && issue.path === "/limit"));
  const unknown = validateInput(schema(), { values: [1], id: "a", limit: 2, extra: true });
  assert.ok(!unknown.ok && unknown.issues.some((issue) => issue.reason === "unknown_property"));
  const enumValue = validateInput(schema(), { values: [1], id: "ccc", limit: 2 });
  assert.ok(!enumValue.ok && enumValue.issues[0]!.reason === "out_of_range");
  const longSchema = schema({ properties: { ...schema().properties, id: { type: "string", maxLength: 4 } } });
  const tooLong = validateInput(longSchema, { values: [1], id: "😀😀😀😀😀", limit: 2 });
  assert.ok(!tooLong.ok && tooLong.issues[0]!.reason === "too_large");
  const fraction = validateInput(schema(), { values: [1], id: "a", limit: 1.5 });
  assert.ok(!fraction.ok && fraction.issues[0]!.reason === "wrong_type");
  const bounds = validateInput(schema(), { values: [1], id: "a", limit: 9 });
  assert.ok(!bounds.ok && bounds.issues[0]!.reason === "out_of_range");
});

test("strict JSON parser rejects duplicate keys, reserved keys, depth and unsafe numbers", () => {
  const duplicate = parseToolJson('{"a":1,"a":2}', INPUT_JSON_LIMITS);
  assert.ok(!duplicate.ok && duplicate.issues[0]!.reason === "duplicate_key");
  const reserved = parseToolJson('{"__proto__":1}', INPUT_JSON_LIMITS);
  assert.ok(!reserved.ok && reserved.issues[0]!.reason === "reserved_key");
  const unsafe = parseToolJson('{"n":9007199254740993}', INPUT_JSON_LIMITS);
  assert.ok(!unsafe.ok && unsafe.issues[0]!.reason === "out_of_range");
  const deep = parseToolJson(`${"[".repeat(20)}0${"]".repeat(20)}`, INPUT_JSON_LIMITS);
  assert.ok(!deep.ok && deep.issues[0]!.reason === "too_deep");
  const ok = parseToolJson('{"n":1.5,"list":[true,null]}', INPUT_JSON_LIMITS);
  assert.ok(ok.ok);
  assert.equal(ok.ok && canonicalJson(ok.value), '{"list":[true,null],"n":1.5}');
});

test("an origin must be a canonical HTTPS origin", () => {
  for (const origin of ["http://api.example.com", "https://api.example.com:8443", "https://user:pass@api.example.com", "https://127.0.0.1", "https://api.example.com/path", "https://api.example.com/"]) {
    const result = validateToolWrite(baseTool({ config: httpConfig({ origin }) }));
    assert.equal(result.ok, false, origin);
  }
  assert.equal(validateToolWrite(baseTool({ config: httpConfig() })).ok, true);
});

test("path interpolation is segment-shaped and refuses traversal", () => {
  const s = schema();
  const good = resolvePath("/items/{{id}}", s, { values: [1], id: "a", limit: 2 });
  assert.deepEqual(good, { ok: true, value: "/items/a" });
  const encoded = resolvePath("/items/{{id}}", s, { values: [1], id: "a/b", limit: 2 });
  assert.equal(encoded.ok, false);
  for (const path of ["/a/../b", "//x", "/a?b", "/a#b", "/a\\b", "/%2e%2e/x", "/{{missing}}"]) {
    const result = validateToolWrite(baseTool({ config: httpConfig({ path }) }));
    assert.equal(result.ok, false, path);
  }
});

test("header rules force secrets for credential-like names", () => {
  const staticAuth = validateToolWrite(baseTool({ config: httpConfig({ headers: [{ name: "authorization", value: "Bearer x" }] }) }));
  assert.equal(staticAuth.ok, false);
  const secretAuth = validateToolWrite(baseTool({ config: httpConfig({ headers: [{ name: "authorization", secret: "apiKey" }] }) }));
  assert.equal(secretAuth.ok, true);
  const denied = validateToolWrite(baseTool({ config: httpConfig({ headers: [{ name: "host", value: "x" }] }) }));
  assert.equal(denied.ok, false);
  const badValue = validateToolWrite(baseTool({ config: httpConfig({ headers: [{ name: "x-note", value: "a\r\nb" }] }) }));
  assert.equal(badValue.ok, false);
});

test("secret patches are strict and references must match", () => {
  assert.equal(validateSecretPatch({ set: { apiKey: "secret-value" }, remove: [] }).ok, true);
  assert.equal(validateSecretPatch({ set: { apiKey: "" }, remove: [] }).ok, false);
  assert.equal(validateSecretPatch({ set: { apiKey: "a" }, remove: ["apiKey"] }).ok, false);
  assert.equal(validateSecretPatch({ set: { "bad name": "a" }, remove: [] }).ok, false);
  const headers = [{ name: "authorization", secret: "apiKey" } as const];
  assert.deepEqual(validateSecretReferences(headers, { apiKey: "value" }), []);
  assert.ok(validateSecretReferences(headers, {}).length > 0);
  assert.ok(validateSecretReferences([], { apiKey: "value" }).length > 0);
});

test("HTTP requests expand path, query and body without secret values", () => {
  const s: InputSchema = {
    type: "object",
    properties: {
      id: { type: "string" },
      limit: { type: "integer" },
      body: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false },
    },
    required: ["id", "limit", "body"],
    additionalProperties: false,
  };
  const config = httpConfig({
    method: "POST",
    body: {
      object: {
        id: { value: { input: "id" } },
        n: { value: { literal: 2 } },
        tags: { array: [{ value: { literal: "x" } }] },
      },
    },
    headers: [{ name: "accept", value: "application/json" }, { name: "x-api-key", secret: "key" }],
  });
  const request = resolveHttpRequest(config, s, { id: "a b", limit: 3, body: { note: "hi" } });
  assert.ok(request.ok);
  if (!request.ok) return;
  assert.equal(request.value.url, "https://api.example.com/items/a%20b?q=3");
  assert.equal(request.value.body, '{"id":"a b","n":2,"tags":["x"]}');
  assert.ok(request.value.headers.some((header) => "secret" in header && header.secret === "key"));
  assert.equal(request.value.warning, "outbound_destructive");
});

test("workspace request ids are UUIDv7 with a 24-hour freshness window", () => {
  const now = Date.UTC(2026, 10, 5, 12, 0, 0);
  const id = newRequestId((bytes) => Uint8Array.from({ length: bytes }, (_, index) => index + 1), now);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(validRequestId(id, now), true);
  assert.equal(validRequestId(id, now + 24 * 60 * 60_000 + 1), false);
  assert.equal(validRequestId("00000000-0000-4000-8000-000000000000", now), false);
});

test("redaction removes secret values and rejects a secret as a key", () => {
  const secret = "super-secret-value";
  const result = redactResult({ token: secret, text: `Authorization: Bearer ${secret}`, nested: [{ note: secret }] }, [secret]);
  assert.ok(result.ok);
  assert.ok(!JSON.stringify(result.value).includes(secret));
  const collision = redactResult({ [secret]: 1 }, [secret]);
  assert.equal(collision.ok, false);
});
