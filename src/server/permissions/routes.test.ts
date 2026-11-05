import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-permissions-routes-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "permissions-routes-test-secret-only-not-for-production";
// A tiny catalog keeps every route offline. The fake catalog below is the authority for validation.
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

const { db } = await import("../db.js");
const { sha256 } = await import("../crypto.js");
const { requireUser } = await import("../auth.js");
const { createGroup, setAudience } = await import("../groups.js");
const { saveConnection } = await import("../catalog/providers.js");
const mcp = await import("../mcp/store.js");
const { storedModelRefs } = await import("./store.js");
const { createPermissionRouters, permissionRoutes } = await import("./routes.js");
const { makeCatalogFingerprint } = await import("./workspace.js");
import type { CatalogSnapshot, CatalogSource } from "./workspace.js";

const TOKENS = { admin: "admin-session", alice: "alice-session", bob: "bob-session", carol: "carol-session" } as const;
type UserId = keyof typeof TOKENS;

for (const [id, role] of [
  ["admin", "admin"],
  ["alice", "user"],
  ["bob", "user"],
  ["carol", "user"],
] as const) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    `${id}@example.test`,
    id,
    "unused",
    role,
    Date.now(),
  );
}

let catalogMode: "ready" | "unavailable" = "ready";
let catalogOnSnapshot: (() => void) | null = null;
let currentRefs = ["openai/gpt-a", "openai/gpt-b"];

function snapshot(): CatalogSnapshot {
  catalogOnSnapshot?.();
  const storedRefs = storedModelRefs().sort();
  const refs = catalogMode === "ready" ? [...currentRefs].sort() : [];
  const models = [
    ...refs.map((ref) => ({
      ref,
      providerId: ref.slice(0, ref.indexOf("/")),
      id: ref.slice(ref.indexOf("/") + 1),
      name: ref.slice(ref.indexOf("/") + 1),
      context: 100_000,
      maxOutput: 8_000,
      stored: storedRefs.includes(ref),
      present: true,
    })),
    ...storedRefs
      .filter((ref) => !refs.includes(ref))
      .map((ref) => ({
        ref,
        providerId: ref.slice(0, ref.indexOf("/")),
        id: ref.slice(ref.indexOf("/") + 1),
        name: ref.slice(ref.indexOf("/") + 1),
        stored: true,
        present: false,
      })),
  ];
  const status = [
    {
      providerId: "openai",
      state: catalogMode === "unavailable" ? ("unavailable" as const) : storedRefs.some((ref) => !refs.includes(ref)) ? ("stale" as const) : ("ready" as const),
      checkedAt: 1,
    },
  ];
  return {
    currentRefs: refs,
    storedRefs,
    refs: [...new Set([...refs, ...storedRefs])].sort(),
    models: models.sort((a, b) => a.ref.localeCompare(b.ref)),
    providers: [
      { id: "openai", name: "OpenAI", connected: true, enabled: true, shared: true, modelCount: refs.length },
    ],
    status,
    fingerprint: makeCatalogFingerprint(refs, storedRefs, status),
  };
}

const catalog: CatalogSource = {
  snapshot: async () => snapshot(),
  userRefs: async () => ({ refs: catalogMode === "ready" ? [...currentRefs] : [], unavailable: catalogMode !== "ready" }),
};

const routers = createPermissionRouters({ catalog });
const app = new Hono().use(requireUser).route("/", routers.admin).route("/", routers.self);
// The exported router is what the application mounts; a smoke request below proves it is self-contained.
const exportedApp = new Hono().use(requireUser).route("/", permissionRoutes);

const signIn = (userId: UserId) =>
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(TOKENS[userId]), userId, Date.now() + 60_000);

