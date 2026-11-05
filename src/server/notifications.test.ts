import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-notifications-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "notifications-test-secret-only-not-for-production";
const { db } = await import("./db.js");
const { sha256 } = await import("./crypto.js");
const { notify, listNotifications, unreadCount, markRead, markUnread, markAllRead, dismiss, clearRead } = await import("./notifications.js");
const { api } = await import("./routes.js");

for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", 1);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
}
const app = new Hono().route("/api", api);
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => db.exec("DELETE FROM notifications"));

const call = (url: string, init: { method?: string; user?: string } = {}) =>
  app.request(`http://app/api${url}`, { method: init.method ?? "GET", headers: { cookie: `okaychat_session=${init.user ?? "alice"}` } });

const source = (key: string) => ({
  userId: "alice",
  kind: "schedule" as const,
  level: "success" as const,
  titleKey: "schedule.ok" as const,
  bodyKey: "schedule.okBody" as const,
  params: { title: "Daily", thread: "Trip" },
  threadId: "t1",
  actionPath: "/c/t1",
  sourceKey: key,
});

test("a source key dedupes a retried write, and an unknown key is dropped", () => {
  notify(source("schedule:s1:1"));
  notify(source("schedule:s1:1"));
  assert.equal(unreadCount("alice"), 1);
  notify({ ...source("schedule:s2:1"), titleKey: "schedule.elsewhere" as never });
  assert.equal(unreadCount("alice"), 1);
  notify({ ...source("schedule:s3:1"), actionPath: "//evil.test" });
  const item = listNotifications("alice").items.find((entry) => entry.params.title === "Daily" && entry.actionPath === null);
  assert.ok(item, "an invalid action path is stored as null");
});

test("read state moves only for the owner and dismiss/clear keep the count honest", () => {
  notify(source("schedule:s1:1"));
  const id = listNotifications("alice").items[0]!.id;
  assert.equal(markRead("bob", id), 0);
  assert.equal(listNotifications("alice").items[0]!.readAt, null);
  assert.equal(markRead("alice", id), 0);
  assert.equal(markUnread("alice", id), 1);
  assert.equal(markAllRead("alice"), 0);
  notify(source("schedule:s2:1"));
  assert.equal(clearRead("alice"), 1, "only the unread row survives clearing read notices");
  assert.equal(dismiss("alice", listNotifications("alice").items[0]!.id), 0);
  assert.equal(listNotifications("alice").items.length, 0);
});

test("pages use a stable cursor and never repeat a row", () => {
  for (let index = 0; index < 35; index++) {
    notify({ ...source(`schedule:s${index}:1`), params: { title: `Run ${index}`, thread: "Trip" } });
    db.prepare("UPDATE notifications SET created_at = ? WHERE source_key = ?").run(Date.now() - 120_000 + index * 1000, `schedule:s${index}:1`);
  }
  const first = listNotifications("alice", { limit: 10 });
  assert.equal(first.items.length, 10);
  assert.ok(first.nextCursor);
  const second = listNotifications("alice", { limit: 10, before: first.nextCursor! });
  assert.equal(second.items.length, 10);
  assert.deepEqual(first.items.filter((item) => second.items.some((other) => other.id === item.id)), []);
});

test("retention prunes rows older than 90 days and keeps the newest 200", () => {
  notify(source("schedule:old:1"));
  db.prepare("UPDATE notifications SET created_at = ? WHERE source_key = 'schedule:old:1'").run(Date.now() - 91 * 24 * 60 * 60 * 1000);
  notify(source("schedule:new:1"));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n, 1);
  for (let index = 0; index < 210; index++) notify({ ...source(`schedule:many${index}:1`), params: { title: `M${index}` } });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n, 200);
});

test("the owner routes are private, uncached, and reachable in registration order", async () => {
  notify(source("schedule:s1:1"));
  const listed = await call("/notifications?limit=10");
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cache-control"), "private, no-store");
  const body = (await listed.json()) as { items: Array<{ id: string }>; unread: number; nextCursor: string | null };
  assert.equal(body.unread, 1);
  assert.equal(body.nextCursor, null);

  const readAll = await call("/notifications/read-all", { method: "POST" });
  assert.deepEqual(await readAll.json(), { unread: 0 });
  const cleared = await call("/notifications/read", { method: "DELETE" });
  assert.deepEqual(await cleared.json(), { unread: 0 });
  assert.equal((await call("/notifications")).status, 200);
});
