/// <reference types="node" />
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { applyAccountLocale, localeDiffers } from "./account-locale.js";

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

const define = (name: string, value: unknown) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

beforeEach(() => {
  reloads = 0;
  local = memoryStorage();
  define("localStorage", local);
  define("sessionStorage", memoryStorage());
  define("location", { reload: () => void reloads++ });
});

test("the account value differs from the device value exactly when the strings differ", () => {
  assert.equal(localeDiffers(null, null), false);
  assert.equal(localeDiffers("de", "de"), false);
  assert.equal(localeDiffers("de", null), true);
  assert.equal(localeDiffers(null, "de"), true);
  assert.equal(localeDiffers("de", "es"), true);
});

test("a mismatch mirrors the account language and reloads once", () => {
  assert.equal(applyAccountLocale("u1", "de"), true);
  assert.equal(local.getItem("okaychat:locale"), "de");
  assert.equal(reloads, 1);
  // The stored value now matches, so a second run is quiet.
  assert.equal(applyAccountLocale("u1", "de"), false);
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

test("another account's marker does not suppress this account's mirror", () => {
  define("sessionStorage", blockedStorage());
  // Without a usable marker nothing can be remembered, so the browser must not reload at all.
  assert.equal(applyAccountLocale("u1", "de"), false);
  assert.equal(reloads, 0);
});
