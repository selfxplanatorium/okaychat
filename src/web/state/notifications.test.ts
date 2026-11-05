import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { AppNotification } from "@shared/notifications";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

const { NOTIFIED_LIMIT, readNotifiedIds, rememberNotifiedIds, unseenNotices } = await import("./notifications.js");

const notice = (id: string, createdAt: number): AppNotification => ({
  id,
  kind: "schedule",
  level: "success",
  titleKey: "schedule.ok",
  bodyKey: "schedule.okBody",
  params: { title: "Daily", thread: "Chat" },
  threadId: "t1",
  actionPath: "/c/t1",
  readAt: null,
  createdAt,
});

beforeEach(() => store.clear());

test("announced ids stay per account and bounded", () => {
  rememberNotifiedIds("u1", ["a", "b"]);
  rememberNotifiedIds("u2", ["c"]);
  assert.deepEqual(readNotifiedIds("u1"), ["a", "b"]);
  assert.deepEqual(readNotifiedIds("u2"), ["c"]);
  rememberNotifiedIds("u1", Array.from({ length: NOTIFIED_LIMIT + 20 }, (_, index) => `n${index}`));
  const kept = readNotifiedIds("u1");
  assert.equal(kept.length, NOTIFIED_LIMIT);
  assert.equal(kept.at(-1), `n${NOTIFIED_LIMIT + 19}`);
  assert.equal(kept.includes("a"), false);
});

test("only notices created while the page was open and not yet announced are new", () => {
  const since = 10_000;
  const items = [notice("old", since - 1), notice("fresh", since), notice("announced", since + 5)];
  assert.deepEqual(
    unseenNotices(items, new Set(["announced"]), since).map((item) => item.id),
    ["fresh"],
  );
  assert.deepEqual(unseenNotices(items, new Set(items.map((item) => item.id)), since), []);
});
