import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { CONTINUE_TEXT } from "../shared/generation.js";
import type { UIMessage } from "ai";
import type { ResolvedRunConfig } from "../shared/assistant-presets.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-generation-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "generation-runs-test-secret-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { storageUsed } = await import("./quota.js");
const {
  beginRun,
  cancelWaitingRun,
  endRun,
  generationBusy,
  projectGenerationMetadata,
  recordSegmentOnce,
  resolveRunForToolResult,
} = await import("./generation-runs.js");
const { assertContinuation } = await import("./continuation.js");

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const config = (over: Partial<ResolvedRunConfig> = {}): ResolvedRunConfig => ({
  version: 1,
  requestKind: "send",
  modelRef: "mock/model",
  sampling: {},
  instructions: "Be brief.",
  toolPolicy: { mode: "inherit", builtins: [], mcpTools: [] },
  knowledgeIds: [],
  assistantName: "Writer",
  assistantIcon: "pen-line",
  assistantRevision: 1,
  webSearch: true,
  deepResearch: false,
  ...over,
});

const usage = (over: Partial<{ input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }> = {}) => ({
  input: 10,
  output: 5,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...over,
});

beforeEach(() => {
  db.exec("DELETE FROM generation_runs; DELETE FROM generation_segments; DELETE FROM messages; DELETE FROM threads; DELETE FROM assistant_presets; UPDATE users SET storage_limit = NULL;");
  db.prepare("INSERT OR IGNORE INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'unused', 'user', 1)").run();
  db.prepare("INSERT INTO threads (id, user_id, created_at, updated_at) VALUES ('thr_1', 'alice', 1, 1)").run();
});

test("a receipt reserves quota before upstream and is created running", () => {
  const before = storageUsed("alice");
  const run = beginRun({ userId: "alice", threadId: "thr_1", userMessageId: "m1", assistantMessageId: "a1", config: config() });
  assert.match(run.id, /^run_/);
  assert.equal(run.state, "running");
  assert.equal(storageUsed("alice") - before, 64 * 1024 + Buffer.byteLength(JSON.stringify(config())));
  assert.equal(generationBusy("thr_1"), true);
});

