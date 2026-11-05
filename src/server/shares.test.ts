import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { SharedThread } from "../shared/types.js";
import type { ShareLink } from "../shared/share-links.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-shares-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "shares-test-secret-only-not-for-production";
const { db } = await import("./db.js");
const { sha256 } = await import("./crypto.js");
const { appendMessage } = await import("./threads.js");
const { api } = await import("./routes.js");
const { publicShareRoutes } = await import("./shares.js");

for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", 1);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
}
// Public routes mount before the authenticated router, as in index.ts: the api sub-app's requireUser
// middleware otherwise matches `/api/*` first and answers 401.
const app = new Hono().route("/api/public/shares", publicShareRoutes).route("/api", api);
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  db.exec("DELETE FROM shares; DELETE FROM artifacts; DELETE FROM messages; DELETE FROM threads; DELETE FROM comparison_groups");
  db.prepare("INSERT INTO threads (id, user_id, title, created_at, updated_at) VALUES ('t1', 'alice', 'Trip', 1, 1)").run();
  db.prepare("INSERT INTO threads (id, user_id, title, created_at, updated_at) VALUES ('t2', 'alice', 'Other', 1, 1)").run();
  db.prepare("INSERT INTO threads (id, user_id, title, created_at, updated_at) VALUES ('t3', 'alice', 'Private', 1, 1)").run();
  db.prepare("INSERT INTO threads (id, user_id, title, created_at, updated_at) VALUES ('tb', 'bob', 'Bob chat', 1, 1)").run();
});

const store = (threadId: string, id: string, parent: string | null, role: "user" | "assistant", parts: unknown[]) =>
  appendMessage("alice", threadId, { id, parent_id: parent, format: "ai-sdk/v6", content: { role, parts } });

const call = (url: string, init: { method?: string; json?: unknown; user?: string; cookie?: string } = {}) =>
  app.request(`http://app/api${url}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.cookie ? { cookie: init.cookie } : { cookie: `okaychat_session=${init.user ?? "alice"}` }),
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });

const publicCall = (token: string, suffix = "", init: { method?: string; json?: unknown; cookie?: string } = {}) =>
  app.request(`http://app/api/public/shares/${token}${suffix}`, {
    method: init.method ?? "GET",
    headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });

const create = async (threadId: string, json: Record<string, unknown> = {}) => {
  const response = await call(`/threads/${threadId}/shares`, { method: "POST", json });
  const body = (await response.json()) as { share: ShareLink };
  return { response, share: body.share };
};

const cookiePair = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

