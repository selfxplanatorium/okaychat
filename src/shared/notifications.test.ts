import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NOTIFICATION_BODY_KEYS,
  NOTIFICATION_TITLE_KEYS,
  isNotificationBodyKey,
  isNotificationTitleKey,
  safeActionPath,
  sanitizeNotificationParams,
} from "./notifications.js";

test("only the allowlisted keys are writable", () => {
  for (const key of NOTIFICATION_TITLE_KEYS) assert.equal(isNotificationTitleKey(key), true);
  for (const key of NOTIFICATION_BODY_KEYS) assert.equal(isNotificationBodyKey(key), true);
  assert.equal(isNotificationTitleKey("schedule.unknown"), false);
  assert.equal(isNotificationBodyKey("schedule.ok"), false);
  assert.equal(isNotificationBodyKey("arbitrary"), false);
});

test("params are bounded, typed, and capped", () => {
  assert.deepEqual(sanitizeNotificationParams({ title: "Daily", chats: 3, ok: true, missing: null }), { title: "Daily", chats: 3 });
  assert.deepEqual(sanitizeNotificationParams({ long: "x".repeat(800) }).long?.toString().length, 500);
  assert.equal(Object.keys(sanitizeNotificationParams(Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, index])))).length, 12);
  assert.deepEqual(sanitizeNotificationParams({ "bad key": "x", "": "y", good: "z" }), { good: "z" });
  assert.deepEqual(sanitizeNotificationParams({ notFinite: Number.POSITIVE_INFINITY, nan: Number.NaN, fine: 1.5 }), { fine: 1.5 });
  assert.deepEqual(sanitizeNotificationParams(null), {});
  assert.deepEqual(sanitizeNotificationParams(["array"]), {});
});

test("action paths must stay inside the app", () => {
  assert.equal(safeActionPath("/c/thr_1"), "/c/thr_1");
  assert.equal(safeActionPath("/scheduled"), "/scheduled");
  assert.equal(safeActionPath("//evil.test/path"), null);
  assert.equal(safeActionPath("https://evil.test"), null);
  assert.equal(safeActionPath("javascript:alert(1)"), null);
  assert.equal(safeActionPath("/api/https://evil.test"), null);
  assert.equal(safeActionPath("relative"), null);
  assert.equal(safeActionPath(`/${"a".repeat(301)}`), null);
  assert.equal(safeActionPath(undefined), null);
});
