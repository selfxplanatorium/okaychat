import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { ModelInfo } from "../shared/types.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-entitlements-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "entitlements-test-secret-only-not-for-production";
// A tiny catalog keeps model lists deterministic and offline. Custom endpoints are covered by the
// provider tests; these tests care about audience policies and their SQL.
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
          ["gpt-a", "gpt-b", "gpt-c"].map((id) => [
            id,
            {
              id,
              name: id.toUpperCase(),
              tool_call: true,
              modalities: { input: ["text"], output: ["text"] },
              limit: { context: 100_000, output: 8_000 },
            },
          ]),
        ),
      },
    },
    fetchedAt: Date.now(),
  }),
);
const { db } = await import("./db.js");
const { sha256 } = await import("./crypto.js");
const { admitCreditRoot, closeCreditRoot } = await import("./credits/store.js");
const {
  getModelAccessPolicy,
  listModelAccessPolicies,
  providerAudienceTargets,
  setModelAccessPolicies,
  sharedModelAccess,
} = await import("./entitlements.js");
const { createGroup, deleteGroup, getAudience, setAudience, updateGroup } = await import("./groups.js");
const {
  deleteConnection,
  getConnection,
  getSharedConnection,
  listModels,
  listProviders,
  resolveModel,
  saveConnection,
} = await import("./catalog/providers.js");
const { createModel } = await import("./llm.js");
const { describeProviderError } = await import("./provider-errors.js");
const { adminRoutes } = await import("./admin.js");
const { requireUser } = await import("./auth.js");

const app = new Hono().use(requireUser).route("/", adminRoutes);

const TOKENS = { admin: "admin-session", alice: "alice-session", bob: "bob-session", carol: "carol-session" };
for (const [id, role] of [["admin", "admin"], ["alice", "user"], ["bob", "user"], ["carol", "user"]]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    `${id}@example.test`,
    id,
    "unused",
    role,
    Date.now(),
  );
}
const signIn = (userId: keyof typeof TOKENS) =>
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(TOKENS[userId]), userId, Date.now() + 60_000);

// createModel() requires a live server-owned permit. These accounts stay unlimited, so one normal
// root per user is enough for every fixture call in a test; it is released after the test.
const permits = new Map<string, ReturnType<typeof admitCreditRoot>>();
const creditPermit = (userId: string) => {
  let permit = permits.get(userId);
  if (!permit) {
    permit = admitCreditRoot(userId, "chat");
    permits.set(userId, permit);
  }
  return permit;
};
const usage = { kind: "chat" as const };
afterEach(() => {
  for (const permit of permits.values()) closeCreditRoot(permit);
  permits.clear();
});