const request = (method: string, url: string, token?: string, body?: unknown, raw?: string) =>
  app.request(`http://app${url}`, {
    method,
    headers: {
      ...(token ? { cookie: `okaychat_session=${token}` } : {}),
      ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const json = async (response: Response) => (await response.json()) as any;
const revision = () => (db.prepare("SELECT revision FROM permission_state WHERE singleton = 1").get() as { revision: number }).revision;
const policyCount = () => (db.prepare("SELECT COUNT(*) AS n FROM permission_policies").get() as { n: number }).n;

const group = () => {
  const row = db.prepare("SELECT id FROM user_groups WHERE name = 'Team'").get() as { id: string } | undefined;
  if (row) return row.id;
  const created = createGroup("Team", ["alice", "bob"]);
  db.prepare("UPDATE user_groups SET prompt_order = 10 WHERE id = ?").run(created.id);
  return created.id;
};

const policyChange = (document: unknown, subject: unknown = { kind: "everyone", id: "" }, modelRef: string | null = null) => ({
  kind: "policy",
  subject,
  modelRef,
  document,
});

const previewBody = (changes: unknown[], extra: Record<string, unknown> = {}) => ({
  baseRevision: revision(),
  changes,
  ...extra,
});

beforeEach(() => {
  db.exec(`DELETE FROM permission_policies;
    DELETE FROM prompt_rules;
    DELETE FROM permission_audit WHERE revision > 1;
    UPDATE permission_state SET revision = 1;
    DELETE FROM user_model_instructions;
    DELETE FROM user_group_members;
    DELETE FROM user_groups;
    DELETE FROM share_audiences;
    DELETE FROM share_users;
    DELETE FROM share_groups;
    DELETE FROM provider_model_policies;
    DELETE FROM provider_model_grants;
    DELETE FROM shared_connections;
    DELETE FROM provider_connections;
    DELETE FROM mcp_servers;
    DELETE FROM sessions;
    DELETE FROM threads;
    DELETE FROM user_settings;`);
  for (const userId of Object.keys(TOKENS) as UserId[]) {
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(userId === "admin" ? "admin" : "user", userId);
    signIn(userId);
  }
  catalogMode = "ready";
  catalogOnSnapshot = null;
  currentRefs = ["openai/gpt-a", "openai/gpt-b"];
});

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("admin routes require an admin; self routes require a session; admin reads are no-store", async () => {
  assert.equal((await request("GET", "/admin/permissions/bootstrap")).status, 401);
  assert.equal((await request("GET", "/admin/permissions/bootstrap", TOKENS.alice)).status, 403);
  const response = await request("GET", "/admin/permissions/bootstrap", TOKENS.admin);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await request("GET", "/permissions")).status, 401);
  const exported = await exportedApp.request("http://app/admin/permissions/bootstrap", { headers: { cookie: `okaychat_session=${TOKENS.admin}` } });
  assert.equal(exported.status, 200);
});

test("bootstrap exposes the registry, subjects, shared catalog, and stored selectors", async () => {
  group();
  db.prepare("INSERT INTO permission_policies (subject_kind, subject_id, model_ref, document, updated_at, updated_by) VALUES ('user', 'alice', 'openai/gpt-old', ?, 1, NULL)").run(
    JSON.stringify({ version: 1, features: { code: false } }),
  );
  const body = await json(await request("GET", "/admin/permissions/bootstrap", TOKENS.admin));
  assert.equal(body.revision, 1);
  assert.equal(body.registry.features.length, 22);
  assert.equal(body.registry.limits.length, 7);
  assert.equal(body.registry.hardCaps.concurrentTurns, 4);
  assert.deepEqual(body.subjects.users.map((user: any) => user.id).sort(), ["admin", "alice", "bob", "carol"]);
  assert.deepEqual(body.subjects.groups[0].userIds.sort(), ["alice", "bob"]);
  assert.equal(body.subjects.groups[0].promptOrder, 10);
  const refs = body.modelCatalog.map((model: any) => model.ref);
  assert.ok(refs.includes("openai/gpt-a"));
  assert.ok(refs.includes("openai/gpt-old"));
  assert.equal(body.modelCatalog.find((model: any) => model.ref === "openai/gpt-old").present, false);
  assert.equal(body.catalogStatus[0].state, "stale");
});

test("policies requires a live subject and only the everyone view includes server prompts", async () => {
  assert.equal((await request("GET", "/admin/permissions/policies?subjectKind=user&subjectId=ghost", TOKENS.admin)).status, 404);
  assert.equal((await request("GET", "/admin/permissions/policies?subjectKind=nope&subjectId=", TOKENS.admin)).status, 400);
  const everyone = await json(await request("GET", "/admin/permissions/policies?subjectKind=everyone&subjectId=", TOKENS.admin));
  assert.equal(everyone.revision, 1);
  assert.ok(Array.isArray(everyone.serverPrompts));
  const alice = await json(await request("GET", "/admin/permissions/policies?subjectKind=user&subjectId=alice", TOKENS.admin));
  assert.equal(alice.serverPrompts, undefined);
});

test("preview is strict, validates subjects and selectors, and writes nothing", async () => {
  const beforeRevision = revision();
  const body = previewBody([policyChange({ version: 1, features: { code: false } })]);
  const preview = await request("POST", "/admin/permissions/preview", TOKENS.admin, body);
  assert.equal(preview.status, 200);
  const result = await json(preview);
  assert.equal(result.baseRevision, beforeRevision);
  assert.match(result.draftHash, /^[a-f0-9]{64}$/);
  assert.ok(result.counts.featuresChanged >= 1);
  assert.equal(result.rows[0].path, "features.code");
  assert.equal(revision(), beforeRevision);
  assert.equal(policyCount(), 0);

  assert.equal((await request("POST", "/admin/permissions/preview", TOKENS.admin, { ...body, extra: true })).status, 400);
  assert.equal(
    (await request("POST", "/admin/permissions/preview", TOKENS.admin, undefined, '{"baseRevision":1,"baseRevision":1,"changes":[]}')).status,
    400,
  );
  assert.equal(
    (await request("POST", "/admin/permissions/preview", TOKENS.admin, previewBody([policyChange({ version: 1 }, { kind: "user", id: "ghost" })]))).status,
    404,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/admin/permissions/preview",
        TOKENS.admin,
        previewBody([
          policyChange({ version: 1, features: { code: false } }),
          policyChange({ version: 1, features: { code: true } }),
        ]),
      )
    ).status,
    400,
  );
  assert.equal((await request("POST", "/admin/permissions/preview", TOKENS.admin, { ...body, baseRevision: 0 })).status, 409);
  assert.equal(
    (await request("POST", "/admin/permissions/preview", TOKENS.admin, previewBody([policyChange({ version: 1 }, { kind: "user", id: "alice" }, "not-a-ref")]))).status,
    400,
  );
});

