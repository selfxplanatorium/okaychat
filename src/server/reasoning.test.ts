import assert from "node:assert/strict";
import { test } from "node:test";
import { reasoningOptions, resolveReasoningEffort } from "../shared/reasoning.js";
import { DEFAULT_USER_SETTINGS } from "../shared/types.js";

const model = { ref: "provider/model", reasoningEfforts: ["low", "medium", "high"] };

test("chat effort follows Medium, then the account default, model override, and request override", () => {
  assert.equal(resolveReasoningEffort(model), "medium");
  const settings = { ...DEFAULT_USER_SETTINGS, defaultReasoningEffort: "high" as const };
  assert.equal(resolveReasoningEffort(model, settings), "high");
  const overridden = { ...settings, reasoningEffort: { [model.ref]: "low" as const } };
  assert.equal(resolveReasoningEffort(model, overridden), "low");
  assert.equal(resolveReasoningEffort(model, overridden, "medium"), "medium");
  assert.equal(resolveReasoningEffort({ ...model, ref: "provider/other" }, overridden), "high");
});

test("defaults and stale overrides resolve to a level actually offered by each model", () => {
  assert.equal(resolveReasoningEffort({ ...model, reasoningEfforts: ["none", "high"] }), "high");
  assert.equal(resolveReasoningEffort({ ...model, reasoningEfforts: ["low", "high"] }), "low");
  assert.equal(resolveReasoningEffort({ ...model, reasoningEfforts: ["low"] }), "low");
  assert.equal(resolveReasoningEffort(model, { ...DEFAULT_USER_SETTINGS, reasoningEffort: { [model.ref]: "max" } }), "high");
  assert.equal(resolveReasoningEffort({ ref: model.ref }), "medium");
  assert.deepEqual(reasoningOptions({ reasoningEfforts: [] }), ["low", "medium", "high"]);
  assert.deepEqual(reasoningOptions({ reasoningEfforts: ["high", "none"] }), ["none", "high"]);
});
