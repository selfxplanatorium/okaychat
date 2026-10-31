import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmailAccount } from "@shared/email";
import type { EmailDraft, EmailDraftFields } from "@shared/email-draft";
import {
  DRAFT_AUTOSAVE_MS,
  DraftAutosave,
  deriveDraftCardState,
  draftOutboxKey,
  draftWordCount,
  readOutbox,
  writeOutbox,
  type DraftOutboxStorage,
} from "./email-draft-state.js";

// The autosave rules the card relies on: a debounce, a revision-checked acknowledgement that never
// replaces newer text, an honest conflict/offline state, and a scoped outbox for a reload.

const fields = (patch: Partial<EmailDraftFields> = {}): EmailDraftFields => ({
  accountId: "work",
  to: ["bob@example.test"],
  cc: [],
  bcc: [],
  subject: "Lunch",
  body: "Hello",
  inReplyTo: null,
  ...patch,
});

const draftOf = (revision: number, patch: Partial<EmailDraftFields> = {}): EmailDraft => ({
  id: "drf_one",
  threadId: "chat-a",
  messageId: null,
  toolCallId: null,
  ...fields(patch),
  revision,
  status: "draft",
  updatedBy: "model",
  accountMissing: false,
  sentAt: null,
  sendCount: 0,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
});

