import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { CalendarEvent, CalendarPage } from "../shared/calendar.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-calendar-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "calendar-test-secret-only-not-for-production";
process.env.OKAYCHAT_STORAGE_LIMIT = "10000000";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));

const { db } = await import("./db.js");
const { sha256 } = await import("./crypto.js");
const { api } = await import("./routes.js");
const { ensureThread } = await import("./threads.js");
const { createEvent, updateEvent, deleteEvent } = await import("./calendar/store.js");
const { runDueReminders, resetReminderTickForTest } = await import("./calendar/reminders.js");
const { listNotifications } = await import("./notifications.js");
const { storageUsed } = await import("./quota.js");

const app = new Hono().route("/api", api);
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const UUID3 = "33333333-3333-4333-8333-333333333333";
const MINUTE = 60_000;
const now = Math.floor(Date.now() / MINUTE) * MINUTE;

const call = (url: string, init: { method?: string; json?: unknown; user?: string } = {}) =>
  app.request(`http://app/api${url}`, {
    method: init.method ?? "GET",
    headers: { cookie: `okaychat_session=${init.user ?? "alice"}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
const json = async <T>(res: Response) => (await res.json()) as T;

const timed = (over: Partial<Record<string, unknown>> = {}) => ({
  allDay: false,
  timeZone: "UTC",
  startAt: now + 10 * MINUTE,
  endAt: now + 70 * MINUTE,
  startDate: null,
  endDate: null,
  title: "Meeting",
  description: "Agenda",
  location: "Room",
  url: "",
  reminderOffsets: [0],
  threadId: null,
  projectId: null,
  ...over,
});

const allDay = (over: Partial<Record<string, unknown>> = {}) => ({
  allDay: true,
  timeZone: "Europe/Rome",
  startAt: null,
  endAt: null,
  startDate: "2026-03-29",
  endDate: "2026-03-30",
  title: "Holiday",
  description: "",
  location: "",
  url: "",
  reminderOffsets: [],
  threadId: null,
  projectId: null,
  ...over,
});

beforeEach(() => {
  resetReminderTickForTest();
  db.exec("DELETE FROM notifications; DELETE FROM calendar_events; DELETE FROM permission_policies; DELETE FROM projects; DELETE FROM threads; UPDATE users SET storage_limit = NULL");
  for (const id of ["alice", "bob"]) {
    db.prepare("INSERT OR IGNORE INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", 1);
    db.prepare("INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
  }
  db.prepare("INSERT INTO projects (id, user_id, name, instructions, created_at) VALUES ('p1', 'alice', 'Project', '', 1)").run();
  ensureThread("alice", "t1", "p1");
  db.prepare("INSERT INTO threads (id, user_id, created_at, updated_at) VALUES ('t2', 'alice', 1, 1)").run();
});

test("timed and all-day events derive effective bounds and admit reminders", async () => {
  const res = await call("/calendar/events", { method: "POST", json: { ...timed(), requestId: UUID } });
  assert.equal(res.status, 201, await res.clone().text());
  const { event } = await json<{ event: CalendarEvent }>(res);
  assert.equal(event.effectiveStartAt, now + 10 * MINUTE);
  assert.equal(event.effectiveEndAt, now + 70 * MINUTE);
  assert.equal(event.reminderRevision, 1);
  const ledger = db.prepare("SELECT offset_minutes, due_at, state FROM calendar_reminders WHERE event_id = ?").all(event.id) as Array<{ offset_minutes: number; due_at: number; state: string }>;
  assert.deepEqual(ledger.map((row) => ({ ...row })), [{ offset_minutes: 0, due_at: now + 10 * MINUTE, state: "pending" }]);

  const holiday = await json<{ event: CalendarEvent }>(await call("/calendar/events", { method: "POST", json: { ...allDay(), requestId: UUID2 } }));
  assert.equal(new Date(holiday.event.effectiveStartAt).toISOString(), "2026-03-28T23:00:00.000Z");
  assert.equal(new Date(holiday.event.effectiveEndAt).toISOString(), "2026-03-29T22:00:00.000Z");
});

test("a no-op update keeps the ledger; a schedule change rebuilds it and removes old notices", async () => {
  const { event } = await json<{ event: CalendarEvent }>(await call("/calendar/events", { method: "POST", json: { ...timed(), requestId: UUID } }));
  const noop = await json<{ event: CalendarEvent }>(await call(`/calendar/events/${event.id}`, { method: "PUT", json: { ...timed(), revision: event.revision } }));
  assert.equal(noop.event.revision, event.revision);
  assert.equal(noop.event.reminderRevision, 1);

  const titleOnly = await json<{ event: CalendarEvent }>(await call(`/calendar/events/${event.id}`, { method: "PUT", json: { ...timed({ title: "Renamed" }), revision: event.revision } }));
  assert.equal(titleOnly.event.reminderRevision, 1);

  // A delivered notice exists before the schedule changes.
  runDueReminders(now + 10 * MINUTE);
  assert.equal((db.prepare("SELECT count(*) AS n FROM notifications WHERE calendar_event_id = ?").get(event.id) as { n: number }).n, 1);
  const moved = await json<{ event: CalendarEvent }>(await call(`/calendar/events/${event.id}`, { method: "PUT", json: { ...timed({ startAt: now + 30 * MINUTE, endAt: now + 90 * MINUTE }), revision: titleOnly.event.revision } }));
  assert.equal(moved.event.reminderRevision, 2);
  assert.equal((db.prepare("SELECT count(*) AS n FROM notifications WHERE calendar_event_id = ?").get(event.id) as { n: number }).n, 0);
  const ledger = db.prepare("SELECT reminder_revision, due_at, state FROM calendar_reminders WHERE event_id = ?").all(event.id) as Array<{ reminder_revision: number; due_at: number; state: string }>;
  assert.deepEqual(ledger.map((row) => ({ ...row })), [{ reminder_revision: 2, due_at: now + 30 * MINUTE, state: "pending" }]);
});

test("reminder delivery is once, durable after dismissal, and suppresses past or ended events", async () => {
  const { event } = await json<{ event: CalendarEvent }>(await call("/calendar/events", { method: "POST", json: { ...timed(), requestId: UUID } }));
  assert.deepEqual(runDueReminders(now), { delivered: 0, suppressed: 0, skipped: false });
  const delivered = runDueReminders(now + 10 * MINUTE);
  assert.equal(delivered.delivered, 1);
  assert.equal(runDueReminders(now + 11 * MINUTE).delivered, 0);
  const notices = listNotifications("alice");
  assert.equal(notices.items.length, 1);
  assert.equal(notices.items[0]!.kind, "calendar");
  assert.equal(notices.items[0]!.titleKey, "calendar.reminder");
  assert.equal(notices.items[0]!.calendarEventId, event.id);
  assert.deepEqual(notices.items[0]!.params, {});
  assert.equal(notices.items[0]!.actionPath, `/calendar?event=${encodeURIComponent(event.id)}`);

  db.prepare("DELETE FROM notifications WHERE calendar_event_id = ?").run(event.id);
  assert.equal(runDueReminders(now + 12 * MINUTE).delivered, 0);

  const past = createEvent("alice", UUID2, timed({ title: "Past", startAt: now - 60 * MINUTE, endAt: now + 60 * MINUTE }));
  assert.equal((db.prepare("SELECT state FROM calendar_reminders WHERE event_id = ?").get(past.event.id) as { state: string }).state, "suppressed");
  const ended = createEvent("alice", UUID3, timed({ title: "Ended", startAt: now - 120 * MINUTE, endAt: now - 60 * MINUTE }));
  assert.equal((db.prepare("SELECT state FROM calendar_reminders WHERE event_id = ?").get(ended.event.id) as { state: string }).state, "suppressed");
});

test("a missed reminder inside seven days arrives late once; older or feature-denied ones suppress", async () => {
  const { event } = await json<{ event: CalendarEvent }>(await call("/calendar/events", { method: "POST", json: { ...timed({ startAt: now + 60 * MINUTE, endAt: now + 120 * MINUTE }), requestId: UUID } }));
  db.prepare("UPDATE calendar_reminders SET due_at = ? WHERE event_id = ?").run(now - 2 * 24 * 60 * MINUTE, event.id);
  assert.equal(runDueReminders(now).delivered, 1);

  const { event: old } = await json<{ event: CalendarEvent }>(await call("/calendar/events", { method: "POST", json: { ...timed({ title: "Old", startAt: now + 60 * MINUTE, endAt: now + 120 * MINUTE }), requestId: UUID2 } }));
  db.prepare("UPDATE calendar_reminders SET due_at = ? WHERE event_id = ?").run(now - 8 * 24 * 60 * MINUTE, old.id);
  assert.equal(runDueReminders(now).suppressed, 1);

  const { event: denied } = await json<{ event: CalendarEvent }>(await call("/calendar/events", { method: "POST", json: { ...timed({ title: "Denied", startAt: now + 60 * MINUTE, endAt: now + 120 * MINUTE }), requestId: UUID3 } }));
  db.prepare("UPDATE calendar_reminders SET due_at = ? WHERE event_id = ?").run(now - 60 * MINUTE, denied.id);
  db.prepare("INSERT INTO permission_policies (subject_kind, subject_id, model_ref, document, updated_at) VALUES ('everyone', '', '', ?, 1)").run(JSON.stringify({ version: 1, features: { calendar: false } }));
  assert.equal(runDueReminders(now).suppressed, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM notifications WHERE calendar_event_id = ?").get(denied.id) as { n: number }).n, 0);
});

test("range overlap, search, project and thread filters stay account-scoped", async () => {
  await call("/calendar/events", { method: "POST", json: { ...timed({ title: "Alpha", projectId: "p1", threadId: "t1" }), requestId: UUID } });
  await call("/calendar/events", { method: "POST", json: { ...timed({ title: "Beta", startAt: now + 200 * MINUTE, endAt: now + 260 * MINUTE }), requestId: UUID2 } });
  const page = await json<CalendarPage>(await call(`/calendar/events?from=${now}&to=${now + 90 * MINUTE}&limit=50`));
  assert.deepEqual(page.items.map((item) => item.title), ["Alpha"]);
  const search = await json<CalendarPage>(await call(`/calendar/events?from=${now}&to=${now + 500 * MINUTE}&limit=50&q=beta`));
  assert.deepEqual(search.items.map((item) => item.title), ["Beta"]);
  const project = await json<CalendarPage>(await call(`/calendar/events?from=${now}&to=${now + 500 * MINUTE}&limit=50&projectId=p1`));
  assert.deepEqual(project.items.map((item) => item.title), ["Alpha"]);
  assert.equal((await call(`/calendar/events?from=${now}&to=${now + 90 * MINUTE}&limit=50`, { user: "bob" })).status, 200);
  assert.equal((await json<CalendarPage>(await call(`/calendar/events?from=${now}&to=${now + 90 * MINUTE}&limit=50`, { user: "bob" }))).items.length, 0);
});

test("links are owned, null on deletion without a revision bump, and foreign writes are invisible", async () => {
  const { event } = await json<{ event: CalendarEvent }>(await call("/calendar/events", { method: "POST", json: { ...timed({ threadId: "t1", projectId: "p1" }), requestId: UUID } }));
  db.prepare("DELETE FROM threads WHERE id = 't1'").run();
  const after = await json<{ event: CalendarEvent }>(await call(`/calendar/events/${event.id}`));
  assert.equal(after.event.threadId, null);
  assert.equal(after.event.revision, event.revision);
  assert.equal((await call(`/calendar/events/${event.id}`, { user: "bob" })).status, 404);
  assert.equal((await call("/calendar/events", { method: "POST", json: { ...timed({ threadId: "missing" }), requestId: UUID2 } })).status, 404);
});

test("delete cascades reminders and notices, and quota counts only event text", async () => {
  const before = storageUsed("alice");
  const { event } = await json<{ event: CalendarEvent }>(await call("/calendar/events", { method: "POST", json: { ...timed(), requestId: UUID } }));
  assert.equal(storageUsed("alice") - before, Buffer.byteLength("Meeting") + Buffer.byteLength("Agenda") + Buffer.byteLength("Room"));
  runDueReminders(now + 10 * MINUTE);
  assert.equal((db.prepare("SELECT count(*) AS n FROM notifications").get() as { n: number }).n, 1);
  deleteEvent("alice", event.id, event.revision);
  assert.equal((db.prepare("SELECT count(*) AS n FROM calendar_reminders").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM notifications").get() as { n: number }).n, 0);
  assert.equal(storageUsed("alice"), before);
});

test("strict validation rejects gaps, invalid zones, bad URLs, and unknown fields", async () => {
  const gap = await call("/calendar/events", { method: "POST", json: { ...timed({ allDay: true, timeZone: "Europe/Rome", startAt: null, endAt: null, startDate: "2026-03-29", endDate: "2026-03-30" }), requestId: UUID } });
  assert.equal(gap.status, 201);
  const skipped = await call("/calendar/events", { method: "POST", json: { ...allDay({ startDate: "2011-12-30", endDate: "2011-12-31", timeZone: "Pacific/Apia" }), requestId: UUID2 } });
  assert.equal(skipped.status, 400);
  assert.equal((await call("/calendar/events", { method: "POST", json: { ...timed({ timeZone: "+02:00" }), requestId: UUID2 } })).status, 400);
  assert.equal((await call("/calendar/events", { method: "POST", json: { ...timed({ url: "https://user:pass@example.test/x" }), requestId: UUID2 } })).status, 400);
  assert.equal((await call("/calendar/events", { method: "POST", json: { ...timed(), requestId: UUID2, extra: true } })).status, 400);
  assert.equal((await call("/calendar/events", { method: "POST", json: { ...timed({ reminderOffsets: [1, 1] }), requestId: UUID2 } })).status, 400);
});

test("resolve-time is authoritative for gaps and folds and is rate capped", async () => {
  const gap = await json<{ startCandidates: unknown[]; endCandidates: unknown[] }>(await call("/calendar/resolve-time", { method: "POST", json: { timeZone: "Europe/Rome", startLocal: "2026-03-29T02:30", endLocal: "2026-03-29T03:30" } }));
  assert.deepEqual(gap.startCandidates, []);
  const fold = await json<{ startCandidates: Array<{ offsetMinutes: number }> }>(await call("/calendar/resolve-time", { method: "POST", json: { timeZone: "Europe/Rome", startLocal: "2026-10-25T02:30", endLocal: "2026-10-25T03:30" } }));
  assert.deepEqual(fold.startCandidates.map((candidate) => candidate.offsetMinutes), [120, 60]);
  let limited = 0;
  for (let index = 0; index < 30; index++) {
    const response = await call("/calendar/resolve-time", { method: "POST", json: { timeZone: "UTC", startLocal: "2026-01-01T10:00", endLocal: "2026-01-01T11:00" } });
    if (response.status === 429) limited++;
  }
  assert.ok(limited > 0);
});
