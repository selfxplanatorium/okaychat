/// <reference types="node" />
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";

// The translation store is a read cache for the open page. These tests pin the single-flight list, the
// one-request-per-message rule, abort handling, stale rows, and the account reset.

const realFetch = globalThis.fetch;
type Pending = { path: string; method: string; resolve: (body: unknown, status?: number) => void };
let pending: Pending[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = ((input: string, init?: RequestInit) =>
  new Promise((resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    pending.push({ path: input, method: init?.method ?? "GET", resolve: (body, status) => resolve(json(body, status)) });
  })) as typeof fetch;

// The store reads `useData` for the preferred language, and that store snapshots localStorage at module load.
const local = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() { return local.size; },
    clear: () => local.clear(),
    getItem: (name: string) => local.get(name) ?? null,
    key: (index: number) => [...local.keys()][index] ?? null,
    removeItem: (name: string) => void local.delete(name),
    setItem: (name: string, value: string) => void local.set(name, value),
  },
});

const {
  cancelTranslation,
  loadTranslations,
  removeTranslation,
  setTranslationsAccount,
  translateMessage,
  useTranslations,
} = await import("./message-translations.js");

const key = "thr_1 msg_1";
const entry = (lang: string, overrides: Record<string, unknown> = {}) => ({
  messageId: "msg_1",
  lang,
  text: `Übersetzung ${lang}`,
  sourceHash: "h1",
  sourceChars: 12,
  truncated: false,
  modelRef: "custom-test/mock",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});
const stateOf = () => useTranslations.getState().messages[key];

beforeEach(() => {
  pending = [];
  setTranslationsAccount(null);
  setTranslationsAccount("alice");
});
afterEach(() => setTranslationsAccount(null));
after(() => {
  globalThis.fetch = realFetch;
});

test("one list request per message is shared and existing languages load", async () => {
  const first = loadTranslations("thr_1", "msg_1");
  const second = loadTranslations("thr_1", "msg_1");
  assert.equal(pending.length, 1);
  assert.equal(first, second);
  pending[0]!.resolve({ messageId: "msg_1", sourceHash: "h1", sourceChars: 12, translations: [{ ...entry("de"), stale: false }] });
  await first;
  assert.equal(stateOf()?.entries.de?.text, "Übersetzung de");
  // A reload keeps the block hidden: the list fills the dialog, and only a confirmed Translate shows text.
  assert.equal(stateOf()?.active, null);
  await loadTranslations("thr_1", "msg_1");
  assert.equal(pending.length, 1, "a loaded message is not fetched again");
});

test("a stale row is kept but never shown", async () => {
  const request = loadTranslations("thr_1", "msg_1");
  pending[0]!.resolve({ messageId: "msg_1", sourceHash: "h2", sourceChars: 12, translations: [{ ...entry("de"), stale: true }] });
  await request;
  assert.equal(stateOf()?.entries.de?.stale, true);
  assert.equal(stateOf()?.active, null);
});

test("a confirmed translate activates its language", async () => {
  const request = translateMessage("thr_1", "msg_1", "de");
  assert.equal(pending[0]?.method, "PUT");
  assert.match(pending[0]!.path, /\/translations\/de$/);
  pending[0]!.resolve(entry("de"));
  await request;
  assert.equal(stateOf()?.active, "de");
  assert.equal(stateOf()?.status, "idle");
  assert.equal(stateOf()?.entries.de?.stale, false);
});

test("cancelling aborts the request and returns the block to idle without an error", async () => {
  const request = translateMessage("thr_1", "msg_1", "de");
  cancelTranslation("thr_1", "msg_1");
  await request;
  assert.equal(stateOf()?.status, "idle");
  assert.equal(stateOf()?.error, null);
  assert.equal(stateOf()?.entries.de, undefined);
});

test("a failed write shows an error, and the next attempt clears it", async () => {
  const failed = translateMessage("thr_1", "msg_1", "de");
  pending[0]!.resolve({ error: "nope", code: "conflict", message: "Limit reached" }, 409);
  await failed;
  assert.equal(stateOf()?.status, "error");

  const retried = translateMessage("thr_1", "msg_1", "de");
  pending[1]!.resolve(entry("de"));
  await retried;
  assert.equal(stateOf()?.status, "idle");
  assert.equal(stateOf()?.error, null);
});

test("removing a language deletes its row and hides the block", async () => {
  const request = translateMessage("thr_1", "msg_1", "de");
  pending[0]!.resolve(entry("de"));
  await request;
  assert.equal(stateOf()?.active, "de");

  const removing = removeTranslation("thr_1", "msg_1", "de");
  assert.equal(pending[1]?.method, "DELETE");
  pending[1]!.resolve({ ok: true });
  await removing;
  assert.equal(stateOf()?.entries.de, undefined);
  assert.equal(stateOf()?.active, null);
});

test("an account switch clears every entry", async () => {
  const request = translateMessage("thr_1", "msg_1", "de");
  pending[0]!.resolve(entry("de"));
  await request;
  assert.ok(stateOf());
  setTranslationsAccount("bob");
  assert.deepEqual(useTranslations.getState().messages, {});
});
