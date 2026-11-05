import assert from "node:assert/strict";
import { test } from "node:test";
import type { GenerationSummary } from "@shared/generation";
import { continueGate, hasUnresolvedTools, type ContinueGateInput } from "./continue-run";
import { reportStoredMessage } from "@/runtime/message-persistence";

reportStoredMessage("thr_1", "msg_1");

const finished = (over: Partial<GenerationSummary> = {}): GenerationSummary => ({
  runId: "run_1",
  state: "finished",
  finishReason: "length",
  ...over,
});

const base = (over: Partial<ContinueGateInput> = {}): ContinueGateInput => ({
  threadId: "thr_1",
  messageId: "msg_1",
  generation: finished(),
  unresolvedTools: false,
  isLatest: true,
  running: false,
  syncing: false,
  edited: false,
  everEdited: false,
  stored: true,
  hasText: true,
  temporary: false,
  ...over,
});

test("only a trusted finished length receipt on the latest stored leaf is eligible", () => {
  assert.equal(continueGate(base()).eligible, true);
  assert.equal(continueGate(base({ generation: finished({ finishReason: "stop" }) })).eligible, false);
  assert.equal(continueGate(base({ generation: finished({ state: "aborted" }) })).eligible, false);
  assert.equal(continueGate(base({ generation: undefined })).eligible, false);
});

const reason = (gate: ReturnType<typeof continueGate>) => (gate.eligible ? undefined : gate.reason);

test("editing, ever-editing, waiting tools, and a non-latest branch all block continuation", () => {
  assert.equal(reason(continueGate(base({ edited: true }))), "generation.editedTarget");
  assert.equal(reason(continueGate(base({ everEdited: true }))), "generation.editedTarget");
  assert.equal(reason(continueGate(base({ unresolvedTools: true }))), "generation.waitingTools");
  assert.equal(continueGate(base({ isLatest: false })).eligible, false);
  assert.equal(continueGate(base({ hasText: false })).eligible, false);
});

test("running, cached history, and an unacknowledged message explain why the button cannot run", () => {
  assert.equal(continueGate(base({ running: true })).eligible, false);
  assert.equal(reason(continueGate(base({ syncing: true }))), "generation.syncRequired");
  assert.equal(reason(continueGate(base({ stored: false }))), "generation.savingMessage");
  assert.equal(continueGate(base({ threadId: null })).eligible, false);
  assert.equal(continueGate(base({ temporary: true })).eligible, false);
});

test("tool parts still running or waiting for approval count as unresolved", () => {
  assert.equal(hasUnresolvedTools([{ type: "tool-run", status: { type: "running" } }]), true);
  assert.equal(hasUnresolvedTools([{ type: "tool-run", status: { type: "requires-action" } }]), true);
  assert.equal(hasUnresolvedTools([{ type: "tool-run", status: { type: "complete" } }]), false);
  assert.equal(hasUnresolvedTools([{ type: "text" }]), false);
});
