/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { UI_LOCALES } from "@shared/ui-locales";
import { applyAccountLocale, localeDiffers, saveLocalePreference } from "./account-locale.js";

// The account language mirror reloads the page at most once per session. These tests use fake storages so a
// blocked localStorage cannot turn into a reload loop in the real browser either.

const memoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
};

const blockedStorage = (): Storage =>
  ({
    get length() {
      return 0;
    },
    clear: () => undefined,
    getItem: () => {
      throw new Error("blocked");
    },
    key: () => null,
    removeItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  }) as Storage;

let reloads = 0;
let local: Storage;
let session: Storage;
let events: string[] = [];

const define = (name: string, value: unknown) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

beforeEach(() => {
  reloads = 0;
  events = [];
  local = memoryStorage();
  session = memoryStorage();
  define("localStorage", local);
  define("sessionStorage", session);
  define("location", {
    reload: () => {
      reloads++;
      events.push("reload");
    },
  });
});

test("the account value differs from the device value exactly when the strings differ", () => {
  assert.equal(localeDiffers(null, null), false);
  assert.equal(localeDiffers("de", "de"), false);
  assert.equal(localeDiffers("de", null), true);
  assert.equal(localeDiffers(null, "de"), true);
  assert.equal(localeDiffers("de", "es"), true);
});

test("a mismatch mirrors every shipped account language and reloads once", () => {
  for (const { tag } of UI_LOCALES) {
    reloads = 0;
    local.clear();
    session.clear();
    assert.equal(applyAccountLocale("u1", tag), true, tag);
    assert.equal(local.getItem("okaychat:locale"), tag);
    assert.equal(session.getItem("okaychat:locale-sync"), `u1:${tag}`);
    assert.equal(reloads, 1);
    // The stored value now matches, so a second run is quiet and clears the guard.
    assert.equal(applyAccountLocale("u1", tag), false);
    assert.equal(reloads, 1);
    assert.equal(session.getItem("okaychat:locale-sync"), null);
  }
});

test("a regional or unshipped account tag is mirrored as is, not rewritten to a shipped base", () => {
  assert.equal(applyAccountLocale("u1", "pt-BR"), true);
  assert.equal(local.getItem("okaychat:locale"), "pt-BR");
});

test("after the guard clears, a later account change mirrors again", () => {
  assert.equal(applyAccountLocale("u1", "fr"), true);
  assert.equal(applyAccountLocale("u1", "fr"), false);
  assert.equal(session.getItem("okaychat:locale-sync"), null);
  // Another device changed the account language to Italian.
  assert.equal(applyAccountLocale("u1", "it"), true);
  assert.equal(local.getItem("okaychat:locale"), "it");
  assert.equal(reloads, 2);
});

test("a marker left by the mirror for one account does not suppress another account's mirror", () => {
  // u1's reload did not take effect (for example localStorage refused the write), so its marker remains.
  session.setItem("okaychat:locale-sync", "u1:fr");
  assert.equal(applyAccountLocale("u2", "fr"), true);
  assert.equal(session.getItem("okaychat:locale-sync"), "u2:fr");
  assert.equal(reloads, 1);
  assert.equal(applyAccountLocale("u2", "fr"), false);
  assert.equal(reloads, 1);
});

test("an already matching device never reloads", () => {
  local.setItem("okaychat:locale", "es");
  assert.equal(applyAccountLocale("u1", "es"), false);
  assert.equal(reloads, 0);
});

test("clearing the account language removes the device choice and reloads once", () => {
  local.setItem("okaychat:locale", "de");
  assert.equal(applyAccountLocale("u1", null), true);
  assert.equal(local.getItem("okaychat:locale"), null);
  assert.equal(reloads, 1);
  assert.equal(applyAccountLocale("u1", null), false);
  assert.equal(reloads, 1);
});

test("a blocked localStorage cannot cause a reload loop", () => {
  define("localStorage", blockedStorage());
  // The first load mirrors and reloads; the session marker then stops the next load.
  assert.equal(applyAccountLocale("u1", "de"), true);
  assert.equal(reloads, 1);
  assert.equal(applyAccountLocale("u1", "de"), false);
  assert.equal(reloads, 1);
});

test("a blocked sessionStorage never reloads, since the guard could not survive the reload", () => {
  define("sessionStorage", blockedStorage());
  // Without a usable marker nothing can be remembered, so the browser must not reload at all.
  assert.equal(applyAccountLocale("u1", "de"), false);
  assert.equal(reloads, 0);
});

test("with both storages blocked the mirror stays put", () => {
  define("localStorage", blockedStorage());
  define("sessionStorage", blockedStorage());
  assert.equal(applyAccountLocale("u1", "pt-PT"), false);
  assert.equal(reloads, 0);
});

const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("saving a language writes the account first, then mirrors and reloads", async () => {
  define("fetch", async (url: string, init: RequestInit) => {
    events.push(`${init.method} ${url} ${String(init.body)}`);
    return respond(200, { locale: "pt-PT" });
  });
  await saveLocalePreference("pt-PT");
  assert.deepEqual(events, ['PATCH /api/settings {"locale":"pt-PT"}', "reload"]);
  assert.equal(local.getItem("okaychat:locale"), "pt-PT");
  events = [];
  await saveLocalePreference(null);
  assert.deepEqual(events, ['PATCH /api/settings {"locale":null}', "reload"]);
  assert.equal(local.getItem("okaychat:locale"), null);
});

test("a failed save leaves this device untouched and does not reload", async () => {
  local.setItem("okaychat:locale", "de");
  define("fetch", async () => respond(500, { error: { code: "internal", message: "boom" } }));
  await assert.rejects(saveLocalePreference("fr"));
  assert.equal(local.getItem("okaychat:locale"), "de");
  assert.equal(reloads, 0);
});

test("the core i18n module never imports the API client", () => {
  // `lib/api.ts` imports `t`; an import back from `i18n/index.ts` would be a cycle.
  for (const file of ["index.ts", "locale.ts", "locales.ts", "locale-registry.ts", "format.ts"]) {
    const text = readFileSync(join(import.meta.dirname, file), "utf8");
    assert.doesNotMatch(text, /from "@\/lib\/api"|from "\.\.\/lib\/api"/, file);
  }
});
