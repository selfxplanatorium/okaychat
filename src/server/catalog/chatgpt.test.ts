import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { ModelInfo } from "../../shared/types.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-chatgpt-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "chatgpt-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));

const { db } = await import("../db.js");
const { TOKEN_URL, oauthDeps } = await import("../chatgpt-oauth.js");
const { activeRegistration, credentials, seal } = await import("../chatgpt-oauth-store.js");
const {
  CHATGPT_BASE_URL,
  CHATGPT_MODELS_URL,
  CHATGPT_NAME,
  CHATGPT_RESPONSES_URL,
  chatgptFetch,
  chatgptModels,
  forgetChatgptModels,
} = await import("./chatgpt.js");
const { listModels, listProviders, saveConnection } = await import("./providers.js");
const { AppError } = await import("../errors.js");
const { admitCreditRoot, closeCreditRoot } = await import("../credits/store.js");

const REGISTRATION = "cgr_test";
const ACCESS = "access-token-1";
const realFetch = globalThis.fetch;
const realOAuthFetch = oauthDeps.fetch;

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
  "alice",
  "alice@example.test",
  "alice",
  "unused",
  "user",
  Date.now(),
);

after(() => {
  globalThis.fetch = realFetch;
  oauthDeps.fetch = realOAuthFetch;
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// The model boundary requires a live server-owned permit. The account is unlimited, so the fixture
// admits one normal root and releases it after the test.
const permits: Array<ReturnType<typeof admitCreditRoot>> = [];
const creditPermit = () => {
  const permit = admitCreditRoot("alice", "chat");
  permits.push(permit);
  return permit;
};
afterEach(() => {
  for (const permit of permits.splice(0)) closeCreditRoot(permit);
});

beforeEach(() => {
  db.exec(
    "DELETE FROM chatgpt_login_attempts; DELETE FROM chatgpt_registrations; DELETE FROM chatgpt_controls; DELETE FROM chatgpt_hosts; DELETE FROM provider_connections; DELETE FROM codex_auth;",
  );
  forgetChatgptModels("alice");
  globalThis.fetch = realFetch;
  oauthDeps.fetch = realOAuthFetch;
});

function tokens(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    accessToken: ACCESS,
    refreshToken: "refresh-token-1",
    idToken: "signed.id.token",
    tokenType: "Bearer",
    scopes: ["openid", "resource.invoke", "chatgpt.tokens.use.direct"],
    receivedAt: now,
    expiresIn: 3_600,
    accessExpiresAt: now + 3_600_000,
    ...overrides,
  };
}

function connect(overrides: { generation?: number; accessExpiresAt?: number } = {}) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chatgpt_registrations
      (id, user_id, client_id, identity_enc, credentials_enc, state, active, generation, token_version, refresh_state, access_expires_at, connected_at, updated_at, last_error_code, welcome_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    REGISTRATION,
    "alice",
    "issued-client",
    seal("alice", REGISTRATION, { issuer: "https://auth.openai.com", subject: "subject-1" }),
    seal("alice", REGISTRATION, tokens(overrides.accessExpiresAt !== undefined ? { accessExpiresAt: overrides.accessExpiresAt } : {})),
    "ready",
    1,
    overrides.generation ?? 1,
    0,
    "idle",
    overrides.accessExpiresAt ?? now + 3_600_000,
    now,
    now,
    null,
    null,
  );
}

type Call = { url: string; method: string; headers: Headers; body: Record<string, unknown> | undefined };

function mockFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const call: Call = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers),
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

const sse = (...events: object[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "x-request-id": "req_test" },
  });

const completed = (response: Record<string, unknown>) => sse({ type: "response.completed", response });

