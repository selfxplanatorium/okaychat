/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PolicyRow, PromptRule } from "@shared/permissions";
import {
  applyPromptLayer,
  baselinePolicy,
  baselinePrompt,
  collectChanges,
  inheritedPromptText,
  nextPromptDraft,
  normalizePromptText,
  policyChange,
  policyKey,
  promptChange,
  setFeature,
  setLimit,
  setModelAllowed,
  type PolicyDraft,
  type PromptDraft,
  type PromptLayerRow,
} from "./permissions-draft.js";

const user = { kind: "user" as const, id: "u1" };

test("editing a policy removes inherited fields instead of writing today's value", () => {
  let document = setModelAllowed({ version: 1 }, true);
  assert.deepEqual(document, { version: 1, modelAllowed: true });
  document = setModelAllowed(document, undefined);
  assert.deepEqual(document, { version: 1 });

  document = setFeature({ version: 1 }, "webSearch", false);
  assert.deepEqual(document, { version: 1, features: { webSearch: false } });
  document = setFeature(document, "webSearch", undefined);
  assert.deepEqual(document, { version: 1 });
});

test("limit null is an explicit no-additional-limit and undefined is inherit", () => {
  const unlimited = setLimit({ version: 1 }, "maxSteps", null);
  assert.deepEqual(unlimited, { version: 1, limits: { maxSteps: null } });
  assert.deepEqual(setLimit(unlimited, "maxSteps", undefined), { version: 1 });
  assert.deepEqual(setLimit({ version: 1 }, "maxSearches", 0), { version: 1, limits: { maxSearches: 0 } });
});

test("a policy change is emitted only when the destination really differs", () => {
  const baseline = { version: 1 as const, features: { code: false as const } };
  assert.equal(policyChange(user, null, { version: 1, features: { code: false } }, baseline), null);
  assert.equal(policyChange(user, null, { version: 1 }, baseline)?.kind, "policy");
  assert.deepEqual(policyChange(user, null, { version: 1 }, baseline), {
    kind: "policy",
    subject: user,
    modelRef: null,
    document: null,
  });
  assert.equal(policyKey(user, "openai/gpt-5"), "user:u1|openai/gpt-5");
});

test("prompt text normalizes CRLF and keeps other whitespace", () => {
  assert.equal(normalizePromptText("a\r\nb\rc  \n"), "a\nb\nc  \n");
  assert.deepEqual(nextPromptDraft(null, "append", "  x  "), { mode: "append", text: "  x  " });
  assert.equal(nextPromptDraft(null, "inherit", "anything"), null);
});

test("prompt changes compare normalized rules and delete with null", () => {
  const baseline = { mode: "append" as const, text: "a\nb" };
  assert.equal(promptChange(user, null, "chat", { mode: "append", text: "a\r\nb" }, baseline), null);
  assert.equal(promptChange(user, null, "chat", null, baseline)?.kind, "prompt");
  assert.equal(promptChange(user, null, "chat", baseline, null)?.kind, "prompt");
});

test("collectChanges serializes only edited destinations", () => {
  const policies: Array<{ subject: typeof user; modelRef: string | null; draft: PolicyDraft }> = [
    { subject: user, modelRef: null, draft: { baseline: { version: 1 }, draft: { version: 1 } } },
    { subject: user, modelRef: "openai/gpt-5", draft: { baseline: null, draft: { version: 1, modelAllowed: false } } },
  ];
  const prompts: Array<{ subject: typeof user; modelRef: string | null; key: "chat"; draft: PromptDraft }> = [
    { subject: user, modelRef: null, key: "chat", draft: { baseline: null, draft: null } },
    { subject: user, modelRef: null, key: "chat", draft: { baseline: null, draft: { mode: "replace", text: "x" } } },
  ];
  const changes = collectChanges(policies, prompts);
  assert.equal(changes.length, 2);
  assert.deepEqual(
    changes.map((change) => change.kind),
    ["policy", "prompt"],
  );
});

test("baseline lookup ignores other subjects and normalizes stored documents", () => {
  const rows: PolicyRow[] = [
    { subject: { kind: "user", id: "u1" }, modelRef: null, document: { version: 1, limits: { maxSteps: 3 } }, updatedAt: 1, updatedBy: null },
  ];
  assert.deepEqual(baselinePolicy(rows, user, null), { version: 1, limits: { maxSteps: 3 } });
  assert.equal(baselinePolicy(rows, { kind: "user", id: "u2" }, null), null);
  const prompts: PromptRule[] = [
    { subject: user, modelRef: null, key: "chat", rule: { mode: "append", text: "x\r\ny" }, updatedAt: 1 },
  ];
  assert.deepEqual(baselinePrompt(prompts, user, null, "chat"), { mode: "append", text: "x\ny" });
  assert.equal(baselinePrompt(prompts, user, null, "title"), null);
});

test("prompt layers replace and append with a blank line", () => {
  assert.equal(applyPromptLayer("base", { mode: "append", text: "more" }), "base\n\nmore");
  assert.equal(applyPromptLayer("", { mode: "append", text: "more" }), "more");
  assert.equal(applyPromptLayer("base", { mode: "replace", text: "new" }), "new");
  assert.equal(applyPromptLayer("base", null), "base");
});

test("inherited prompt applies everyone, groups in order, then the user", () => {
  const layers: PromptLayerRow[] = [
    { subject: { kind: "user", id: "u1" }, modelRef: null, rule: { mode: "append", text: "user" }, order: 0 },
    { subject: { kind: "group", id: "g2" }, modelRef: null, rule: { mode: "append", text: "g2" }, order: 20 },
    { subject: { kind: "group", id: "g1" }, modelRef: null, rule: { mode: "append", text: "g1" }, order: 10 },
    { subject: { kind: "everyone", id: "" }, modelRef: null, rule: { mode: "append", text: "all" }, order: 0 },
  ];
  const text = inheritedPromptText(
    "default",
    null,
    layers,
    { kind: "user", id: "u1" },
    null,
    new Map([
      ["g1", 10],
      ["g2", 20],
    ]),
    ["g1", "g2"],
  );
  assert.equal(text, "default\n\nall\n\ng1\n\ng2\n\nuser");
});

test("a server prompt override replaces the compiled default", () => {
  assert.equal(
    inheritedPromptText("default", "server", [], { kind: "everyone", id: "" }, null, new Map(), []),
    "server",
  );
});
