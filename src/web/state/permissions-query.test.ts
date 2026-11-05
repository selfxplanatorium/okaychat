/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { permissionsHref, settingsHref } from "@/lib/settings-link";
import {
  DEFAULT_PERMISSIONS_QUERY,
  isPermissionsSearch,
  parsePermissionsQuery,
  permissionsQueryRecord,
  reconcileSubject,
  stepIndex,
  subjectKey,
} from "./permissions-query.js";

test("an empty or unknown search falls back to the default workspace selection", () => {
  assert.deepEqual(parsePermissionsQuery(""), DEFAULT_PERMISSIONS_QUERY);
  assert.deepEqual(parsePermissionsQuery("?view=nope&subjectKind=user&subjectId=u1"), DEFAULT_PERMISSIONS_QUERY);
  assert.equal(isPermissionsSearch(""), false);
  assert.equal(isPermissionsSearch("view=people"), true);
});

test("valid query state is parsed and clamped", () => {
  const parsed = parsePermissionsQuery("?view=features&subjectKind=group&subjectId=g1&modelRef=openai%2Fgpt-5&tab=limits&filter=overridden&q=abc");
  assert.deepEqual(parsed.subject, { kind: "group", id: "g1" });
  assert.equal(parsed.modelRef, "openai/gpt-5");
  assert.equal(parsed.tab, "limits");
  assert.equal(parsed.filter, "overridden");
  assert.equal(parsed.q, "abc");
});

test("a user or group subject without an id is ignored", () => {
  assert.deepEqual(parsePermissionsQuery("?view=people&subjectKind=user").subject, { kind: "everyone", id: "" });
  assert.deepEqual(parsePermissionsQuery("?view=people&subjectKind=group&subjectId=").subject, { kind: "everyone", id: "" });
});

test("only non-default state appears in the URL", () => {
  assert.deepEqual(permissionsQueryRecord(DEFAULT_PERMISSIONS_QUERY), { view: "people" });
  assert.deepEqual(
    permissionsQueryRecord({
      view: "prompts",
      subject: { kind: "user", id: "u1" },
      modelRef: "openai/gpt-5",
      tab: "prompts",
      q: " x ",
      filter: "denied",
    }),
    { view: "prompts", subjectKind: "user", subjectId: "u1", modelRef: "openai/gpt-5", tab: "prompts", q: "x", filter: "denied" },
  );
});

test("settingsHref builds the admin permissions deep link and escapes values", () => {
  assert.equal(settingsHref("permissions"), "/settings/admin?view=people");
  assert.equal(
    settingsHref("permissions", { view: "features", subjectKind: "user", subjectId: "u1", modelRef: "openai/gpt-5" }),
    "/settings/admin?view=features&subjectKind=user&subjectId=u1&modelRef=openai%2Fgpt-5",
  );
  assert.equal(permissionsHref({ view: "inspect", userId: "u1" }), "/settings/admin?view=inspect&userId=u1");
});

test("reconcileSubject falls back when a directory row disappears", () => {
  const users = [{ id: "u1" }];
  const groups = [{ id: "g1" }];
  assert.deepEqual(reconcileSubject({ kind: "user", id: "u1" }, users, groups), { kind: "user", id: "u1" });
  assert.deepEqual(reconcileSubject({ kind: "user", id: "gone" }, users, groups), { kind: "everyone", id: "" });
  assert.deepEqual(reconcileSubject({ kind: "group", id: "g1" }, users, groups), { kind: "group", id: "g1" });
  assert.deepEqual(reconcileSubject({ kind: "everyone", id: "" }, users, groups), { kind: "everyone", id: "" });
});

test("subject keys stay stable and distinct", () => {
  assert.equal(subjectKey({ kind: "everyone", id: "" }), "everyone:");
  assert.equal(subjectKey({ kind: "user", id: "u1" }), "user:u1");
  assert.equal(subjectKey({ kind: "group", id: "g1" }), "group:g1");
});

test("stepIndex wraps and supports Home and End", () => {
  assert.equal(stepIndex(3, 0, "ArrowDown"), 1);
  assert.equal(stepIndex(3, 2, "ArrowDown"), 0);
  assert.equal(stepIndex(3, 0, "ArrowUp"), 2);
  assert.equal(stepIndex(3, 1, "Home"), 0);
  assert.equal(stepIndex(3, 1, "End"), 2);
  assert.equal(stepIndex(0, 0, "ArrowDown"), 0);
  assert.equal(stepIndex(3, 1, "Enter"), -1);
});
