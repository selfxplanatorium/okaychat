import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import {
  MAX_BOOKMARKS_PER_THREAD,
  MAX_FEEDBACK_COMMENT,
  type MessageBookmark,
  type MessageFeedback,
  type ThreadAnnotations,
} from "../shared/message-annotations.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-message-annotations-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "message-annotations-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { sha256, decrypt } = await import("./crypto.js");
const { api } = await import("./routes.js");
const { appendMessage, branchThread } = await import("./threads.js");
const { storageUsed } = await import("./quota.js");
const { markBusy } = await import("./thread-runs.js");

const app = new Hono().route("/api", api);
for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", 1);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
}
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface CallInit {
  method?: string;
  json?: unknown;
  body?: string;
  user?: string;
}
const call = (url: string, init: CallInit = {}) =>
  app.request(`http://app/api${url}`, {
    method: init.method ?? "GET",
    headers: { cookie: `okaychat_session=${init.user ?? "alice"}`, ...(init.json !== undefined || init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
  });

const annotations = (thread = "t1", user = "alice") => call(`/threads/${thread}/annotations`, { user });
const bookmark = ({ thread = "t1", message = "a1", user = "alice" }: { thread?: string; message?: string; user?: string } = {}) =>
  call(`/threads/${thread}/messages/${message}/bookmark`, { method: "PUT", json: {}, user });
const unbookmark = ({ thread = "t1", message = "a1", user = "alice" }: { thread?: string; message?: string; user?: string } = {}) =>
  call(`/threads/${thread}/messages/${message}/bookmark`, { method: "DELETE", user });
const feedback = (
  json: unknown,
  { thread = "t1", message = "a1", user = "alice" }: { thread?: string; message?: string; user?: string } = {},
) => call(`/threads/${thread}/messages/${message}/feedback`, { method: "PUT", json, user });

const body = async (res: Response) => (await res.json()) as { message?: string };
const readAnnotations = async (thread = "t1", user = "alice") => (await (await annotations(thread, user)).json()) as ThreadAnnotations;

const rawFeedback = (message = "a1", thread = "t1") =>
  db
    .prepare("SELECT rating, comment_enc, message_edited_at, revision, created_at, updated_at FROM message_feedback WHERE thread_id = ? AND message_id = ?")
    .get(thread, message) as
    | { rating: string | null; comment_enc: string | null; message_edited_at: number | null; revision: number; created_at: number; updated_at: number }
    | undefined;

const annotate = (thread = "t1", message = "a1") => {
  db.prepare("INSERT INTO message_bookmarks (thread_id, message_id, created_at) VALUES (?, ?, ?)").run(thread, message, 1);
  db.prepare(`INSERT INTO message_feedback (thread_id, message_id, rating, comment_enc, revision, created_at, updated_at)
    VALUES (?, ?, 'positive', NULL, 1, 1, 1)`).run(thread, message);
};

beforeEach(() => {
  db.exec("DELETE FROM message_feedback; DELETE FROM message_bookmarks; DELETE FROM messages; DELETE FROM threads;");
  for (const [id, user] of [["t1", "alice"], ["t9", "bob"]] as const) {
    db.prepare("INSERT INTO threads (id, user_id, created_at, updated_at) VALUES (?, ?, 1000, 1000)").run(id, user);
  }
  const store = (id: string, parent: string | null, role: string, parts: unknown[], user = "alice", thread = "t1", format = "ai-sdk/v6") =>
    appendMessage(user, thread, { id, parent_id: parent, format, content: { role, parts, metadata: { custom: { modelRef: "m/x" } } } });
  store("u1", null, "user", [{ type: "text", text: "Where is Paris?" }]);
  store("a1", "u1", "assistant", [{ type: "text", text: "Paris is in France." }]);
  store("u2", "a1", "user", [{ type: "text", text: "Thanks" }]);
  store("a2", "u2", "assistant", [{ type: "text", text: "Welcome." }]);
  store("s1", null, "system", [{ type: "text", text: "Instructions." }]);
  store("t1msg", null, "tool", [{ type: "text", text: "Tool output." }]);
  store("old1", null, "assistant", [{ type: "text", text: "Legacy." }], "alice", "t1", "legacy/v5");
  store("b1", null, "assistant", [{ type: "text", text: "Bob's." }], "bob", "t9");
});

test("foreign threads, missing threads, and missing messages answer the same 404", async () => {
  // A temporary chat id is never stored, so it answers like an absent thread on every route.
  const temporary = [
    await annotations("tmp_x"),
    await bookmark({ thread: "tmp_x" }),
    await unbookmark({ thread: "tmp_x" }),
    await feedback({ rating: "positive", comment: null, expectedRevision: 0 }, { thread: "tmp_x" }),
  ];
  for (const res of temporary) assert.equal(res.status, 404);

  const foreign = [
    await annotations("t1", "bob"),
    await bookmark({ user: "bob" }),
    await unbookmark({ user: "bob" }),
    await feedback({ rating: "positive", comment: null, expectedRevision: 0 }, { user: "bob" }),
  ];
  for (const res of foreign) assert.equal(res.status, 404);
  // The other direction: alice cannot reach bob's thread or its message either.
  assert.equal((await annotations("t9", "alice")).status, 404);
  assert.equal((await bookmark({ thread: "t9", message: "b1" })).status, 404);
  assert.equal((await feedback({ rating: "positive", comment: null, expectedRevision: 0 }, { thread: "t9", message: "b1" })).status, 404);

  // Foreign, absent thread, and absent message are indistinguishable within each route.
  assert.equal((await body(foreign[0]!)).message, (await body(await annotations("missing"))).message);
  const messageRoutes = [
    {
      foreign: foreign[1]!,
      make: (thread: string, message: string, user: string) => bookmark({ thread, message, user }),
    },
    {
      foreign: foreign[2]!,
      make: (thread: string, message: string, user: string) => unbookmark({ thread, message, user }),
    },
    {
      foreign: foreign[3]!,
      make: (thread: string, message: string, user: string) =>
        feedback({ rating: "positive", comment: null, expectedRevision: 0 }, { thread, message, user }),
    },
  ];
  for (const route of messageRoutes) {
    const foreignMessage = (await body(route.foreign)).message;
    assert.equal((await body(await route.make("t1", "a1", "bob"))).message, foreignMessage, "foreign thread matches");
    assert.equal((await body(await route.make("missing", "a1", "alice"))).message, foreignMessage, "absent thread matches");
    assert.equal((await body(await route.make("t1", "missing", "alice"))).message, foreignMessage, "absent message matches");
  }
  // Nothing was written for the refused requests.
  assert.deepEqual(await readAnnotations(), { bookmarks: [], feedback: [] });
});

test("bookmark PUT and DELETE are idempotent and keep the creation time", async () => {
  for (const message of ["u1", "a1"]) {
    const res = await bookmark({ message });
    assert.equal(res.status, 200, await res.clone().text());
    const first = (await res.json()) as MessageBookmark;
    assert.equal(first.messageId, message);
    assert.equal(typeof first.createdAt, "number");

    const again = (await (await bookmark({ message })).json()) as MessageBookmark;
    assert.deepEqual(again, first, "a repeated PUT keeps the original bookmark");

    const listed = await readAnnotations();
    assert.deepEqual(listed.bookmarks.find((row) => row.messageId === message), first);
  }
  assert.equal((await unbookmark()).status, 200);
  assert.deepEqual((await (await unbookmark()).json()) as unknown, { ok: true }, "DELETE is idempotent");
  assert.deepEqual((await readAnnotations()).bookmarks.map((row) => row.messageId), ["u1"]);
});

test("annotations come back sorted, tombstones included, and only GET decrypts comments", async () => {
  db.prepare("INSERT INTO message_bookmarks (thread_id, message_id, created_at) VALUES ('t1', 'a2', 20), ('t1', 'a1', 10), ('t1', 'u2', 10)").run();
  const cipher = (await (await feedback({ rating: "negative", comment: "Not quite.", expectedRevision: 0 })).json()) as MessageFeedback;
  const res = await annotations();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const listed = (await res.json()) as ThreadAnnotations;
  assert.deepEqual(listed.bookmarks.map((row) => row.messageId), ["a1", "u2", "a2"], "created_at, then message id");
  assert.deepEqual(listed.feedback.map((row) => row.messageId), ["a1"]);
  assert.deepEqual(listed.feedback[0], cipher);
  assert.equal(listed.feedback[0]!.comment, "Not quite.");
  assert.equal("comment_enc" in listed.feedback[0]!, false, "ciphertext never leaves the server");
  // The no-store rule is scoped to annotation paths, not every /api answer.
  assert.notEqual((await call("/threads/t1/messages")).headers.get("cache-control"), "private, no-store");
});

test("bookmark bodies are strict, bounded, and rejected before parsing when oversized", async () => {
  const cases: Array<CallInit> = [
    { method: "PUT", json: { extra: true } },
    { method: "PUT", json: null },
    { method: "PUT", json: [] },
    { method: "PUT", body: "{" },
    { method: "PUT", body: "x".repeat(2048) },
  ];
  for (const init of cases) {
    const res = await call("/threads/t1/messages/a1/bookmark", init);
    assert.equal(res.status, 400, `body ${JSON.stringify(init).slice(0, 80)}`);
  }
  for (const init of [
    { method: "PUT", json: { rating: "positive", comment: null, expectedRevision: 0, extra: 1 } },
    { method: "PUT", json: { rating: "positive", comment: null } },
    { method: "PUT", json: { rating: "meh", comment: null, expectedRevision: 0 } },
    { method: "PUT", json: { rating: "positive", comment: null, expectedRevision: -1 } },
    { method: "PUT", json: { rating: "positive", comment: null, expectedRevision: 1.5 } },
    { method: "PUT", body: "{" },
    { method: "PUT", body: JSON.stringify({ rating: "positive", comment: "x".repeat(20_000), expectedRevision: 0 }) },
  ] as CallInit[]) {
    const res = await call("/threads/t1/messages/a1/feedback", init);
    assert.equal(res.status, 400, `body ${JSON.stringify(init).slice(0, 80)}`);
  }
  assert.deepEqual(await readAnnotations(), { bookmarks: [], feedback: [] });
});

test("only stored user and assistant rows in the supported format can be annotated", async () => {
  const system = await bookmark({ message: "s1" });
  assert.equal(system.status, 400);
  assert.match((await body(system)).message!, /Only finished user or assistant messages/);
  assert.equal((await unbookmark({ message: "t1msg" })).status, 400, "tool roles are not annotatable");
  assert.equal((await bookmark({ message: "old1" })).status, 400, "an unsupported message format is refused");
  assert.equal((await bookmark({ message: "u1" })).status, 200, "user messages can be bookmarked");

  const user = await feedback({ rating: "positive", comment: null, expectedRevision: 0 }, { message: "u1" });
  assert.equal(user.status, 400);
  assert.match((await body(user)).message!, /Feedback is only for assistant replies/);
  assert.equal((await feedback({ rating: "positive", comment: null, expectedRevision: 0 }, { message: "s1" })).status, 400);
  assert.equal((await feedback({ rating: "positive", comment: null, expectedRevision: 0 }, { message: "old1" })).status, 400);
  assert.equal((await feedback({ rating: "positive", comment: null, expectedRevision: 0 })).status, 200);
});

test("a chat holds at most one hundred bookmarks", async () => {
  const insertMessage = db.prepare("INSERT INTO messages (id, thread_id, format, content, created_at) VALUES (?, 't1', 'ai-sdk/v6', ?, ?)");
  const insertBookmark = db.prepare("INSERT INTO message_bookmarks (thread_id, message_id, created_at) VALUES ('t1', ?, ?)");
  // One eligible message beyond the cap, so the refused PUT is a cap conflict and not a missing target.
  for (let i = 0; i <= MAX_BOOKMARKS_PER_THREAD; i++) {
    insertMessage.run(`m${i}`, JSON.stringify({ role: "assistant", parts: [{ type: "text", text: `m${i}` }] }), 2000 + i);
    if (i < MAX_BOOKMARKS_PER_THREAD) insertBookmark.run(`m${i}`, 3000 + i);
  }
  const res = await bookmark({ message: "m100" });
  assert.equal(res.status, 409);
  assert.match((await body(res)).message!, /at most 100 bookmarks/);
  // At the cap an existing mark is still a no-op success, and DELETE still frees a slot.
  assert.equal((await bookmark({ message: "m0" })).status, 200);
  assert.equal((await unbookmark({ message: "m0" })).status, 200);
  assert.equal((await bookmark({ message: "m100" })).status, 200);
});

test("annotations wait for an active run", async () => {
  const release = markBusy("t1");
  for (const res of [
    await bookmark(),
    await unbookmark(),
    await feedback({ rating: "positive", comment: null, expectedRevision: 0 }),
  ]) {
    assert.equal(res.status, 409);
    assert.match((await body(res)).message!, /still being written/);
  }
  release();
  assert.equal((await bookmark()).status, 200);
  assert.equal((await unbookmark()).status, 200);
  assert.equal((await feedback({ rating: "positive", comment: null, expectedRevision: 0 })).status, 200);
});

test("feedback revisions are compare-and-set, and two tabs cannot both win", async () => {
  const first = await feedback({ rating: "positive", comment: "Nice.", expectedRevision: 0 });
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as MessageFeedback).revision, 1);
  assert.equal(rawFeedback()!.revision, 1);

  const stale = await feedback({ rating: "negative", comment: null, expectedRevision: 0 });
  assert.equal(stale.status, 409);
  assert.match((await body(stale)).message!, /changed in another tab/);
  assert.equal(((await (await feedback({ rating: "negative", comment: null, expectedRevision: 1 })).json()) as MessageFeedback).revision, 2);

  // Both tabs read revision 2; one write wins and the other is told to reload.
  const [one, two] = await Promise.all([
    feedback({ rating: "positive", comment: "First.", expectedRevision: 2 }),
    feedback({ rating: "negative", comment: "Second.", expectedRevision: 2 }),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  assert.equal(rawFeedback()!.revision, 3);
});

test("removal keeps a tombstone that still counts as the next revision", async () => {
  await feedback({ rating: "positive", comment: "Good.", expectedRevision: 0 });
  const removed = await feedback({ rating: null, comment: null, expectedRevision: 1 });
  assert.equal(removed.status, 200);
  const parsed = (await removed.json()) as MessageFeedback;
  assert.equal(parsed.rating, null);
  assert.equal(parsed.comment, null);
  assert.equal(parsed.revision, 2);
  assert.equal(parsed.createdAt, rawFeedback()!.created_at);
  const row = rawFeedback()!;
  assert.equal(row.rating, null);
  assert.equal(row.comment_enc, null, "the removed comment's ciphertext is gone");
  assert.equal(row.revision, 2);

  const listed = await readAnnotations();
  assert.deepEqual(listed.feedback.map((item) => ({ rating: item.rating, comment: item.comment, revision: item.revision })), [
    { rating: null, comment: null, revision: 2 },
  ]);
  // Re-rating after a tombstone needs the tombstone's revision.
  assert.equal((await feedback({ rating: "positive", comment: null, expectedRevision: 1 })).status, 409);
  const again = (await (await feedback({ rating: "positive", comment: null, expectedRevision: 2 })).json()) as MessageFeedback;
  assert.equal(again.revision, 3);
  assert.equal(again.createdAt, row.created_at);
});

test("comments are normalized, encrypted at rest, and capped by code points", async () => {
  const comment = "  Keep  this spacing\nand this line.  ";
  const res = await feedback({ rating: "positive", comment, expectedRevision: 0 });
  assert.equal(res.status, 200);
  const cipher = rawFeedback()!.comment_enc!;
  assert.ok(cipher.startsWith("v1."));
  assert.equal(cipher.includes("spacing"), false, "the comment is not readable at rest");
  assert.equal(decrypt(cipher), comment);
  assert.equal(((await res.json()) as MessageFeedback).comment, comment);
  assert.equal((await readAnnotations()).feedback[0]!.comment, comment, "whitespace is preserved");

  const blank = (await (await feedback({ rating: "negative", comment: "   \n\t ", expectedRevision: 1 })).json()) as MessageFeedback;
  assert.equal(blank.comment, null);
  assert.equal(rawFeedback()!.comment_enc, null);

  const unrated = await feedback({ rating: null, comment: "Comment", expectedRevision: 2 });
  assert.equal(unrated.status, 400);
  assert.match((await body(unrated)).message!, /Choose Helpful or Not helpful/);

  const allowed = "😀".repeat(MAX_FEEDBACK_COMMENT);
  const accepted = await feedback({ rating: "positive", comment: allowed, expectedRevision: 2 });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal([...decrypt(rawFeedback()!.comment_enc!)].length, MAX_FEEDBACK_COMMENT);
  const tooLong = await feedback({ rating: "positive", comment: "😀".repeat(MAX_FEEDBACK_COMMENT + 1), expectedRevision: 3 });
  assert.equal(tooLong.status, 400);
  assert.equal(rawFeedback()!.revision, 3, "a refused comment writes nothing");
});

test("feedback records the reply's edit version", async () => {
  assert.equal(((await (await feedback({ rating: "positive", comment: null, expectedRevision: 0 })).json()) as MessageFeedback).messageEditedAt, null);
  db.prepare("UPDATE messages SET edited_at = ? WHERE thread_id = 't1' AND id = 'a1'").run(4242);
  const edited = (await (await feedback({ rating: "negative", comment: null, expectedRevision: 1 })).json()) as MessageFeedback;
  assert.equal(edited.messageEditedAt, 4242);
  assert.equal(rawFeedback()!.message_edited_at, 4242);
});

test("quota charges the ciphertext and always allows removal", async () => {
  const before = storageUsed("alice");
  await feedback({ rating: "positive", comment: "Lovely answer.", expectedRevision: 0 });
  const stored = rawFeedback()!.comment_enc!;
  assert.equal(storageUsed("alice"), before + Buffer.byteLength(stored));

  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(storageUsed("alice") + 10);
  const refused = await feedback({ rating: "positive", comment: "A comment that cannot fit in the remaining bytes.", expectedRevision: 1 });
  assert.equal(refused.status, 413);
  assert.equal(rawFeedback()!.revision, 1, "a refused write changes nothing");
  assert.equal(rawFeedback()!.comment_enc, stored);
  // A tombstone writes no ciphertext, so it works even when the account is over its limit.
  assert.equal((await feedback({ rating: null, comment: null, expectedRevision: 1 })).status, 200);
  assert.equal(storageUsed("alice"), before);
  db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
});

test("annotations are not chat activity and never enter message content or search", async () => {
  const updatedAt = () => (db.prepare("SELECT updated_at FROM threads WHERE id = 't1'").get() as { updated_at: number }).updated_at;
  const content = () => (db.prepare("SELECT content FROM messages WHERE thread_id = 't1' AND id = 'a1'").get() as { content: string }).content;
  const activity = updatedAt();
  const message = content();
  const sentinel = "zzsentinelzz";
  await bookmark();
  await feedback({ rating: "positive", comment: `${sentinel} private note`, expectedRevision: 0 });
  await feedback({ rating: null, comment: null, expectedRevision: 1 });
  await unbookmark();
  assert.equal(updatedAt(), activity, "the sidebar's date groups never move for an annotation");
  assert.equal(content(), message, "message content is untouched");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?").get(sentinel) as { n: number }).n, 0);
});

test("a fork copies neither bookmarks nor feedback and annotates independently", async () => {
  await bookmark();
  await feedback({ rating: "positive", comment: "Source note.", expectedRevision: 0 });
  const fork = branchThread("alice", "t1", "a2", "t2");
  assert.equal(fork.id, "t2");
  assert.deepEqual(await readAnnotations("t2"), { bookmarks: [], feedback: [] }, "forking clones no private decisions");

  // The same message id in the fork is its own row.
  assert.equal((await bookmark({ thread: "t2" })).status, 200);
  const forked = (await (await feedback({ rating: "negative", comment: "Fork note.", expectedRevision: 0 }, { thread: "t2" })).json()) as MessageFeedback;
  assert.equal(forked.revision, 1);
  assert.equal(forked.comment, "Fork note.");
  assert.deepEqual((await readAnnotations("t1")).feedback.map((row) => row.comment), ["Source note."]);
  assert.equal((await unbookmark({ thread: "t2" })).status, 200);
  assert.equal((await readAnnotations("t1")).bookmarks.length, 1, "the source keeps its bookmark");
});

test("deleting a message, a thread, or an account removes both tables", async () => {
  const count = () => ({
    bookmarks: (db.prepare("SELECT COUNT(*) AS n FROM message_bookmarks").get() as { n: number }).n,
    feedback: (db.prepare("SELECT COUNT(*) AS n FROM message_feedback").get() as { n: number }).n,
  });
  await bookmark({ message: "a1" });
  await feedback({ rating: "positive", comment: null, expectedRevision: 0 }, { message: "a1" });
  await bookmark({ message: "a2" });
  db.prepare("DELETE FROM messages WHERE thread_id = 't1' AND id = 'a1'").run();
  assert.deepEqual(count(), { bookmarks: 1, feedback: 0 }, "only the deleted message's rows go");

  // A whole thread takes its annotations with it.
  db.prepare("INSERT INTO message_feedback (thread_id, message_id, rating, revision, created_at, updated_at) VALUES ('t1', 'a2', 'negative', 1, 1, 1)").run();
  db.prepare("DELETE FROM threads WHERE id = 't1'").run();
  assert.deepEqual(count(), { bookmarks: 0, feedback: 0 });

  // An account delete cascades through threads and messages.
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('carol', 'carol@example.test', 'carol', 'unused', 'user', 1)").run();
  db.prepare("INSERT INTO threads (id, user_id, created_at, updated_at) VALUES ('tc', 'carol', 1, 1)").run();
  db.prepare("INSERT INTO messages (id, thread_id, format, content, created_at) VALUES ('mc', 'tc', 'ai-sdk/v6', ?, 1)").run(
    JSON.stringify({ role: "assistant", parts: [{ type: "text", text: "Carol's." }] }),
  );
  annotate("tc", "mc");
  assert.deepEqual(count(), { bookmarks: 1, feedback: 1 });
  db.prepare("DELETE FROM users WHERE id = 'carol'").run();
  assert.deepEqual(count(), { bookmarks: 0, feedback: 0 });
});
