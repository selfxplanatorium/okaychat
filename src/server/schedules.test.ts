import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { Hono } from "hono";
import type { Schedule } from "../shared/types.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-schedules-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "schedules-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { saveConnection } = await import("./catalog/providers.js");
const { updateSettings } = await import("./settings.js");
const { requireUser } = await import("./auth.js");
const { sha256 } = await import("./crypto.js");
const { runSchedule, scheduleRoutes } = await import("./schedules.js");
const { currentBranch, getThread } = await import("./threads.js");
const app = new Hono().use(requireUser).route("/", scheduleRoutes);
// Admin: a non-admin base URL goes through the address-checked fetch, which bypasses the mocked global fetch.
for (const [id, role] of [["alice", "admin"], ["bob", "user"]]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', ?, 1)").run(id, `${id}@example.test`, id, role);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
}
saveConnection("alice", "custom-test", { baseURL: "http://mock.test/v1" });
updateSettings("alice", { maxSteps: 1, maxSearches: 0, webTools: false, artifacts: false, generativeUI: false, subagents: false, autoCompactAt: 0 });
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => {
  db.exec("DELETE FROM schedules; DELETE FROM messages; DELETE FROM threads; DELETE FROM projects;");
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p_alice', 'alice', 'Atlas', 1)").run();
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p_bob', 'bob', 'Secret', 1)").run();
  db.prepare("INSERT INTO threads (id, user_id, title, model_ref, created_at, updated_at) VALUES ('t_alice', 'alice', 'Mine', 'other/model', 1, 1)").run();
  db.prepare("INSERT INTO threads (id, user_id, created_at, updated_at) VALUES ('t_bob', 'bob', 1, 1)").run();
});

function provider(t: TestContext) {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "http://mock.test/v1/models") return Response.json({ data: [{ id: "mock" }] });
    assert.equal(url, "http://mock.test/v1/chat/completions");
    const chunks = [
      { id: "r", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] },
      { id: "r", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
}

const request = (url: string, json: unknown, user = "alice", method = "POST") =>
  app.request(`http://app${url}`, { method, body: JSON.stringify(json), headers: { cookie: `okaychat_session=${user}`, "content-type": "application/json" } });
const base = { title: "Brief", prompt: "Say hi", modelRef: "custom-test/mock", spec: { kind: "interval", minutes: 60, timeZone: "UTC" } };
async function create(extra: object): Promise<Schedule> {
  const res = await request("/schedules", { ...base, ...extra });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as Schedule;
}
const row = (id: string) => db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Parameters<typeof runSchedule>[0];
const run = (id: string) => runSchedule(row(id));

test("same-chat schedules reuse their own chat with earlier runs as history", async (t) => {
  provider(t);
  const s = await create({ projectId: "p_alice" });
  await run(s.id);
  await run(s.id);
  const threadId = row(s.id).thread_id!;
  assert.equal(currentBranch("alice", threadId).length, 4);
  const thread = getThread("alice", threadId)!;
  assert.equal(thread.title, "Brief");
  assert.equal(thread.projectId, "p_alice");
  assert.equal(thread.modelRef, "custom-test/mock");
});

test("new-chat schedules start a fresh chat per run and point at the latest", async (t) => {
  provider(t);
  const s = await create({ threadMode: "new", projectId: "p_alice" });
  await run(s.id);
  const first = row(s.id).thread_id!;
  await run(s.id);
  const second = row(s.id).thread_id!;
  assert.notEqual(first, second);
  for (const id of [first, second]) {
    assert.equal(currentBranch("alice", id).length, 2);
    assert.match(getThread("alice", id)!.title ?? "", /^Brief · /);
    assert.equal(getThread("alice", id)!.projectId, "p_alice");
  }
});

test("a picked chat keeps its model and is never recreated", async (t) => {
  provider(t);
  const s = await create({ threadId: "t_alice" });
  assert.equal(s.threadAttached, true);
  await run(s.id);
  assert.equal(currentBranch("alice", "t_alice").length, 2);
  assert.equal(getThread("alice", "t_alice")!.modelRef, "other/model");

  db.prepare("DELETE FROM threads WHERE id = 't_alice'").run();
  await run(s.id);
  const after = row(s.id);
  assert.equal(after.enabled, 0);
  assert.equal(after.last_status, "error");
  assert.equal(after.thread_id, null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM threads WHERE user_id = 'alice'").get() as { n: number }).n, 0);
});

test("editing keeps the schedule's own chat and releases a picked one", async () => {
  const s = await create({});
  db.prepare("UPDATE schedules SET thread_id = 't_own' WHERE id = ?").run(s.id);
  let res = await request(`/schedules/${s.id}`, { ...base, title: "Renamed" }, "alice", "PUT");
  assert.equal(((await res.json()) as Schedule).threadId, "t_own");
  res = await request(`/schedules/${s.id}`, { ...base, threadId: "t_alice" }, "alice", "PUT");
  assert.deepEqual(((await res.json()) as Schedule).threadAttached, true);
  res = await request(`/schedules/${s.id}`, { ...base }, "alice", "PUT");
  const back = (await res.json()) as Schedule;
  assert.equal(back.threadId, null);
  assert.equal(back.threadAttached, false);
});

test("another user's chat or project is refused", async () => {
  assert.equal((await request("/schedules", { ...base, threadId: "t_bob" })).status, 400);
  assert.equal((await request("/schedules", { ...base, projectId: "p_bob" })).status, 400);
});
