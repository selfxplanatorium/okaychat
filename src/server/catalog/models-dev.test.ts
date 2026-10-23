import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawModel, RawProvider } from "./models-dev.js";

process.env.OKAYCHAT_SECRET ??= "models-dev-test-secret-only-not-for-production";
const { toModelInfo } = await import("./models-dev.js");

const openai = { id: "openai", npm: "@ai-sdk/openai", models: {} } as unknown as RawProvider;
const model = (id: string, output: string[], family?: string) =>
  ({ id, name: id, family, modalities: { input: ["text"], output } }) as unknown as RawModel;

test("chat list keeps chat models", () => {
  assert.ok(toModelInfo(openai, model("gpt-5.2", ["text"], "gpt")));
});

test("chat list drops embedding, image, and realtime models that models.dev lists with text output", () => {
  for (const m of [
    model("text-embedding-3-small", ["text"], "text-embedding"),
    model("gpt-image-1-mini", ["text", "image"], "gpt-image"),
    model("gpt-image-1", ["image"], "gpt-image"),
    model("gpt-realtime-2.1", ["text", "audio"], "gpt"),
    model("gpt-4o-transcribe", ["text"], "gpt"),
  ]) {
    assert.equal(toModelInfo(openai, m), null, m.id);
  }
});
