/// <reference types="node" />
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import type { SavedPrompt } from "../../shared/saved-prompts.js";

const realFetch = globalThis.fetch;
type Pending = { path: string; resolve: (body: unknown) => void };
let pending: Pending[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = ((input: string) =>
  new Promise((resolve) => {
    pending.push({ path: input, resolve: (body) => resolve(json(body)) });
  })) as typeof fetch;

const { createSavedPrompt, deleteSavedPrompt, loadSavedPrompts, setSavedPromptsAccount, useSavedPrompts } = await import("./saved-prompts.js");

const prompt = (id: string, name = id): SavedPrompt => ({ id, name, shortcut: name.toLowerCase(), body: "text", revision: 1, createdAt: 1, updatedAt: 1 });
const names = () => useSavedPrompts.getState().prompts.map((p) => p.name);

beforeEach(() => {
  pending = [];
  setSavedPromptsAccount(null);
  setSavedPromptsAccount("alice");
});
afterEach(() => setSavedPromptsAccount(null));
after(() => {
  globalThis.fetch = realFetch;
});

test("opening twice shares one request and keeps the list sorted by name", async () => {
  const first = loadSavedPrompts();
  const second = loadSavedPrompts();
  assert.equal(pending.length, 1);
  assert.equal(first, second);
  pending[0]!.resolve({ prompts: [prompt("2", "zeta"), prompt("1", "Alpha")] });
  await first;
  assert.deepEqual(names(), ["Alpha", "zeta"]);
  assert.equal(useSavedPrompts.getState().loaded, true);
  // A loaded library is not fetched again unless forced.
  await loadSavedPrompts();
  assert.equal(pending.length, 1);
});

test("a previous account's answer never reaches the store", async () => {
  const old = loadSavedPrompts();
  setSavedPromptsAccount("bob");
  pending[0]!.resolve({ prompts: [prompt("leak", "private")] });
  await old;
  assert.deepEqual(names(), []);
  assert.equal(useSavedPrompts.getState().loaded, false);
  const current = loadSavedPrompts();
  pending[1]!.resolve({ prompts: [prompt("bob-1", "Bob's")] });
  await current;
  assert.deepEqual(names(), ["Bob's"]);
});

test("a GET that started before an acknowledged create cannot bring back the old list", async () => {
  const load = loadSavedPrompts();
  const created = createSavedPrompt({ name: "New", shortcut: "new", body: "text" });
  const newPrompt: SavedPrompt = { ...prompt("sp_new", "New"), shortcut: "new" };
  // The server answers the write first, then the older list without it.
  const writes = pending.filter((p) => p.path === "/api/saved-prompts" && p !== pending[0]);
  assert.equal(writes.length, 1);
  writes[0]!.resolve(newPrompt);
  assert.deepEqual(await created, newPrompt);
  pending[0]!.resolve({ prompts: [] });
  await load;
  assert.deepEqual(names(), ["New"]);
});

test("delete removes only the acknowledged prompt", async () => {
  const load = loadSavedPrompts();
  pending[0]!.resolve({ prompts: [prompt("a", "Alpha"), prompt("b", "Beta")] });
  await load;
  const request = deleteSavedPrompt("a", 1);
  const remove = pending.find((p) => p.path.endsWith("/saved-prompts/a"))!;
  remove.resolve({ ok: true });
  await request;
  assert.deepEqual(names(), ["Beta"]);
});
