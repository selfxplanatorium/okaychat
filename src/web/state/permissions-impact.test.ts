/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeImpact, impactTotals, impactValueText, limitDirection } from "./permissions-impact.js";

const row = (path: string, before: boolean | number | string | null, after: boolean | number | string | null) => ({
  userId: "u1",
  modelRef: null,
  path,
  before,
  after,
  beforeSources: [],
  afterSources: [],
});

test("model access and features describe grants and revocations", () => {
  assert.deepEqual(describeImpact(row("modelAllowed", false, true)), {
    kind: "access",
    name: null,
    direction: "granted",
    before: false,
    after: true,
  });
  assert.equal(describeImpact(row("modelAllowed", true, false)).direction, "revoked");
  assert.equal(describeImpact(row("features.webSearch", false, true)).direction, "granted");
  assert.equal(describeImpact(row("features.webSearch", true, false)).direction, "revoked");
  assert.equal(describeImpact(row("features.webSearch", true, false)).name, "webSearch");
});

test("limits tighten when the number falls and relax when it rises", () => {
  assert.equal(limitDirection(10, 5), "tightened");
  assert.equal(limitDirection(5, 10), "relaxed");
  assert.equal(limitDirection(null, 10), "tightened");
  assert.equal(limitDirection(10, null), "relaxed");
  assert.equal(limitDirection(null, null), "changed");
  assert.equal(describeImpact(row("limits.maxSteps", 10, 5)).kind, "limit");
  assert.equal(describeImpact(row("buckets.model.concurrentTurns", 4, null)).kind, "bucket");
});

test("prompt and resource paths stay distinguishable", () => {
  assert.equal(describeImpact(row("prompts.chat", "abc", "def")).kind, "prompt");
  assert.equal(describeImpact(row("prompts.chat", "abc", "def")).name, "chat");
  assert.equal(describeImpact(row("resource.provider.openai.access", false, true)).direction, "granted");
  assert.equal(describeImpact(row("resource.provider.openai.models.gpt-5", true, false)).kind, "resource");
});

test("unknown paths are shown as a generic changed resource rather than dropped", () => {
  const descriptor = describeImpact(row("something.new", 1, 2));
  assert.equal(descriptor.kind, "resource");
  assert.equal(descriptor.name, "something.new");
  assert.equal(descriptor.direction, "changed");
});

test("impact values are display-safe", () => {
  assert.equal(impactValueText(null), "—");
  assert.equal(impactValueText(true), "true");
  assert.equal(impactValueText(0), "0");
  assert.equal(impactValueText("abc"), "abc");
});

test("totals count every direction", () => {
  const totals = impactTotals([
    row("modelAllowed", false, true),
    row("features.code", true, false),
    row("limits.maxSteps", 10, 5),
    row("limits.maxSearches", 5, 10),
    row("prompts.chat", "a", "b"),
  ]);
  assert.deepEqual(totals, { granted: 1, revoked: 1, tightened: 1, relaxed: 1, changed: 1 });
});