test("sends the pinned official Responses request with developer roles, namespaced tools and stripped fields", async () => {
  connect();
  const calls = mockFetch(() => completed({ id: "resp_1", status: "completed", output: [], usage: { input_tokens: 4, output_tokens: 1 } }));
  const res = await chatgptFetch("alice")(CHATGPT_RESPONSES_URL, {
    method: "POST",
    body: JSON.stringify({
      model: "gpt-5.1",
      stream: true,
      store: true,
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 50,
      metadata: { trace: "no" },
      background: true,
      prompt_cache_key: "cache-me",
      prompt_cache_retention: "24h",
      instructions: "Policy text",
      input: [
        { type: "item_reference", id: "msg_ref" },
        { type: "message", id: "msg_1", role: "system", content: "System text" },
        { type: "reasoning", id: "rs_1", encrypted_content: "encrypted", summary: [] },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "web_search", arguments: "{}" },
        { type: "function_call_output", id: "out_1", call_id: "call_1", output: "{\"ok\":true}" },
      ],
      tools: [
        {
          type: "function",
          name: "web_search",
          description: "Search the web.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
          strict: true,
        },
      ],
      tool_choice: { type: "function", name: "web_search" },
    }),
  });

  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.match(await res.text(), /response\.completed/);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, "https://api.openai.com/v1/responses");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.get("authorization"), `Bearer ${ACCESS}`);
  assert.equal(call.headers.get("accept"), "text/event-stream");
  assert.match(call.headers.get("user-agent") ?? "", /^okaychat\//);
  for (const name of ["originator", "chatgpt-account-id", "openai-organization", "x-api-key", "cookie"]) {
    assert.equal(call.headers.get(name), null, name);
  }
  const body = call.body!;
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal("temperature" in body, false);
  assert.equal("top_p" in body, false);
  assert.equal("max_output_tokens" in body, false);
  assert.equal("metadata" in body, false);
  assert.equal("background" in body, false);
  assert.equal("prompt_cache_key" in body, false);
  assert.equal("prompt_cache_retention" in body, false);
  assert.equal("instructions" in body, false);
  assert.deepEqual(body.input, [
    { role: "developer", content: [{ type: "input_text", text: "Policy text" }] },
    { type: "message", role: "developer", content: "System text" },
    { type: "reasoning", encrypted_content: "encrypted", summary: [] },
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", call_id: "call_1", name: "web_search", arguments: "{}", namespace: "okaychat" },
    { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true}" },
  ]);
  assert.deepEqual(body.tools, [
    {
      type: "namespace",
      name: "okaychat",
      description: "Available application tools.",
      tools: [
        {
          type: "function",
          name: "web_search",
          description: "Search the web.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
          strict: true,
        },
      ],
    },
  ]);
  assert.deepEqual(body.tool_choice, { type: "function", name: "okaychat.web_search" });
});

test("rejects foreign destinations and wrong methods before requesting a credential", async () => {
  connect();
  const calls = mockFetch(() => completed({ id: "unexpected" }));
  await assert.rejects(chatgptFetch("alice")("https://attacker.example/v1/responses", { method: "POST", body: "{}" }), (error) => error instanceof AppError && error.code === "forbidden");
  await assert.rejects(chatgptFetch("alice")(`${CHATGPT_BASE_URL}/models`, { method: "POST" }), (error) => error instanceof AppError && error.code === "validation");
  await assert.rejects(chatgptFetch("alice")(`${CHATGPT_BASE_URL}/responses?query=1`, { method: "POST", body: "{}" }), (error) => error instanceof AppError && error.code === "forbidden");
  assert.equal(calls.length, 0);
});

