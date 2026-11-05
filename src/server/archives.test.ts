import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { zipSync } from "fflate";
import type { ArchiveAssetEntry, ArchiveManifest } from "../shared/chat-archive.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-archives-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "chat-archives-test-secret-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { sha256, newId } = await import("./crypto.js");
const { api } = await import("./routes.js");
const { storageUsed } = await import("./quota.js");
const { readArchive, writeArchive, assetHash } = await import("./archive-format.js");
const { buildArchive } = await import("./archive-export.js");

const app = new Hono().route("/api", api);
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

type Call = { method?: string; json?: unknown; user?: string; body?: Uint8Array; contentType?: string };
const call = (url: string, init: Call = {}) =>
  app.request(`http://app/api${url}`, {
    method: init.method ?? "GET",
    headers: {
      cookie: `okaychat_session=${init.user ?? "alice"}`,
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.contentType ? { "content-type": init.contentType } : {}),
    },
    body: init.body ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
  });

const json = async <T>(res: Response) => (await res.json()) as T;

const message = (id: string, parent: string | null, role: "user" | "assistant", parts: unknown[], at: number) =>
  JSON.stringify({ role, parts });

beforeEach(() => {
  db.exec("DELETE FROM archive_jobs; DELETE FROM generation_runs; DELETE FROM messages; DELETE FROM threads; DELETE FROM uploads; DELETE FROM artifacts; UPDATE users SET storage_limit = NULL;");
  for (const id of ["alice", "bob"]) {
    db.prepare("INSERT OR IGNORE INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", 1);
    db.prepare("INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
  }
});

function fixtureThread(): { threadId: string; uploadId: string; leaf: string } {
  const threadId = newId("thr");
  const uploadId = newId("upl");
  const bytes = Buffer.from("portable attachment");
  db.prepare("INSERT INTO uploads (id, user_id, name, mime, data, created_at) VALUES (?, 'alice', 'note.txt', 'text/plain', ?, 1)").run(uploadId, bytes);
  db.prepare("INSERT INTO threads (id, user_id, title, status, created_at, updated_at) VALUES (?, 'alice', 'Archive test', 'regular', 100, 200)").run(threadId);
  const insert = db.prepare("INSERT INTO messages (id, thread_id, parent_id, format, content, bytes, created_at) VALUES (?, ?, ?, 'ai-sdk/v6', ?, ?, ?)");
  const root = message("m1", null, "user", [{ type: "text", text: "hello" }], 100);
  insert.run("m1", threadId, null, root, Buffer.byteLength(root), 100);
  const answer = message("m2", "m1", "assistant", [
    { type: "reasoning", text: "thinking" },
    { type: "text", text: "first answer" },
    { type: "file", filename: "note.txt", mediaType: "text/plain", url: `okaychat-upload:${uploadId}` },
    { type: "source-url", sourceId: "s1", url: "https://example.test/page", title: "Example" },
    { type: "tool-run_code", toolCallId: "t1", toolName: "run_code", state: "output-available", input: { code: "print(1)" }, output: { text: "1", files: [] } },
  ], 110);
  insert.run("m2", threadId, "m1", answer, Buffer.byteLength(answer), 110);
  // A sibling branch keeps the alternate leaf available.
  const sibling = message("m3", "m1", "assistant", [{ type: "text", text: "second answer" }], 120);
  insert.run("m3", threadId, "m1", sibling, Buffer.byteLength(sibling), 120);
  db.prepare("INSERT INTO artifacts (thread_id, id, version, title, kind, language, content, data, size, created_at) VALUES (?, 'art_1', 1, 'Page', 'html', NULL, '<h1>One</h1>', NULL, 0, 130)").run(threadId);
  db.prepare("INSERT INTO artifacts (thread_id, id, version, title, kind, language, content, data, size, created_at) VALUES (?, 'art_1', 2, 'Page', 'html', NULL, '<h1>Two</h1>', NULL, 0, 140)").run(threadId);
  // Point a tool result at the artifact so versions travel.
  const withArtifact = message("m4", "m2", "assistant", [{ type: "tool-create_artifact", toolCallId: "t2", toolName: "create_artifact", state: "output-available", input: { title: "Page" }, output: { id: "art_1", version: 2, title: "Page", kind: "html", size: 0 } }], 150);
  insert.run("m4", threadId, "m2", withArtifact, Buffer.byteLength(withArtifact), 150);
  return { threadId, uploadId, leaf: "m3" };
}

async function exportArchive(user = "alice", threadId: string, selectedLeaf?: string): Promise<{ jobId: string; zip: Uint8Array }> {
  const created = await call("/chat-archives/exports", { method: "POST", user, json: { threads: [{ id: threadId, ...(selectedLeaf ? { selectedLeaf } : {}) }] } });
  assert.equal(created.status, 202, await created.clone().text());
  const { jobId } = await json<{ jobId: string }>(created);
  const job = await json<{ state: string; summary: { chats: Array<{ key: string; messages: number; branches: number; assets: number }> } }>(await call(`/chat-archives/${jobId}`, { user }));
  assert.equal(job.state, "ready");
  assert.equal(job.summary.chats[0]?.messages, 4);
  assert.equal(job.summary.chats[0]?.branches, 2);
  const download = await call(`/chat-archives/${jobId}/download`, { user });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition") ?? "", /okaychat-chats-.*\.okaychat\.zip/);
  assert.equal(download.headers.get("cache-control"), "private, no-store");
  return { jobId, zip: new Uint8Array(await download.arrayBuffer()) };
}

test("round trip preserves branches, text, reasoning, source, files, and artifact versions", async () => {
  const { threadId, leaf } = fixtureThread();
  const exported = await exportArchive("alice", threadId, leaf);
  const read = readArchive(exported.zip);
  assert.equal(read.manifest.chats.length, 1);
  const chat = read.manifest.chats[0]!;
  assert.equal(chat.selectedLeaf, "m3");
  assert.equal(chat.messages.length, 4);
  assert.deepEqual(chat.artifacts.map((artifact) => artifact.version), [1, 2]);
  assert.equal(chat.messages.find((message) => message.key === "m2")?.generation, undefined);

  const imported = await call("/chat-archives/imports", { method: "POST", user: "bob", body: exported.zip, contentType: "application/zip" });
  assert.equal(imported.status, 202);
  const { jobId } = await json<{ jobId: string }>(imported);
  const preview = await json<{ state: string; summary: { chats: Array<{ key: string; warnings: unknown[] }> } }>(await call(`/chat-archives/${jobId}`, { user: "bob" }));
  assert.equal(preview.state, "ready");
  const confirmed = await call(`/chat-archives/${jobId}/confirm`, { method: "POST", user: "bob", json: { chatKeys: [chat.key] } });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  const result = await json<{ threads: Array<{ archiveKey: string; id: string }> }>(confirmed);
  assert.equal(result.threads.length, 1);
  const importedThread = result.threads[0]!;
  assert.notEqual(importedThread.id, threadId);

  const stored = db.prepare("SELECT * FROM threads WHERE id = ? AND user_id = 'bob'").get(importedThread.id) as Record<string, unknown>;
  assert.equal(stored.title, "Archive test");
  assert.equal(stored.memory_disabled, 1);
  assert.equal(stored.preferred_head !== null, true);
  const messages = db.prepare("SELECT id, parent_id, content, imported FROM messages WHERE thread_id = ? ORDER BY created_at").all(importedThread.id) as Array<{ id: string; parent_id: string | null; content: string; imported: number }>;
  assert.equal(messages.length, 4);
  assert.ok(messages.every((row) => row.imported === 1));
  const ids = new Set(messages.map((row) => row.id));
  assert.ok(messages.every((row) => row.parent_id === null || ids.has(row.parent_id)));
  const parsed = JSON.parse(messages.find((row) => JSON.parse(row.content).role === "assistant")!.content) as { parts: Array<{ type: string; url?: string }> };
  assert.ok(parsed.parts.some((part) => part.type === "file" && part.url?.startsWith("okaychat-upload:")));
  const versions = db.prepare("SELECT version, content FROM artifacts WHERE thread_id = ? AND id IN (SELECT id FROM artifacts WHERE thread_id = ?) ORDER BY version").all(importedThread.id, importedThread.id) as Array<{ version: number; content: string }>;
  assert.deepEqual(versions.map((row) => row.version), [1, 2]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE user_id = 'bob'").get().n, 1);
  // A confirmation is idempotent for the same keys.
  const again = await call(`/chat-archives/${jobId}/confirm`, { method: "POST", user: "bob", json: { chatKeys: [chat.key] } });
  assert.equal(again.status, 200);
  assert.deepEqual(await json(again), result);
  // A different selection after completion conflicts rather than importing twice.
  const other = await call(`/chat-archives/${jobId}/confirm`, { method: "POST", user: "bob", json: { chatKeys: ["other"] } });
  assert.equal(other.status, 409);
});

test("a foreign account cannot read, download, confirm, or cancel a job", async () => {
  const { threadId } = fixtureThread();
  const exported = await exportArchive("alice", threadId);
  assert.equal((await call(`/chat-archives/${exported.jobId}`, { user: "bob" })).status, 404);
  assert.equal((await call(`/chat-archives/${exported.jobId}/download`, { user: "bob" })).status, 404);
  assert.equal((await call(`/chat-archives/${exported.jobId}/confirm`, { method: "POST", user: "bob", json: { chatKeys: ["x"] } })).status, 404);
  assert.equal((await call(`/chat-archives/${exported.jobId}`, { method: "DELETE", user: "bob" })).status, 404);
});

test("malformed archives fail the job instead of importing anything", async () => {
  const cases: Array<Uint8Array> = [
    // Not a ZIP at all.
    new TextEncoder().encode("not a zip"),
    // A manifest with an unsupported version.
    zipSync({ "manifest.json": new TextEncoder().encode(JSON.stringify({ format: "okaychat.chat-archive", version: 99, exportedAt: 1, chats: [], assets: [] })) }, { level: 0 }),
    // A traversal entry name.
    zipSync({ "../evil": new Uint8Array([1]), "manifest.json": new TextEncoder().encode("{}") }, { level: 0 }),
  ];
  for (const bytes of cases) {
    const res = await call("/chat-archives/imports", { method: "POST", user: "bob", body: bytes, contentType: "application/zip" });
    assert.equal(res.status, 202);
    const { jobId } = await json<{ jobId: string }>(res);
    const job = await json<{ state: string; error?: { code: string } }>(await call(`/chat-archives/${jobId}`, { user: "bob" }));
    assert.equal(job.state, "failed");
    assert.equal(job.error?.code, "invalid_archive");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM threads WHERE user_id = 'bob'").get().n, 0);
    // Failed jobs release the account for another attempt.
    await call(`/chat-archives/${jobId}`, { method: "DELETE", user: "bob" });
  }
});

test("manifest validation rejects document-invalid graphs and assets", async () => {
  const base = (over: Partial<ArchiveManifest> = {}) => ({
    format: "okaychat.chat-archive" as const,
    version: 1 as const,
    exportedAt: 1000,
    chats: [
      {
        key: "chat_1",
        title: "Chat",
        createdAt: 1,
        updatedAt: 2,
        status: "regular" as const,
        modelRef: null,
        selectedLeaf: "m1",
        messages: [{ key: "m1", parentKey: null, createdAt: 1, role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }],
        artifacts: [],
        assistant: null,
      },
    ],
    assets: [] as ArchiveAssetEntry[],
    ...over,
  });
  assert.equal(readArchive(writeArchive(base(), new Map())).manifest.chats.length, 1);
  const dangling = base();
  dangling.chats[0]!.messages.push({ key: "m2", parentKey: "missing", createdAt: 2, role: "assistant", parts: [{ type: "text", text: "x" }] });
  assert.throws(() => readArchive(writeArchive(dangling, new Map())), /missing parent/);
  const duplicate = base();
  duplicate.chats[0]!.messages.push({ key: "m1", parentKey: null, createdAt: 2, role: "assistant", parts: [{ type: "text", text: "x" }] });
  assert.throws(() => readArchive(writeArchive(duplicate, new Map())), /Duplicate message/);
  const missingAsset = base();
  const bytes = new Uint8Array([1, 2, 3]);
  missingAsset.chats[0]!.messages.push({ key: "m2", parentKey: "m1", createdAt: 2, role: "assistant", parts: [{ type: "file", asset: "a".repeat(64), name: "x", mime: "text/plain", missing: false }] });
  assert.throws(() => readArchive(writeArchive(missingAsset, new Map())), /missing asset/);
  const wrongHash = base();
  wrongHash.assets = [{ key: assetHash(bytes), size: 3, mime: "text/plain", name: "note" }];
  wrongHash.chats[0]!.messages.push({ key: "m2", parentKey: "m1", createdAt: 2, role: "assistant", parts: [{ type: "file", asset: assetHash(bytes), name: "note", mime: "text/plain", missing: false }] });
  assert.throws(() => readArchive(writeArchive(wrongHash, new Map([[assetHash(bytes), new Uint8Array([9, 9, 9])]]))), /hash/);
});

test("quota failure leaves no partial chats and keeps the job retryable", async () => {
  const { threadId } = fixtureThread();
  const exported = await exportArchive("alice", threadId);
  const read = readArchive(exported.zip);
  const imported = await call("/chat-archives/imports", { method: "POST", user: "bob", body: exported.zip, contentType: "application/zip" });
  const { jobId } = await json<{ jobId: string }>(imported);
  const before = db.prepare("SELECT COUNT(*) AS n FROM threads WHERE user_id = 'bob'").get().n;
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'bob'").run(storageUsed("bob") + 10);
  const failed = await call(`/chat-archives/${jobId}/confirm`, { method: "POST", user: "bob", json: { chatKeys: [read.manifest.chats[0]!.key] } });
  assert.equal(failed.status, 413);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM threads WHERE user_id = 'bob'").get().n, before);
  const job = await json<{ state: string }>(await call(`/chat-archives/${jobId}`, { user: "bob" }));
  assert.equal(job.state, "ready");
});

test("the export refuses a busy chat and an empty selection", async () => {
  const { threadId } = fixtureThread();
  const { markBusy } = await import("./thread-runs.js");
  const release = markBusy(threadId);
  assert.equal((await call("/chat-archives/exports", { method: "POST", json: { threads: [{ id: threadId }] } })).status, 409);
  release();
  assert.equal((await call("/chat-archives/exports", { method: "POST", json: { threads: [] } })).status, 400);
});

test("buildArchive writes a manifest that readArchive accepts unchanged", () => {
  const { threadId, leaf } = fixtureThread();
  const built = buildArchive({ userId: "alice", threads: [{ id: threadId, selectedLeaf: leaf }] });
  const parsed = readArchive(writeArchive(built.manifest, built.assets));
  assert.equal(parsed.manifest.chats[0]!.selectedLeaf, leaf);
  assert.deepEqual([...parsed.assets.keys()].sort(), [...built.assets.keys()].sort());
});
