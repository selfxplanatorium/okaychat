import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-chatgpt-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "chatgpt-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("../db.js");
const { decrypt, encrypt } = await import("../crypto.js");
const { CHATGPT_BASE_URL, chatgptFetch, forgetChatgptModels } = await import("./chatgpt.js");
const { listModels, listProviders, saveConnection } = await import("./providers.js");

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("alice", "alice@example.test", "alice", "unused", "user", Date.now());

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  db.exec("DELETE FROM codex_auth; DELETE FROM provider_connections");
  forgetChatgptModels("alice");
});

const jwt = (expSeconds: number) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSeconds })).toString("base64url")}.s`;
const connect = (access: string) =>
  db.prepare("INSERT INTO codex_auth (user_id, auth_enc, updated_at) VALUES (?, ?, ?)").run(
    "alice",
    encrypt(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: access, refresh_token: "r1", id_token: "i1", account_id: "acct" } })),
    Date.now(),
  );
const storedTokens = () => JSON.parse(decrypt((db.prepare("SELECT auth_enc FROM codex_auth WHERE user_id = 'alice'").get() as { auth_enc: string }).auth_enc)).tokens;

type Call = { url: string; headers: Headers; body: Record<string, unknown> | undefined };
function mockFetch(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}
const sse = (...events: object[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

test("refreshes an expiring token, adapts the body, and rebuilds non-streaming responses from the stream", async () => {
  connect(jwt(60));
  const fresh = jwt(3600);
  const calls = mockFetch((call) =>
    call.url.includes("auth.openai.com")
      ? Response.json({ access_token: fresh, refresh_token: "r2", id_token: "i2" })
      : sse({ type: "response.created" }, { type: "response.completed", response: { id: "resp_1", output: [] } }),
  );
  const res = await chatgptFetch("alice")(`${CHATGPT_BASE_URL}/responses`, {
    method: "POST",
    body: JSON.stringify({
      model: "gpt-x",
      stream: false,
      store: true,
      temperature: 0.2,
      input: [{ type: "item_reference", id: "msg_1" }, { type: "reasoning", id: "rs_1", encrypted_content: "e" }, { role: "user", content: "hi" }],
    }),
  });
  assert.deepEqual(await res.json(), { id: "resp_1", output: [] });
  assert.equal(calls[0]!.body!.refresh_token, "r1");
  const sent = calls[1]!;
  assert.equal(sent.headers.get("authorization"), `Bearer ${fresh}`);
  assert.equal(sent.headers.get("chatgpt-account-id"), "acct");
  assert.equal(sent.body!.stream, true);
  assert.equal(sent.body!.store, false);
  assert.equal(sent.body!.instructions, "");
  assert.equal("temperature" in sent.body!, false);
  assert.deepEqual(sent.body!.input, [{ type: "reasoning", encrypted_content: "e" }, { role: "user", content: "hi" }]);
  assert.deepEqual(storedTokens(), { access_token: fresh, refresh_token: "r2", id_token: "i2", account_id: "acct" });
});

test("retries once with a refreshed token after a 401", async () => {
  connect(jwt(3600));
  let attempts = 0;
  const calls = mockFetch((call) => {
    if (call.url.includes("auth.openai.com")) return Response.json({ access_token: jwt(7200) });
    return ++attempts === 1 ? new Response("expired", { status: 401 }) : sse({ type: "response.completed", response: { id: "ok" } });
  });
  const res = await chatgptFetch("alice")(`${CHATGPT_BASE_URL}/responses`, { method: "POST", body: JSON.stringify({ stream: true, input: [] }) });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(storedTokens().refresh_token, "r1");
});

test("the provider appears only for a connected login, never as a shared connection, and can be switched off", async () => {
  mockFetch(() => Response.json({ models: [{ slug: "gpt-x", display_name: "GPT X", visibility: "list", context_window: 1000, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }] }, { slug: "hidden", visibility: "hide" }] }));
  assert.equal((await listProviders("alice")).some((p) => p.id === "chatgpt" && p.connected), false);
  connect(jwt(3600));
  assert.deepEqual((await listProviders("alice")).find((p) => p.id === "chatgpt")?.connected, true);
  const [model] = (await listModels("alice")).filter((m) => m.providerId === "chatgpt");
  assert.equal(model?.ref, "chatgpt/gpt-x");
  assert.deepEqual(model?.reasoningEfforts, ["low"]);
  assert.equal(model?.attachments, true);
  assert.throws(() => saveConnection(null, "chatgpt", { enabled: true }));
  saveConnection("alice", "chatgpt", { enabled: false, apiKey: "ignored" });
  assert.equal((await listModels("alice")).some((m) => m.providerId === "chatgpt"), false);
  assert.equal((db.prepare("SELECT api_key_enc FROM provider_connections WHERE provider_id = 'chatgpt'").get() as { api_key_enc: string | null }).api_key_enc, null);
  assert.equal((await listProviders(null)).some((p) => p.id === "chatgpt"), false);
});