beforeEach(() => {
  db.exec(
    `DELETE FROM provider_model_policies;
     DELETE FROM shared_connections;
     DELETE FROM provider_connections;
     DELETE FROM share_audiences;
     DELETE FROM user_groups;
     DELETE FROM sessions;`,
  );
  for (const userId of Object.keys(TOKENS)) signIn(userId as keyof typeof TOKENS);
});
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const shared = () => saveConnection(null, "openai", { apiKey: "sk-shared", enabled: true });
const model = (id: string, providerId = "openai"): ModelInfo => ({
  ref: `${providerId}/${id}`,
  providerId,
  id,
  name: id,
  format: "openai-responses",
  context: 100_000,
  maxOutput: 8_000,
  reasoning: false,
  toolCall: true,
  attachments: false,
  inputModalities: ["text"],
  temperature: true,
  free: false,
});
const ids = (userId: string) => [...sharedModelAccess(userId, "openai").ids].sort();
const request = (method: string, url: string, token?: string, body?: unknown) =>
  app.request(`http://app${url}`, {
    method,
    headers: { ...(token ? { cookie: `okaychat_session=${token}` } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("audience policies union across groups and a direct user; one all target grants every model", () => {
  shared();
  const first = createGroup("First", ["alice", "bob"]);
  const second = createGroup("Second", ["bob"]);
  setAudience("provider", "openai", { mode: "selected", userIds: ["carol"], groupIds: [first.id, second.id] });
  setModelAccessPolicies("openai", [
    { target: { kind: "group", id: first.id }, mode: "selected", modelIds: ["gpt-a"] },
    { target: { kind: "group", id: second.id }, mode: "selected", modelIds: ["gpt-b"] },
    { target: { kind: "user", id: "carol" }, mode: "selected", modelIds: ["gpt-c"] },
  ]);

  assert.deepEqual(ids("alice"), ["gpt-a"]);
  assert.deepEqual(ids("bob"), ["gpt-a", "gpt-b"]);
  assert.deepEqual(ids("carol"), ["gpt-c"]);
  assert.equal(sharedModelAccess("admin", "openai").visible, false, "admins are not exempt from audiences");

  updateGroup(first.id, { userIds: ["alice", "carol"] });
  assert.deepEqual(ids("carol"), ["gpt-a", "gpt-c"], "group membership is evaluated live");

  setModelAccessPolicies("openai", [{ target: { kind: "group", id: second.id }, mode: "all", modelIds: [] }]);
  assert.equal(sharedModelAccess("bob", "openai").all, true);
  assert.deepEqual(ids("alice"), ["gpt-a"], "editing one group does not widen another");

  setAudience("provider", "openai", { mode: "all", userIds: [], groupIds: [] });
  assert.deepEqual(providerAudienceTargets("openai"), [{ kind: "everyone", id: "" }]);
  assert.equal(sharedModelAccess("bob", "openai").all, true, "everyone defaults to all");
});

test("a group restriction filters model lists and hides an empty policy; a new target defaults to all", async () => {
  shared();
  const team = createGroup("Team", ["alice"]);
  setAudience("provider", "openai", { mode: "selected", userIds: ["carol"], groupIds: [team.id] });
  setModelAccessPolicies("openai", [{ target: { kind: "group", id: team.id }, mode: "selected", modelIds: ["gpt-a"] }]);

  assert.deepEqual((await listModels("alice")).filter((m) => m.providerId === "openai").map((m) => m.id), ["gpt-a"]);
  assert.equal((await listProviders("alice")).find((p) => p.id === "openai")?.modelCount, 1);
  assert.equal((await listModels("carol")).filter((m) => m.providerId === "openai").length, 3, "a target without a policy uses every model");
  assert.equal((await listModels("bob")).some((m) => m.providerId === "openai"), false);
  assert.equal((await listProviders("bob")).some((p) => p.id === "openai" && p.connected), false);
  assert.equal((await listModels("admin")).some((m) => m.providerId === "openai"), false, "the admin has no bypass");

  setModelAccessPolicies("openai", [{ target: { kind: "group", id: team.id }, mode: "selected", modelIds: [] }]);
  assert.equal(sharedModelAccess("alice", "openai").visible, true);
  assert.equal(sharedModelAccess("alice", "openai").ids.size, 0);
  assert.equal((await listModels("alice")).some((m) => m.providerId === "openai"), false);
  assert.equal((await listProviders("alice")).some((p) => p.id === "openai" && p.connected), false);
  await assert.rejects(resolveModel("alice", "openai/gpt-a"), /administrator/);

  setModelAccessPolicies("openai", [{ target: { kind: "group", id: team.id }, mode: "selected", modelIds: ["gpt-gone"] }]);
  assert.equal((await listModels("alice")).some((m) => m.providerId === "openai"), false, "stale ids grant nothing at runtime");
  await assert.rejects(resolveModel("alice", "openai/gpt-a"), /administrator/);
  await assert.rejects(resolveModel("alice", "openai/gpt-gone"), /administrator/);
  setAudience("provider", "openai", { mode: "selected", userIds: [], groupIds: [] });
  await assert.rejects(resolveModel("alice", "openai/gpt-a"), /administrator/);
});

test("a user's own connection overrides shared policies for the same provider", async () => {
  shared();
  setAudience("provider", "openai", { mode: "selected", userIds: ["alice"], groupIds: [] });
  setModelAccessPolicies("openai", [{ target: { kind: "user", id: "alice" }, mode: "selected", modelIds: ["gpt-a"] }]);
  assert.deepEqual((await listModels("alice")).map((m) => m.id), ["gpt-a"]);

  saveConnection("alice", "openai", { apiKey: "sk-own", enabled: true });
  assert.equal(getConnection("alice", "openai")?.shared ?? false, false);
  assert.deepEqual((await listModels("alice")).map((m) => m.id).sort(), ["gpt-a", "gpt-b", "gpt-c"]);
  saveConnection("bob", "openai", { apiKey: "sk-own", enabled: true });
  assert.equal(getConnection("bob", "openai")?.shared ?? false, false);
  assert.deepEqual((await listModels("bob")).map((m) => m.id).sort(), ["gpt-a", "gpt-b", "gpt-c"]);
  assert.equal(sharedModelAccess("bob", "openai").visible, false);
});

test("editing an audience preserves retained policies, drops removed ones, and group deletion clears its policy", () => {
  shared();
  const first = createGroup("First", ["alice"]);
  const second = createGroup("Second", ["bob"]);
  setAudience("provider", "openai", { mode: "selected", userIds: ["carol"], groupIds: [first.id, second.id] });
  setModelAccessPolicies("openai", [
    { target: { kind: "group", id: first.id }, mode: "selected", modelIds: ["gpt-a"] },
    { target: { kind: "group", id: second.id }, mode: "selected", modelIds: ["gpt-b"] },
    { target: { kind: "user", id: "carol" }, mode: "selected", modelIds: ["gpt-c"] },
  ]);

  setAudience("provider", "openai", { mode: "selected", userIds: [], groupIds: [second.id] });
  assert.deepEqual(getAudience("provider", "openai"), { mode: "selected", userIds: [], groupIds: [second.id] });
  assert.deepEqual(listModelAccessPolicies("openai").map((p) => [p.target.kind, p.target.id, p.mode]), [["group", second.id, "selected"]]);
  assert.deepEqual(ids("bob"), ["gpt-b"], "the retained group keeps its policy");

  deleteGroup(second.id);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM provider_model_policies").get() as { n: number }).n, 0);
  assert.equal(sharedModelAccess("bob", "openai").visible, false);
});

test("deleting and re-adding a connection clears its policies and starts unrestricted", () => {
  shared();
  setAudience("provider", "openai", { mode: "selected", userIds: ["alice"], groupIds: [] });
  setModelAccessPolicies("openai", [{ target: { kind: "user", id: "alice" }, mode: "selected", modelIds: ["gpt-a"] }]);
  deleteConnection(null, "openai");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM provider_model_policies").get() as { n: number }).n, 0);

  shared();
  assert.deepEqual(listModelAccessPolicies("openai"), [{ target: { kind: "everyone", id: "" }, mode: "all", modelIds: [] }]);
  assert.equal(sharedModelAccess("alice", "openai").all, true);
});

test("the model factory rejects revoked and fabricated shared connections before building a provider", () => {
  shared();
  setAudience("provider", "openai", { mode: "selected", userIds: ["alice"], groupIds: [] });
  setModelAccessPolicies("openai", [{ target: { kind: "user", id: "alice" }, mode: "selected", modelIds: ["gpt-a"] }]);
  const connection = getSharedConnection("openai")!;
  assert.equal(connection.shared, true);

  createModel(model("gpt-a"), connection, { userId: "alice", creditPermit: creditPermit("alice"), usageContext: usage });
  assert.throws(() => createModel(model("gpt-b"), connection, { userId: "alice", creditPermit: creditPermit("alice"), usageContext: usage }), /administrator/);
  assert.throws(() => createModel(model("gpt-a"), connection, { userId: "carol", creditPermit: creditPermit("carol"), usageContext: usage }), /administrator/);
  assert.throws(() => createModel(model("gpt-a"), { ...connection, providerId: "anthropic" }, { userId: "alice", creditPermit: creditPermit("alice"), usageContext: usage }), /do not match/);

  saveConnection("bob", "openai", { apiKey: "sk-own", enabled: true });
  const own = getConnection("bob", "openai")!;
  assert.equal(own.shared, undefined);
  createModel(model("gpt-c"), own, { userId: "bob", creditPermit: creditPermit("bob"), usageContext: usage });
  setModelAccessPolicies("openai", [{ target: { kind: "user", id: "alice" }, mode: "selected", modelIds: [] }]);
  assert.throws(() => createModel(model("gpt-a"), connection, { userId: "alice", creditPermit: creditPermit("alice"), usageContext: usage }), /administrator/, "an earlier connection cannot bypass a live revoke");
  try {
    createModel(model("gpt-a"), connection, { userId: "alice", creditPermit: creditPermit("alice"), usageContext: usage });
    assert.fail("the revoked model must be refused");
  } catch (error) {
    const wire = describeProviderError(error, { log: false });
    assert.equal(wire.code, "forbidden", "a revoke inside a stream is a policy refusal, not a rejected API key");
    assert.match(wire.message, /administrator/);
  }
});

test("admin policy routes enforce permission, audience targets, and catalog ids", async () => {
  shared();
  setAudience("provider", "openai", { mode: "selected", userIds: ["alice"], groupIds: [] });

  assert.equal((await request("GET", "/admin/providers/openai/entitlements")).status, 401);
  assert.equal((await request("GET", "/admin/providers/openai/entitlements", TOKENS.alice)).status, 403);
  assert.equal((await request("GET", "/admin/providers/nope/entitlements", TOKENS.admin)).status, 404);

  const read = await request("GET", "/admin/providers/openai/entitlements", TOKENS.admin);
  assert.equal(read.status, 200);
  const body = (await read.json()) as { policies: Array<{ target: { kind: string; id: string }; mode: string }>; models: Array<{ id: string }> };
  assert.deepEqual(body.models.map((m) => m.id), ["gpt-a", "gpt-b", "gpt-c"]);
  assert.deepEqual(body.policies, [{ target: { kind: "user", id: "alice" }, mode: "all", modelIds: [] }]);

  const put = (policies: unknown) => request("PUT", "/admin/providers/openai/entitlements", TOKENS.admin, { policies });
  assert.equal((await put([{ target: { kind: "user", id: "bob" }, mode: "selected", modelIds: [] }])).status, 400, "target outside the audience");
  assert.equal((await put([{ target: { kind: "user", id: "alice" }, mode: "selected", modelIds: ["gpt-nope"] }])).status, 400);
  assert.equal(
    (await put([
      { target: { kind: "user", id: "alice" }, mode: "selected", modelIds: [] },
      { target: { kind: "user", id: "alice" }, mode: "selected", modelIds: [] },
    ])).status,
    400,
    "duplicate targets",
  );
  assert.equal((await put([{ target: { kind: "user", id: "alice" }, mode: "selected", modelIds: ["gpt-a", "gpt-a"] }])).status, 200);
  assert.deepEqual((await listModelAccessPolicies("openai"))[0]!.modelIds, ["gpt-a"]);

  // Already stored stale ids survive an edit of the same audience, but new ones cannot be injected.
  setModelAccessPolicies("openai", [{ target: { kind: "user", id: "alice" }, mode: "selected", modelIds: ["gpt-a", "gpt-gone"] }]);
  assert.equal((await put([{ target: { kind: "user", id: "alice" }, mode: "selected", modelIds: ["gpt-a", "gpt-gone"] }])).status, 200);
  assert.equal((await put([{ target: { kind: "user", id: "alice" }, mode: "selected", modelIds: ["gpt-a", "gpt-new"] }])).status, 400);
  const stale = (await (await request("GET", "/admin/providers/openai/entitlements", TOKENS.admin)).json()) as {
    policies: Array<{ modelIds: string[] }>;
    models: Array<{ id: string }>;
  };
  assert.deepEqual(stale.policies[0]!.modelIds, ["gpt-a", "gpt-gone"]);
  assert.equal(stale.models.some((model) => model.id === "gpt-gone"), false, "stale ids stay stored but are not in the catalog");

  assert.equal((await put([{ target: { kind: "user", id: "alice" }, mode: "all", modelIds: [] }])).status, 200);
  assert.equal(getModelAccessPolicy("openai", { kind: "user", id: "alice" }).mode, "all");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM provider_model_grants").get() as { n: number }).n, 0);
});


test("a partial policy update leaves another audience's restriction intact", async () => {
  shared();
  setAudience("provider", "openai", { mode: "selected", userIds: ["alice", "bob"], groupIds: [] });
  setModelAccessPolicies("openai", [
    { target: { kind: "user", id: "alice" }, mode: "selected", modelIds: ["gpt-a"] },
    { target: { kind: "user", id: "bob" }, mode: "selected", modelIds: ["gpt-b"] },
  ]);
  const response = await request("PUT", "/admin/providers/openai/entitlements", TOKENS.admin, { policies: [
    { target: { kind: "user", id: "alice" }, mode: "all", modelIds: [] },
  ] });
  assert.equal(response.status, 200);
  assert.deepEqual((await listModels("bob")).map((m) => m.id), ["gpt-b"]);
  assert.equal((await request("PUT", "/admin/providers/openai/entitlements", TOKENS.bob, { policies: [] })).status, 403);
});
