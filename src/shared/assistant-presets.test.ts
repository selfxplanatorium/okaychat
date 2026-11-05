import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ASSISTANT_ICON,
  MAX_PRESET_INSTRUCTIONS,
  publishabilityError,
  samplingCapabilities,
  snapshotOf,
  validatePresetConfig,
  validatePresetInput,
  validateSampling,
  validateToolPolicy,
  type AssistantPreset,
} from "./assistant-presets.js";
import type { ModelInfo } from "./types.js";

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  ref: "openai/gpt-test",
  providerId: "openai",
  id: "gpt-test",
  name: "GPT Test",
  format: "openai-chat",
  context: 128_000,
  maxOutput: 16_384,
  reasoning: false,
  toolCall: true,
  attachments: true,
  inputModalities: ["text"],
  temperature: true,
  free: false,
  ...over,
});

const config = (over: Record<string, unknown> = {}) => ({
  modelRef: null,
  instructions: "Be brief.",
  sampling: {},
  tools: { mode: "inherit", builtins: [], mcpTools: [] },
  knowledge: { mode: "inherit", ids: [] },
  ...over,
});

test("preset input trims names, applies the default icon, and rejects non-allowlisted icons", () => {
  const ok = validatePresetInput({ name: "  Writer  ", icon: "pen-line", config: config() });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.name, "Writer");
    assert.equal(ok.value.icon, "pen-line");
    assert.equal(ok.value.visibility, "private");
  }
  assert.equal(validatePresetInput({ name: "Writer", icon: "remote.svg", config: config() }).ok, false);
  assert.equal(validatePresetInput({ name: "   ", config: config() }).ok, false);
});

test("instructions are bounded in code points and bytes, and both sampling fields cannot be set", () => {
  assert.equal(validatePresetConfig(config({ instructions: "x".repeat(MAX_PRESET_INSTRUCTIONS + 1) })).ok, false);
  const both = validatePresetConfig(config({ sampling: { temperature: 0.5, topP: 0.9 } }));
  // Both are accepted at rest; the model-aware check rejects the pair with an actionable message.
  assert.equal(both.ok, true);
  const rejected = validateSampling({ temperature: 0.5, topP: 0.9 }, model(), "none");
  assert.equal(rejected.ok, false);
  assert.match(rejected.message ?? "", /not both/i);
});

test("sampling rejects numeric strings, NaN, and out-of-range values before any provider call", () => {
  assert.equal(validatePresetConfig(config({ sampling: { temperature: "0.5" } })).ok, false);
  assert.equal(validatePresetConfig(config({ sampling: { temperature: Number.NaN } })).ok, false);
  assert.equal(validateSampling({ temperature: 2.5 }, model(), "none").ok, false);
  assert.equal(validateSampling({ topP: 0 }, model(), "none").ok, false);
  assert.equal(validateSampling({ maxOutputTokens: 1.5 }, model(), "none").ok, false);
});

test("sampling support follows the catalog: reasoning models hide temperature unless effort is off", () => {
  const reasoning = model({ reasoning: true });
  assert.equal(samplingCapabilities(reasoning, undefined).temperature, false);
  assert.equal(samplingCapabilities(reasoning, "medium").temperature, false);
  assert.equal(samplingCapabilities(reasoning, "none").temperature, true);
  assert.equal(samplingCapabilities(model(), undefined).temperature, true);
  assert.equal(samplingCapabilities(model({ temperature: false }), "none").temperature, false);
});

test("the plan-login provider offers no sampling or max-output override", () => {
  const plan = model({ providerId: "chatgpt" });
  const caps = samplingCapabilities(plan, "none");
  assert.equal(caps.temperature, false);
  assert.equal(caps.maxOutputTokens, false);
  assert.equal(validateSampling({ maxOutputTokens: 100 }, plan, "none").ok, false);
});

test("published items may not reference private knowledge collections or MCP tools", () => {
  const base = validatePresetConfig(config());
  assert.ok(base.ok);
  if (!base.ok) return;
  assert.equal(publishabilityError(base.value), null);
  assert.match(
    publishabilityError({ ...base.value, knowledge: { mode: "selected", ids: ["knc_1"] } }) ?? "",
    /knowledge/,
  );
  assert.match(
    publishabilityError({ ...base.value, tools: { mode: "selected", builtins: ["web"], mcpTools: [{ serverId: "srv", toolName: "run" }] } }) ?? "",
    /MCP/,
  );
});

test("tool policy dedupes MCP selectors and rejects unknown families", () => {
  const parsed = validateToolPolicy({
    mode: "selected",
    builtins: ["web", "web"],
    mcpTools: [
      { serverId: "a", toolName: "run" },
      { serverId: "a", toolName: "run" },
    ],
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value.builtins, ["web"]);
    assert.equal(parsed.value.mcpTools.length, 1);
  }
  assert.equal(validateToolPolicy({ mode: "selected", builtins: ["everything"] }).ok, false);
  // `inherit` must not also carry selections; the whole-config validator enforces the pair.
  assert.equal(validatePresetConfig({ modelRef: null, instructions: "", sampling: {}, tools: { mode: "inherit", builtins: ["web"], mcpTools: [] }, knowledge: { mode: "inherit", ids: [] } }).ok, false);
});

test("a snapshot copies validated fields and provenance, never an id the library can mutate", () => {
  const preset: Pick<AssistantPreset, "id" | "revision" | "name" | "icon" | "config" | "visibility"> = {
    id: "preset_1",
    revision: 3,
    name: "Writer",
    icon: DEFAULT_ASSISTANT_ICON,
    config: {
      modelRef: null,
      instructions: "Short answers.",
      sampling: {},
      tools: { mode: "inherit", builtins: [], mcpTools: [] },
      knowledge: { mode: "inherit", ids: [] },
    },
    visibility: "published",
  };
  const snapshot = snapshotOf(preset);
  assert.equal(snapshot.sourceId, "preset_1");
  assert.equal(snapshot.sourceRevision, 3);
  assert.equal(snapshot.origin, "published");
  assert.equal(snapshot.instructions, "Short answers.");
});