test("a chat has several links, the manager pages through them, and only the owner may change one", async () => {
  for (const label of ["One", "Two", "Three"]) assert.equal((await create("t1", { label })).response.status, 201);
  const first = (await (await call("/shares?state=all&limit=2")).json()) as { shares: ShareLink[]; nextCursor: string | null };
  assert.equal(first.shares.length, 2);
  assert.ok(first.nextCursor);
  const second = (await (await call(`/shares?state=all&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)).json()) as { shares: ShareLink[]; nextCursor: string | null };
  assert.equal(second.shares.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.shares, ...second.shares].map((share) => share.token)).size, 3);

  const listed = (await (await call("/threads/t1/shares")).json()) as { shares: ShareLink[]; sharingDisabled: boolean };
  assert.equal(listed.shares.length, 3);
  assert.equal(listed.sharingDisabled, false);
  assert.ok(listed.shares.every((share) => share.threadTitle === "Trip" && share.mode === "live" && !share.hasPassword));

  const token = listed.shares[0]!.token;
  assert.equal((await call(`/shares/${token}`, { method: "PATCH", json: { label: "Renamed" }, user: "bob" })).status, 404);
  assert.equal((await call(`/shares/${token}`, { method: "DELETE", user: "bob" })).status, 200);
  assert.equal((await call(`/shares/${token}`)).status, 404, "a foreign revoke must not delete the row");
  const ownerPatch = (await (await call(`/shares/${token}`, { method: "PATCH", json: { label: "Renamed" } })).json()) as { share: ShareLink };
  assert.equal(ownerPatch.share.label, "Renamed");
});

test("an expiry hides the link and moves it to the expired filter", async () => {
  assert.equal((await create("t1", { expiresAt: Date.now() - 1000 })).response.status, 400);
  const { share } = await create("t1", { expiresAt: Date.now() + 60_000 });
  db.prepare("UPDATE shares SET expires_at = ? WHERE token = ?").run(Date.now() - 1, share.token);
  const denied = await publicCall(share.token);
  assert.equal(denied.status, 404);
  assert.equal(denied.headers.get("cache-control"), "no-store");
  const active = (await (await call("/shares?state=active")).json()) as { shares: ShareLink[] };
  assert.deepEqual(active.shares, []);
  const expired = (await (await call("/shares?state=expired")).json()) as { shares: ShareLink[] };
  assert.deepEqual(expired.shares.map((item) => item.token), [share.token]);
});

test("a live link follows the branch; a frozen link keeps its capture and its artifact versions", async () => {
  store("t1", "m1", null, "user", [{ type: "text", text: "First question" }]);
  store("t1", "a1", "m1", "assistant", [
    { type: "text", text: "First answer" },
    { type: "tool-create_artifact", toolName: "create_artifact", state: "output-available", output: { id: "art", title: "Doc", kind: "markdown", version: 1 } },
  ]);
  const artifact = db.prepare("INSERT INTO artifacts (thread_id, id, version, title, kind, language, content, created_at, data, size) VALUES (?, ?, ?, 'Doc', 'markdown', NULL, ?, 1, x'', 0)");
  artifact.run("t1", "art", 1, "# Version one");

  const live = (await create("t1")).share;
  const frozen = (await create("t1", { mode: "frozen" })).share;
  assert.equal(frozen.frozenAt !== null, true);

  store("t1", "m2", "a1", "user", [{ type: "text", text: "Second question" }]);
  store("t1", "a2", "m2", "assistant", [
    { type: "text", text: "Second answer" },
    { type: "tool-update_artifact", toolName: "update_artifact", state: "output-available", output: { id: "art", title: "Doc", kind: "markdown", version: 2 } },
  ]);
  artifact.run("t1", "art", 2, "# Version two");

  const livePayload = (await (await publicCall(live.token)).json()) as SharedThread;
  const frozenPayload = (await (await publicCall(frozen.token)).json()) as SharedThread;
  assert.equal(livePayload.mode, "live");
  assert.equal(frozenPayload.mode, "frozen");
  assert.match(JSON.stringify(livePayload.messages), /Second answer/);
  assert.doesNotMatch(JSON.stringify(frozenPayload.messages), /Second answer/);
  assert.match(JSON.stringify(frozenPayload.messages), /First answer/);

  const liveVersions = (await (await publicCall(live.token, "/artifacts/art")).json()) as Array<{ version: number }>;
  const frozenVersions = (await (await publicCall(frozen.token, "/artifacts/art")).json()) as Array<{ version: number }>;
  assert.deepEqual(liveVersions.map((version) => version.version), [1, 2]);
  assert.deepEqual(frozenVersions.map((version) => version.version), [1]);

  const refreshed = (await (await call(`/shares/${frozen.token}`, { method: "PATCH", json: { refreshSnapshot: true } })).json()) as { share: ShareLink };
  assert.equal(refreshed.share.mode, "frozen");
  const nextFrozen = (await (await publicCall(frozen.token)).json()) as SharedThread;
  assert.match(JSON.stringify(nextFrozen.messages), /Second answer/);
  const nextVersions = (await (await publicCall(frozen.token, "/artifacts/art")).json()) as Array<{ version: number }>;
  assert.deepEqual(nextVersions.map((version) => version.version), [1, 2]);
});

test("switching a frozen link back to live drops the capture", async () => {
  store("t1", "m1", null, "user", [{ type: "text", text: "Before" }]);
  const frozen = (await create("t1", { mode: "frozen" })).share;
  store("t1", "m2", "m1", "user", [{ type: "text", text: "After" }]);
  const switched = (await (await call(`/shares/${frozen.token}`, { method: "PATCH", json: { mode: "live" } })).json()) as { share: ShareLink };
  assert.equal(switched.share.frozenAt, null);
  const row = db.prepare("SELECT snapshot_json, snapshot_assets_json FROM shares WHERE token = ?").get(frozen.token) as { snapshot_json: string | null; snapshot_assets_json: string | null };
  assert.deepEqual([row.snapshot_json, row.snapshot_assets_json], [null, null]);
  const payload = (await (await publicCall(frozen.token)).json()) as SharedThread;
  assert.match(JSON.stringify(payload.messages), /After/);
});

test("password protection gates the payload and every asset until unlocked; changing it invalidates old cookies", async () => {
  store("t1", "m1", null, "user", [{ type: "text", text: "Secret plan" }]);
  const { share } = await create("t1", { password: "correct-horse" });
  assert.equal(share.hasPassword, true);

  const locked = await publicCall(share.token);
  assert.equal(locked.status, 423);
  assert.deepEqual(await locked.json(), { locked: true, error: "This link is protected by a password." });
  assert.equal((await publicCall(share.token, "/artifacts/art")).status, 423);

  assert.equal((await publicCall(share.token, "/unlock", { method: "POST", json: { password: "wrong" } })).status, 401);
  const unlocked = await publicCall(share.token, "/unlock", { method: "POST", json: { password: "correct-horse" } });
  assert.equal(unlocked.status, 200);
  const cookie = cookiePair(unlocked);
  assert.match(cookie, /^okc_share_/);
  const payload = await publicCall(share.token, "", { cookie });
  assert.equal(payload.status, 200);
  assert.match(JSON.stringify(await payload.json()), /Secret plan/);

  // A new password makes every earlier cookie unverifiable.
  assert.equal((await call(`/shares/${share.token}`, { method: "PATCH", json: { password: "another-secret" } })).status, 200);
  assert.equal((await publicCall(share.token, "", { cookie })).status, 423);

  // Removing it opens the link for everyone.
  assert.equal((await call(`/shares/${share.token}`, { method: "PATCH", json: { password: null } })).status, 200);
  assert.equal((await publicCall(share.token)).status, 200);
  assert.equal((await publicCall(share.token, "/unlock", { method: "POST", json: { password: "x" } })).status, 400);
});

test("unlock attempts are rate limited per link and client", async () => {
  store("t1", "m1", null, "user", [{ type: "text", text: "Gated" }]);
  const { share } = await create("t1", { password: "correct-horse" });
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await publicCall(share.token, "/unlock", { method: "POST", json: { password: "wrong" } });
    assert.equal(response.status, 401);
  }
  const blocked = await publicCall(share.token, "/unlock", { method: "POST", json: { password: "correct-horse" } });
  assert.equal(blocked.status, 429);
});

test("a comparison pane cannot be shared, and a temporary id never reaches the API", async () => {
  db.prepare("INSERT INTO comparison_groups (id, user_id, title, prompt, created_at, updated_at) VALUES ('g1', 'alice', 'Compare', 'Prompt', 1, 1)").run();
  db.prepare("UPDATE threads SET compare_group_id = 'g1' WHERE id = 't1'").run();
  const refused = await call("/threads/t1/shares", { method: "POST", json: {} });
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /Open this answer as a chat/);
  assert.equal((await call("/threads/tmp_123/shares", { method: "POST", json: {} })).status, 404);
});

test("a discarded branch's image stays private on both link kinds", async () => {
  store("t1", "m1", null, "user", [{ type: "text", text: "Main" }]);
  db.prepare("INSERT INTO images (id, user_id, thread_id, prompt, created_at, size) VALUES ('img_live', 'alice', 't1', 'p', 1, 1)").run();
  db.prepare("INSERT INTO image_threads (image_id, thread_id) VALUES ('img_live', 't1')").run();
  store("t1", "m2", "m1", "assistant", [
    { type: "tool-generate_image", toolName: "generate_image", state: "output-available", output: { id: "img_live" } },
  ]);
  // A second image exists on the account but no shared message shows it.
  db.prepare("INSERT INTO images (id, user_id, thread_id, prompt, created_at, size) VALUES ('img_hidden', 'alice', 't3', 'p', 1, 1)").run();

  const live = (await create("t1")).share;
  const frozen = (await create("t1", { mode: "frozen" })).share;
  assert.equal((await publicCall(live.token, "/images/img_hidden")).status, 404);
  assert.equal((await publicCall(frozen.token, "/images/img_hidden")).status, 404);

});