const account = (patch: Partial<EmailAccount> = {}): EmailAccount => ({
  id: "work",
  label: "Work",
  address: "me@example.test",
  imap: { host: "imap.example.test", port: 993, security: "tls", username: "me@example.test" },
  smtp: { host: "smtp.example.test", port: 465, security: "tls", username: "me@example.test" },
  readEnabled: true,
  sendEnabled: true,
  isDefault: true,
  signature: "",
  allowInsecureProbe: false,
  lastCheckAt: null,
  lastCheckStatus: null,
  lastCheckError: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

function timers() {
  let next = 0;
  const pending = new Map<number, () => void>();
  return {
    pending,
    setTimer: (callback: () => void) => {
      const id = ++next;
      pending.set(id, callback);
      return id;
    },
    clearTimer: (handle: unknown) => void pending.delete(handle as number),
    advance(ms = DRAFT_AUTOSAVE_MS) {
      assert.ok(ms >= DRAFT_AUTOSAVE_MS);
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback();
    },
  };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

test("edits wait for the debounce and then save with the observed revision", async () => {
  const clock = timers();
  const calls: Array<{ revision: number; fields: EmailDraftFields }> = [];
  const controller = new DraftAutosave(draftOf(3), {
    key: "k",
    storage: null,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    save: async ({ revision, fields: next }) => {
      calls.push({ revision, fields: next });
      return draftOf(revision + 1, next);
    },
    fetchLatest: async () => draftOf(3),
  });
  controller.update({ body: "Changed" });
  assert.equal(calls.length, 0, "nothing is written on each keystroke");
  assert.equal(controller.snapshot().status, "pending");
  await settle();
  assert.equal(calls.length, 0, "the timer has not fired yet");
  clock.advance();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.revision, 3);
  assert.equal(calls[0]!.fields.body, "Changed");
  assert.equal(controller.snapshot().status, "saved");
  assert.equal(controller.snapshot().revision, 4);
  controller.dispose();
});

test("an edit made while a save is in flight survives the older acknowledgement", async () => {
  const clock = timers();
  let release!: (value: EmailDraft) => void;
  const calls: Array<{ revision: number; fields: EmailDraftFields }> = [];
  const controller = new DraftAutosave(draftOf(1), {
    key: "k",
    storage: null,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    save: ({ revision, fields: next }) => {
      calls.push({ revision, fields: next });
      return new Promise<EmailDraft>((resolve) => { release = resolve; });
    },
    fetchLatest: async () => draftOf(1),
  });
  controller.update({ body: "First" });
  clock.advance();
  await settle();
  assert.equal(calls.length, 1);
  controller.update({ body: "Second" });
  release(draftOf(2, { body: "First" }));
  await settle();
  await settle();
  const afterFirst = controller.snapshot();
  assert.equal(afterFirst.revision, 2);
  assert.equal(afterFirst.fields.body, "Second", "local text is newer than the acknowledgement");
  assert.equal(afterFirst.status, "pending");
  assert.equal(clock.pending.size, 1, "the newer text is queued again");
  clock.advance();
  await settle();
  release(draftOf(3, { body: "Second" }));
  await settle();
  await settle();
  assert.equal(calls.at(-1)!.revision, 2);
  assert.equal(controller.snapshot().fields.body, "Second");
  assert.equal(controller.snapshot().status, "saved");
  controller.dispose();
});

test("a conflict keeps the local text and a retry writes it over the latest revision", async () => {
  const clock = timers();
  const calls: Array<{ revision: number; fields: EmailDraftFields }> = [];
  let attempts = 0;
  const controller = new DraftAutosave(draftOf(1), {
    key: "k",
    storage: null,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    save: async ({ revision, fields: next }) => {
      calls.push({ revision, fields: next });
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("Revision changed"), { status: 409 });
      return draftOf(revision + 1, next);
    },
    fetchLatest: async () => draftOf(7, { body: "Model update" }),
  });
  controller.update({ body: "Mine" });
  clock.advance();
  await settle();
  assert.equal(controller.snapshot().status, "conflict");
  assert.equal(controller.snapshot().fields.body, "Mine");
  await controller.retry();
  assert.equal(calls.at(-1)!.revision, 7, "the retry uses the latest revision");
  assert.equal(calls.at(-1)!.fields.body, "Mine");
  assert.equal(controller.snapshot().status, "saved");
  controller.dispose();
});

test("a network failure is offline, keeps the text, and retries at the same revision", async () => {
  const clock = timers();
  let attempt = 0;
  const revisions: number[] = [];
  const controller = new DraftAutosave(draftOf(2), {
    key: "k",
    storage: null,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    save: async ({ revision, fields: next }) => {
      revisions.push(revision);
      attempt++;
      if (attempt === 1) throw Object.assign(new Error("No network"), { status: 0 });
      return draftOf(revision + 1, next);
    },
    fetchLatest: async () => draftOf(2),
  });
  controller.update({ subject: "Offline edit" });
  clock.advance();
  await settle();
  assert.equal(controller.snapshot().status, "offline");
  assert.equal(controller.snapshot().fields.subject, "Offline edit");
  await controller.retry();
  assert.deepEqual(revisions, [2, 2]);
  assert.equal(controller.snapshot().status, "saved");
  controller.dispose();
});

test("hydration uses the latest server record and restores only same-revision local text", () => {
  const storage = new Map<string, string>();
  const store: DraftOutboxStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => void storage.set(key, value),
    removeItem: (key) => void storage.delete(key),
  };
  const key = draftOutboxKey("alice", "chat-a", "drf_one");
  writeOutbox(store, key, { revision: 1, fields: fields({ body: "Unsaved" }), savedAt: 1 });
  const controller = new DraftAutosave(draftOf(1), {
    key,
    storage: store,
    save: async () => draftOf(2),
    fetchLatest: async () => draftOf(1),
  });
  controller.applyServer(draftOf(1));
  assert.equal(controller.snapshot().fields.body, "Unsaved", "same-revision unsaved text survives reload");
  assert.equal(controller.snapshot().status, "pending");
  assert.notEqual(readOutbox(store, key), null, "unsaved text stays in the outbox");
  controller.applyServer(draftOf(4, { body: "Server wins" }));
  assert.equal(controller.snapshot().fields.body, "Server wins", "a newer revision wins over stale local text");
  assert.equal(controller.snapshot().revision, 4);
  assert.equal(readOutbox(store, key), null);
  controller.dispose();
});

test("card states and word count are derived, including no account and sent", () => {
  const base = { loading: false, discarded: false, autosave: "saved" as const };
  assert.equal(deriveDraftCardState({ ...base, draft: null, accounts: [] }), "loading");
  assert.equal(deriveDraftCardState({ ...base, draft: draftOf(1), accounts: [] }), "no-account");
  assert.equal(deriveDraftCardState({ ...base, draft: draftOf(1), accounts: [account({ sendEnabled: false })] }), "draft");
  assert.equal(deriveDraftCardState({ ...base, draft: draftOf(1, { accountId: null }), accounts: [account()] }), "draft");
  assert.equal(deriveDraftCardState({ ...base, autosave: "saving", draft: draftOf(1), accounts: [account()] }), "saving");
  assert.equal(deriveDraftCardState({ ...base, draft: { ...draftOf(1), status: "sent" }, accounts: [account()] }), "sent");
  assert.equal(deriveDraftCardState({ ...base, discarded: true, draft: draftOf(1), accounts: [account()] }), "discarded");
  assert.equal(deriveDraftCardState({ ...base, loading: true, draft: null, accounts: [] }), "loading");
  assert.equal(draftWordCount(""), 0);
  assert.equal(draftWordCount("  one\ntwo   three "), 3);
});