test("catalog outage refuses a new selector but permits removing a retained stale one", async () => {
  db.prepare("INSERT INTO permission_policies (subject_kind, subject_id, model_ref, document, updated_at, updated_by) VALUES ('user', 'alice', 'openai/gpt-old', ?, 1, NULL)").run(
    JSON.stringify({ version: 1 }),
  );
  catalogMode = "unavailable";
  const newSelector = await request(
    "POST",
    "/admin/permissions/preview",
    TOKENS.admin,
    previewBody([policyChange({ version: 1, features: { code: false } }, { kind: "user", id: "alice" }, "openai/gpt-new")]),
  );
  assert.equal(newSelector.status, 503);
  const removeStale = await request(
    "POST",
    "/admin/permissions/preview",
    TOKENS.admin,
    previewBody([policyChange(null, { kind: "user", id: "alice" }, "openai/gpt-old")]),
  );
  assert.equal(removeStale.status, 200);
});

test("preview filters rows but counts the full change set, and cursors are draft-bound", async () => {
  const team = group();
  const changes = [
    policyChange({ version: 1, features: { code: false } }, { kind: "group", id: team }),
    policyChange({ version: 1, features: { code: false } }, { kind: "user", id: "carol" }),
  ];
  const first = await json(
    await request("POST", "/admin/permissions/preview", TOKENS.admin, previewBody(changes, { filter: { userIds: ["alice", "bob"] }, limit: 1 })),
  );
  assert.equal(first.counts.usersAffected, 3);
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].userId, "alice");
  assert.equal(first.counts.featuresChanged, 3);
  assert.ok(first.nextCursor);
  const second = await json(
    await request("POST", "/admin/permissions/preview", TOKENS.admin, previewBody(changes, { filter: { userIds: ["alice", "bob"] }, limit: 1, cursor: first.nextCursor })),
  );
  assert.equal(second.rows.length, 1);
  assert.equal(second.rows[0].userId, "bob");
  const other = await json(await request("POST", "/admin/permissions/preview", TOKENS.admin, previewBody([policyChange({ version: 1, features: { images: false } })])));
  const mismatch = await request("POST", "/admin/permissions/preview", TOKENS.admin, previewBody(changes, { cursor: other.nextCursor ?? "bad" }));
  assert.equal(mismatch.status, 400);
});