test("maps the visible catalog conservatively and caches per registration generation", async () => {
  connect();
  const calls = mockFetch(() =>
    Response.json({
      models: [
        {
          slug: "gpt-5.1",
          display_name: "GPT 5.1",
          visibility: "list",
          context_window: 400_000,
          input_modalities: ["text", "image"],
          supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
        },
        { slug: "mystery-model", visibility: "list" },
        { slug: "hidden-model", visibility: "hide" },
        { slug: "disabled-model", visibility: "list", supported_in_api: false },
        { display_name: "no slug", visibility: "list" },
      ],
    }),
  );

  const first = await chatgptModels("alice");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, CHATGPT_MODELS_URL);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.headers.get("accept"), "application/json");
  assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${ACCESS}`);
  assert.deepEqual(first.map((model: ModelInfo) => model.ref), ["chatgpt/gpt-5.1", "chatgpt/mystery-model"]);

  const known = first[0]!;
  assert.equal(known.name, "GPT 5.1");
  assert.equal(known.context, 400_000);
  assert.equal(known.maxOutput, 4_096);
  assert.equal(known.toolCall, true);
  assert.equal(known.reasoning, true);
  assert.deepEqual(known.reasoningEfforts, ["low"]);
  assert.equal(known.attachments, true);
  assert.equal(known.temperature, false);
  assert.equal(known.free, false);

  const unknown = first[1]!;
  assert.equal(unknown.context, 32_768);
  assert.equal(unknown.maxOutput, 4_096);
  assert.equal(unknown.toolCall, false);
  assert.equal(unknown.reasoning, false);
  assert.equal("reasoningEfforts" in unknown, false);
  assert.equal(unknown.attachments, false);
  assert.deepEqual(unknown.inputModalities, ["text"]);

  await chatgptModels("alice");
  assert.equal(calls.length, 1, "the same registration reuses its list");

  db.prepare("UPDATE chatgpt_registrations SET generation = generation + 1 WHERE id = ?").run(REGISTRATION);
  await chatgptModels("alice");
  assert.equal(calls.length, 2, "a new generation cannot reuse the old catalog");

  forgetChatgptModels("alice");
  await chatgptModels("alice");
  assert.equal(calls.length, 3);
});

test("the provider is personal-only, connected only through a registration, and keeps the enabled switch", async () => {
  mockFetch(() => Response.json({ models: [{ slug: "gpt-5.1", visibility: "list" }] }));
  assert.equal((await listProviders("alice")).some((provider) => provider.id === "chatgpt" && provider.connected), false);

  connect();
  const provider = (await listProviders("alice")).find((entry) => entry.id === "chatgpt");
  assert.equal(provider?.connected, true);
  assert.equal(provider?.name, CHATGPT_NAME);
  assert.equal(provider?.shared, false);
  assert.deepEqual((await listModels("alice")).filter((model) => model.providerId === "chatgpt").map((model) => model.ref), ["chatgpt/gpt-5.1"]);

  assert.throws(() => saveConnection(null, "chatgpt", { enabled: true }));
  saveConnection("alice", "chatgpt", { enabled: false, apiKey: "ignored" });
  assert.equal((await listModels("alice")).some((model) => model.providerId === "chatgpt"), false);
  assert.equal((db.prepare("SELECT api_key_enc FROM provider_connections WHERE provider_id = 'chatgpt'").get() as { api_key_enc: string | null }).api_key_enc, null);
  assert.equal((await listProviders(null)).some((entry) => entry.id === "chatgpt"), false);
});

test("non-streaming utility calls rebuild only response.completed", async () => {
  connect();
  const calls = mockFetch(() =>
    sse(
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "ignored" },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 2 } } },
    ),
  );
  const res = await chatgptFetch("alice")(CHATGPT_RESPONSES_URL, {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5.1", stream: false, input: [{ role: "user", content: "title" }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-request-id"), "req_test");
  assert.deepEqual(await res.json(), { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 2 } });
  assert.equal(calls[0]!.body!.stream, true, "the upstream request is always streamed");

  mockFetch(() => sse({ type: "response.failed", response: { status: 429, error: { code: "subscription_sharing_usage_limit_exceeded" } } }));
  const failed = await chatgptFetch("alice")(CHATGPT_RESPONSES_URL, { method: "POST", body: JSON.stringify({ model: "gpt-5.1", stream: false, input: [] }) });
  assert.equal(failed.status, 402);
});

test("403 does not refresh or replay", async () => {
  connect();
  let oauthCalls = 0;
  oauthDeps.fetch = async () => {
    oauthCalls++;
    return Response.json({});
  };
  const calls = mockFetch(() => Response.json({ error: { code: "subscription_sharing_user_not_eligible" } }, { status: 403 }));
  const res = await chatgptFetch("alice")(CHATGPT_RESPONSES_URL, { method: "POST", body: JSON.stringify({ model: "gpt-5.1", stream: true, input: [] }) });
  assert.equal(res.status, 403);
  assert.equal(calls.length, 1);
  assert.equal(oauthCalls, 0);
});

test("the model factory collects a non-streaming generate call from the upstream stream", async () => {
  connect();
  const calls = mockFetch(() =>
    completed({
      id: "resp_factory",
      object: "response",
      created_at: 1,
      model: "gpt-5.1",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hello", annotations: [] }],
        },
      ],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    }),
  );
  const { createModel } = await import("../llm.js");
  const info: ModelInfo = {
    ref: "chatgpt/gpt-5.1",
    providerId: "chatgpt",
    id: "gpt-5.1",
    name: "GPT 5.1",
    format: "openai-responses",
    baseURL: CHATGPT_BASE_URL,
    context: 32_768,
    maxOutput: 4_096,
    reasoning: false,
    toolCall: true,
    attachments: false,
    inputModalities: ["text"],
    temperature: false,
    free: false,
  };
  const handle = createModel(info, { providerId: "chatgpt", apiKey: "chatgpt-login", enabled: true }, { userId: "alice", creditPermit: creditPermit(), usageContext: { kind: "chat" } });
  if (typeof handle.model === "string" || handle.model.specificationVersion !== "v4") throw new Error("Expected a v4 model");
  const result = await handle.model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [{ type: "function", name: "web_search", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body!.stream, true, "the utility request is collected from a forced stream");
  assert.equal((calls[0]!.body!.tools as Array<{ name: string }>)[0]!.name, "okaychat");
  assert.equal(result.content.some((part) => part.type === "text" && part.text === "Hello"), true);
});

test("a pre-stream 401 replays once with the rotated token and preserves the old refresh token on success", async () => {
  connect();
  const oauthCalls: Array<{ url: string; body: string }> = [];
  oauthDeps.fetch = async (url, init) => {
    oauthCalls.push({ url, body: typeof init.body === "string" ? init.body : "" });
    return Response.json({
      access_token: "access-token-2",
      refresh_token: "refresh-token-2",
      token_type: "Bearer",
      expires_in: 3_600,
      scope: "openid resource.invoke chatgpt.tokens.use.direct",
    });
  };
  let attempts = 0;
  const calls = mockFetch(() => {
    attempts++;
    return attempts === 1 ? Response.json({ error: { code: "subscription_sharing_invalid_user" } }, { status: 401 }) : completed({ id: "resp_ok" });
  });

  const res = await chatgptFetch("alice")(CHATGPT_RESPONSES_URL, { method: "POST", body: JSON.stringify({ model: "gpt-5.1", stream: true, input: [] }) });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${ACCESS}`);
  assert.equal(calls[1]!.headers.get("authorization"), "Bearer access-token-2");
  assert.equal(oauthCalls.length, 1);
  assert.equal(oauthCalls[0]!.url, TOKEN_URL);
  const form = new URLSearchParams(oauthCalls[0]!.body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "refresh-token-1");
  assert.equal(form.get("client_id"), "issued-client");
  assert.equal(form.get("resource"), "https://api.openai.com/v1");

  const row = activeRegistration("alice");
  assert.equal(row?.token_version, 1);
  assert.equal(credentials(row!).accessToken, "access-token-2");
  assert.equal(credentials(row!).refreshToken, "refresh-token-2");
});