test("quota refusal happens before any receipt or provider request", () => {
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(storageUsed("alice") + 1024);
  assert.throws(() => beginRun({ userId: "alice", threadId: "thr_1", userMessageId: "m1", assistantMessageId: "a1", config: config() }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM generation_runs").get().n, 0);
});

test("segments are recorded exactly once and aggregate to the receipt", () => {
  const run = beginRun({ userId: "alice", threadId: "thr_1", userMessageId: "m1", assistantMessageId: "a1", config: config() });
  const first = recordSegmentOnce(run.id, "seg_1", { usage: usage(), cost: 0.01, contextTokens: 15 });
  assert.equal(first.usage.input, 10);
  const duplicate = recordSegmentOnce(run.id, "seg_1", { usage: usage(), cost: 0.01, contextTokens: 15 });
  assert.equal(duplicate.usage.input, 10);
  const second = recordSegmentOnce(run.id, "seg_2", { usage: usage({ input: 3, output: 2 }), cost: 0.005 });
  assert.equal(second.usage.input, 13);
  assert.equal(second.usage.output, 7);
  assert.ok(Math.abs(second.cost - 0.015) < 1e-9);
  assert.equal(second.contextTokens, 15);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM generation_segments WHERE run_id = ?").get(run.id).n, 2);
});

test("terminal states are immutable: an abort after length can never make a reply continuable again", () => {
  const run = beginRun({ userId: "alice", threadId: "thr_1", userMessageId: "m1", assistantMessageId: "a1", config: config() });
  assert.equal(endRun(run.id, { state: "finished", finishReason: "length", durationMs: 50 }), "finished");
  assert.equal(endRun(run.id, { state: "aborted", finishReason: null, durationMs: 60 }), "finished");
  const summary = projectGenerationMetadata("thr_1", "a1");
  assert.equal(summary?.state, "finished");
  assert.equal(summary?.finishReason, "length");
  assert.equal(summary?.assistantName, "Writer");
  assert.equal("instructions" in (summary ?? {}), false);
});

test("a waiting receipt can be cancelled and releases the logical busy lock", () => {
  const run = beginRun({ userId: "alice", threadId: "thr_1", userMessageId: "m1", assistantMessageId: "a1", config: config() });
  endRun(run.id, { state: "waiting", finishReason: "tool-calls", durationMs: 10 });
  assert.equal(resolveRunForToolResult("thr_1", "a1")?.id, run.id);
  assert.equal(generationBusy("thr_1"), true);
  assert.equal(cancelWaitingRun("alice", "thr_1", run.id).state, "aborted");
  assert.equal(generationBusy("thr_1"), false);
  assert.equal(resolveRunForToolResult("thr_1", "a1"), undefined);
});

test("cancelling a finished receipt changes nothing", () => {
  const run = beginRun({ userId: "alice", threadId: "thr_1", userMessageId: "m1", assistantMessageId: "a1", config: config() });
  endRun(run.id, { state: "finished", finishReason: "stop", durationMs: 10 });
  assert.equal(cancelWaitingRun("alice", "thr_1", run.id).state, "finished");
});

test("continuation admission accepts only the fixed visible text on a length-limited leaf", () => {
  const run = beginRun({ userId: "alice", threadId: "thr_1", userMessageId: "u1", assistantMessageId: "a1", config: config() });
  endRun(run.id, { state: "finished", finishReason: "length", durationMs: 10 });
  const message = (id: string, role: "user" | "assistant", text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
  db.prepare("INSERT INTO messages (id, thread_id, parent_id, format, content, bytes, created_at) VALUES ('u1', 'thr_1', NULL, 'ai-sdk/v6', ?, 1, 1)").run(JSON.stringify(message("u1", "user", "First")));
  db.prepare("INSERT INTO messages (id, thread_id, parent_id, format, content, bytes, created_at) VALUES ('a1', 'thr_1', 'u1', 'ai-sdk/v6', ?, 1, 2)").run(JSON.stringify(message("a1", "assistant", "A long answer")));

  const request = message("u2", "user", CONTINUE_TEXT);
  assert.doesNotThrow(() => assertContinuation("alice", "thr_1", { targetMessageId: "a1", requestMessageId: "u2" }, [message("u1", "user", "First"), message("a1", "assistant", "A long answer"), request]));
  assert.throws(
    () => assertContinuation("alice", "thr_1", { targetMessageId: "a1", requestMessageId: "u2" }, [message("u1", "user", "First"), message("a1", "assistant", "A long answer"), message("u2", "user", "Keep going")]),
    /continuation message changed/i,
  );
  // Once a real continuation child exists, the same click is stale.
  db.prepare("INSERT INTO messages (id, thread_id, parent_id, format, content, bytes, created_at) VALUES ('u9', 'thr_1', 'a1', 'ai-sdk/v6', ?, 1, 3)").run(JSON.stringify(message("u9", "user", CONTINUE_TEXT)));
  assert.throws(
    () => assertContinuation("alice", "thr_1", { targetMessageId: "a1", requestMessageId: "u2" }, [message("u1", "user", "First"), message("a1", "assistant", "A long answer"), request]),
    /already continued/i,
  );
});

test("an edited target or a non-length receipt is refused", () => {
  const run = beginRun({ userId: "alice", threadId: "thr_1", userMessageId: "u1", assistantMessageId: "a1", config: config() });
  endRun(run.id, { state: "finished", finishReason: "stop", durationMs: 10 });
  const message = (id: string, role: "user" | "assistant", text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
  db.prepare("INSERT INTO messages (id, thread_id, parent_id, format, content, bytes, created_at, edited_at) VALUES ('a1', 'thr_1', NULL, 'ai-sdk/v6', ?, 1, 2, 5)").run(JSON.stringify(message("a1", "assistant", "Answer")));
  assert.throws(
    () => assertContinuation("alice", "thr_1", { targetMessageId: "a1", requestMessageId: "u2" }, [message("u2", "user", CONTINUE_TEXT)]),
    /edited/i,
  );
});