test("preview impact rows hash prompt text; explicit inspection shows the draft", async () => {
  const change = {
    kind: "prompt",
    subject: { kind: "user", id: "alice" },
    modelRef: null,
    key: "chat",
    rule: { mode: "replace", text: "ADMIN SECRET INSTRUCTION" },
  };
  const preview = await json(
    await request(
      "POST",
      "/admin/permissions/preview",
      TOKENS.admin,
      previewBody([change], { inspect: { userId: "alice", modelRef: "openai/gpt-a" } }),
    ),
  );
  const row = preview.rows.find((entry: any) => entry.path === "prompts.chat");
  assert.ok(row);
  assert.notEqual(row.after, "ADMIN SECRET INSTRUCTION");
  assert.equal(String(row.after).length, 16);
  assert.ok(preview.inspection.prompts.some((prompt: any) => prompt.effectiveTemplate.includes("ADMIN SECRET INSTRUCTION")));
});

test("commit applies one revision and one encrypted audit event; no-op commits do not bump", async () => {
  const body = previewBody([policyChange({ version: 1, features: { code: false } })]);
  const preview = await json(await request("POST", "/admin/permissions/preview", TOKENS.admin, body));
  const commit = await request(
    "POST",
    "/admin/permissions/commit",
    TOKENS.admin,
    { ...body, draftHash: preview.draftHash, catalogFingerprint: preview.catalogFingerprint, reason: "Disable code" },
  );
  assert.equal(commit.status, 200);
  const result = await json(commit);
  assert.equal(result.revision, 2);
  assert.equal(result.summary.changes, 1);
  assert.deepEqual(result.affectedUserIds, ["admin", "alice", "bob", "carol"]);
  assert.equal(policyCount(), 1);
  const audit = db.prepare("SELECT revision, summary_json, changes_enc FROM permission_audit WHERE revision = 2").get() as {
    revision: number;
    summary_json: string;
    changes_enc: string;
  };
  assert.equal(audit.revision, 2);
  assert.ok(!audit.changes_enc.includes("features"));
  assert.ok(!audit.changes_enc.includes("code"));
  const detail = await json(await request("GET", "/admin/permissions/audit/2", TOKENS.admin));
  assert.equal(detail.changes[0].after.features.code, false);

  const noopPreview = await json(await request("POST", "/admin/permissions/preview", TOKENS.admin, previewBody([policyChange({ version: 1, features: { code: false } })])));
  const noop = await request(
    "POST",
    "/admin/permissions/commit",
    TOKENS.admin,
    { ...body, baseRevision: revision(), draftHash: noopPreview.draftHash, catalogFingerprint: noopPreview.catalogFingerprint, reason: "No change" },
  );
  assert.equal(noop.status, 200);
  const noopResult = await json(noop);
  assert.equal(noopResult.revision, 2);
  assert.equal(noopResult.summary.changes, 0);
  assert.equal(revision(), 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM permission_audit").get() as { n: number }).n, 2);
});

test("a failed audit append rolls back every policy row and the revision", async () => {
  const body = previewBody([policyChange({ version: 1, features: { code: false } })]);
  const preview = await json(await request("POST", "/admin/permissions/preview", TOKENS.admin, body));
  // Force the audit insert to collide after the policy write, inside the same transaction.
  db.prepare("INSERT INTO permission_audit (revision, actor_id, occurred_at, kind, summary_json, changes_enc) VALUES (2, NULL, 1, 'policy', '{}', '')").run();
  const failed = await request("POST", "/admin/permissions/commit", TOKENS.admin, {
    ...body,
    draftHash: preview.draftHash,
    catalogFingerprint: preview.catalogFingerprint,
    reason: "Will roll back",
  });
  assert.equal(failed.status, 500);
  assert.equal(policyCount(), 0);
  assert.equal(revision(), 1);
});

test("commit rejects stale revision, hash, fingerprint, and a demotion during validation", async () => {
  const body = previewBody([policyChange({ version: 1, features: { code: false } })]);
  const preview = await json(await request("POST", "/admin/permissions/preview", TOKENS.admin, body));
  const valid = { ...body, draftHash: preview.draftHash, catalogFingerprint: preview.catalogFingerprint, reason: "Reason" };
  assert.equal((await request("POST", "/admin/permissions/commit", TOKENS.admin, { ...valid, baseRevision: 0 })).status, 409);
  assert.equal((await request("POST", "/admin/permissions/commit", TOKENS.admin, { ...valid, draftHash: "f".repeat(64) })).status, 409);
  assert.equal((await request("POST", "/admin/permissions/commit", TOKENS.admin, { ...valid, catalogFingerprint: "f".repeat(32) })).status, 409);
  assert.equal((await request("POST", "/admin/permissions/commit", TOKENS.admin, { ...valid, reason: "   " })).status, 400);
  assert.equal((await request("POST", "/admin/permissions/commit", TOKENS.admin, { ...valid, reason: "x".repeat(501) })).status, 400);

  catalogOnSnapshot = () => db.prepare("UPDATE users SET role = 'user' WHERE id = 'admin'").run();
  const demoted = await request("POST", "/admin/permissions/commit", TOKENS.admin, valid);
  assert.equal(demoted.status, 403);
  assert.equal(policyCount(), 0);
  assert.equal(revision(), 1);
});

test("effective inspection checks thread ownership and represents a denied model", async () => {
  db.prepare("INSERT INTO permission_policies (subject_kind, subject_id, model_ref, document, updated_at, updated_by) VALUES ('user', 'alice', 'openai/gpt-a', ?, 1, NULL)").run(
    JSON.stringify({ version: 1, modelAllowed: false }),
  );
  db.prepare("INSERT INTO threads (id, user_id, title, created_at, updated_at) VALUES ('thread-alice', 'alice', 'A', 1, 1)").run();
  db.prepare("INSERT INTO threads (id, user_id, title, created_at, updated_at) VALUES ('thread-bob', 'bob', 'B', 1, 1)").run();
  const denied = await json(
    await request("GET", "/admin/permissions/effective?userId=alice&modelRef=openai%2Fgpt-a", TOKENS.admin),
  );
  assert.equal(denied.access.accountAllowed, false);
  assert.equal(denied.access.allowed, false);
  assert.ok(denied.access.reasons.includes("modelOverride"));
  assert.equal(denied.model.catalogPresent, true);
  assert.ok(denied.prompts.length > 10);
  assert.equal(denied.assembly.estimateMethod, "characters/4");
  assert.equal((await request("GET", "/admin/permissions/effective?userId=alice&threadId=thread-bob", TOKENS.admin)).status, 404);
  assert.equal((await request("GET", "/admin/permissions/effective?userId=alice&threadId=thread-alice&temporary=1", TOKENS.admin)).status, 400);
  assert.equal((await request("GET", "/admin/permissions/effective", TOKENS.admin)).status, 400);
});

test("who-can-use resolves providers, models, and features with separate readiness", async () => {
  const team = group();
  saveConnection(null, "openai", { apiKey: "sk-shared", enabled: true });
  setAudience("provider", "openai", { mode: "selected", userIds: ["carol"], groupIds: [team] });
  const provider = await json(
    await request("GET", "/admin/permissions/who-can-use?resourceKind=provider&resourceId=openai&modelRef=openai%2Fgpt-a", TOKENS.admin),
  );
  assert.equal(provider.counts.allowed, 3);
  assert.equal(provider.counts.denied, 1);
  assert.deepEqual(provider.rows.map((row: any) => row.userId).sort(), ["admin", "alice", "bob", "carol"]);

  db.prepare("INSERT INTO permission_policies (subject_kind, subject_id, model_ref, document, updated_at, updated_by) VALUES ('user', 'carol', '', ?, 1, NULL)").run(
    JSON.stringify({ version: 1, features: { code: false } }),
  );
  const feature = await json(
    await request("GET", "/admin/permissions/who-can-use?resourceKind=feature&resourceId=code&modelRef=openai%2Fgpt-a", TOKENS.admin),
  );
  assert.equal(feature.rows.find((row: any) => row.userId === "carol").allowed, false);
  assert.equal(feature.counts.denied, 1);

  const model = await json(
    await request("GET", "/admin/permissions/who-can-use?resourceKind=model&resourceId=openai%2Fgpt-b", TOKENS.admin),
  );
  assert.equal(model.rows.find((row: any) => row.userId === "admin").allowed, false);
  assert.equal(model.rows.find((row: any) => row.userId === "admin").availability, "ready");

  const page = await json(
    await request("GET", "/admin/permissions/who-can-use?resourceKind=feature&resourceId=code&limit=2", TOKENS.admin),
  );
  assert.equal(page.rows.length, 2);
  assert.ok(page.nextCursor);
  assert.equal((await request("GET", "/admin/permissions/who-can-use?resourceKind=nope&resourceId=x", TOKENS.admin)).status, 400);
  assert.equal((await request("GET", "/admin/permissions/who-can-use?resourceKind=provider&resourceId=ghost", TOKENS.admin)).status, 404);
});

test("self permissions never leak sources, groups, or prompt text and explain dependencies", async () => {
  db.prepare("INSERT INTO permission_policies (subject_kind, subject_id, model_ref, document, updated_at, updated_by) VALUES ('everyone', '', '', ?, 1, NULL)").run(
    JSON.stringify({ version: 1, features: { webSearch: false } }),
  );
  const body = await json(await request("GET", "/permissions?modelRef=openai%2Fgpt-a", TOKENS.alice));
  assert.equal(body.modelRef, "openai/gpt-a");
  assert.equal(body.features.webSearch, false);
  assert.equal(body.disabledReasons.webSearch, "admin");
  assert.equal(body.disabledReasons.research, "dependency");
  assert.equal("groupIds" in body, false);
  assert.equal("provenance" in body, false);
  assert.equal(JSON.stringify(body).includes("everyone"), false);
  assert.equal((await request("GET", "/permissions?modelRef=not-a-ref", TOKENS.alice)).status, 400);
});

test("model instructions use the account revision for compare-and-set", async () => {
  const initial = await json(await request("GET", "/instructions/models?modelRef=openai%2Fgpt-a", TOKENS.alice));
  assert.equal(initial.revision, 0);
  assert.equal(initial.mode, "inherit");
  const appended = await request(
    "PUT",
    "/instructions/models",
    TOKENS.alice,
    { modelRef: "openai/gpt-a", baseRevision: 0, rule: { mode: "append", text: "Be brief." } },
  );
  assert.equal(appended.status, 200);
  const appendedBody = await json(appended);
  assert.equal(appendedBody.revision, 1);
  assert.equal(appendedBody.mode, "append");
  assert.equal(
    (await request("PUT", "/instructions/models", TOKENS.alice, { modelRef: "openai/gpt-a", baseRevision: 0, rule: { mode: "replace", text: "x" } })).status,
    409,
  );
  const replaced = await json(
    await request("PUT", "/instructions/models", TOKENS.alice, { modelRef: "openai/gpt-a", baseRevision: 1, rule: { mode: "replace", text: "Be formal." } }),
  );
  assert.equal(replaced.revision, 2);
  assert.equal((await request("GET", "/instructions/models?modelRef=openai%2Fgpt-unknown", TOKENS.alice)).status, 400);
  catalogMode = "unavailable";
  assert.equal((await request("GET", "/instructions/models?modelRef=openai%2Fgpt-a", TOKENS.alice)).status, 200);
  assert.equal((await request("GET", "/instructions/models?modelRef=openai%2Fgpt-new", TOKENS.alice)).status, 503);
  catalogMode = "ready";
  const reset = await json(
    await request("PUT", "/instructions/models", TOKENS.alice, { modelRef: "openai/gpt-a", baseRevision: 2, rule: null }),
  );
  assert.equal(reset.revision, 3);
  assert.equal(reset.mode, "inherit");
  assert.equal(
    (await request("PUT", "/instructions/models", TOKENS.alice, { modelRef: "openai/gpt-a", baseRevision: 3, rule: { mode: "append", text: "   " } })).status,
    400,
  );
  assert.equal(
    (await request("PUT", "/instructions/models", TOKENS.alice, { modelRef: "openai/gpt-a", baseRevision: 3, rule: null, extra: true })).status,
    400,
  );
});

test("audit listing filters by subject and detail is admin-only and decrypted", async () => {
  const body = previewBody([policyChange({ version: 1, features: { code: false } }, { kind: "user", id: "alice" })]);
  const preview = await json(await request("POST", "/admin/permissions/preview", TOKENS.admin, body));
  await request("POST", "/admin/permissions/commit", TOKENS.admin, {
    ...body,
    draftHash: preview.draftHash,
    catalogFingerprint: preview.catalogFingerprint,
    reason: "Alice only",
  });
  const list = await json(await request("GET", "/admin/permissions/audit?subjectKind=user&subjectId=alice", TOKENS.admin));
  assert.equal(list.retentionDays, 365);
  assert.ok(list.rows.some((row: any) => row.revision === 2 && row.reason === "Alice only"));
  const detail = await json(await request("GET", "/admin/permissions/audit/2", TOKENS.admin));
  assert.equal(detail.changes[0].after.features.code, false);
  assert.equal((await request("GET", "/admin/permissions/audit/999", TOKENS.admin)).status, 404);
  assert.equal((await request("GET", "/admin/permissions/audit", TOKENS.alice)).status, 403);
  assert.equal((await request("GET", "/admin/permissions/audit?limit=101", TOKENS.admin)).status, 400);
});

test("group order, membership, audience, and entitlement changes validate and commit atomically", async () => {
  const team = group();
  const second = createGroup("Second", ["carol"]);
  db.prepare("UPDATE user_groups SET prompt_order = 20 WHERE id = ?").run(second.id);
  saveConnection(null, "openai", { apiKey: "sk-shared", enabled: true });
  const server = mcp.createServer("admin", { name: "docs", transport: "http", config: { url: "https://example.test/mcp" }, enabled: true, shared: true });

  const changes = [
    { kind: "groupOrder", groupIds: [second.id, team] },
    { kind: "membership", groupId: team, userIds: ["alice"] },
    { kind: "providerAudience", providerId: "openai", audience: { mode: "selected", userIds: ["carol"], groupIds: [] } },
    { kind: "providerEntitlements", providerId: "openai", policies: [{ target: { kind: "user", id: "carol" }, mode: "selected", modelIds: ["gpt-a"] }] },
    { kind: "mcpAudience", serverId: server, audience: { mode: "selected", userIds: ["alice"], groupIds: [] } },
  ];
  const body = previewBody(changes);
  const preview = await request("POST", "/admin/permissions/preview", TOKENS.admin, body);
  assert.equal(preview.status, 200);
  const result = await json(preview);
  const commit = await request("POST", "/admin/permissions/commit", TOKENS.admin, {
    ...body,
    draftHash: result.draftHash,
    catalogFingerprint: result.catalogFingerprint,
    reason: "Restructure access",
  });
  assert.equal(commit.status, 200, await commit.text());
  assert.deepEqual(
    (db.prepare("SELECT id FROM user_groups ORDER BY prompt_order").all() as Array<{ id: string }>).map((row) => row.id),
    [second.id, team],
  );
  assert.deepEqual((db.prepare("SELECT user_id FROM user_group_members WHERE group_id = ? ORDER BY user_id").all(team) as Array<{ user_id: string }>).map((row) => row.user_id), ["alice"]);
  assert.deepEqual(
    (db.prepare("SELECT model_id FROM provider_model_grants WHERE provider_id = 'openai' AND target_kind = 'user' AND target_id = 'carol'").all() as Array<{ model_id: string }>).map((row) => row.model_id),
    ["gpt-a"],
  );
  assert.ok(db.prepare("SELECT 1 FROM share_users WHERE kind = 'mcp' AND resource_id = ? AND user_id = 'alice'").get(server));

  const badOrder = await request("POST", "/admin/permissions/preview", TOKENS.admin, previewBody([{ kind: "groupOrder", groupIds: [team] }]));
  assert.equal(badOrder.status, 400);
  const badMember = await request("POST", "/admin/permissions/preview", TOKENS.admin, previewBody([{ kind: "membership", groupId: team, userIds: ["ghost"] }]));
  assert.equal(badMember.status, 400);
  const badAudience = await request(
    "POST",
    "/admin/permissions/preview",
    TOKENS.admin,
    previewBody([
      { kind: "providerAudience", providerId: "openai", audience: { mode: "selected", userIds: ["alice"], groupIds: [] } },
      { kind: "providerEntitlements", providerId: "openai", policies: [{ target: { kind: "user", id: "carol" }, mode: "selected", modelIds: ["gpt-b"] }] },
    ]),
  );
  assert.equal(badAudience.status, 400);
});
