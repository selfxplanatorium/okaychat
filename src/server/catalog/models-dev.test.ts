import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RawModel, RawProvider } from "./models-dev.js";

process.env.OKAYCHAT_SECRET ??= "models-dev-test-secret-only-not-for-production";
const { toModelInfo } = await import("./models-dev.js");

const catalogLiteral = `{ openai: { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", api: "https://api.openai.com/v1", models: { "gpt-a": { id: "gpt-a", name: "GPT A" } } } }`;
const runCatalog = (directory: string, code: string) =>
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    env: { ...process.env, OKAYCHAT_DATA_DIR: directory, OKAYCHAT_SECRET: "models-dev-catalog-secret-not-for-production" },
    encoding: "utf8",
  });
const dataUrl = new URL("./models-dev.ts", import.meta.url).href;

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

test("concurrent cold callers read the disk cache and refresh the network once", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "okaychat-catalog-test-"));
  const freshDir = path.join(directory, "fresh");
  const coldDir = path.join(directory, "cold");
  mkdirSync(freshDir);
  mkdirSync(coldDir);
  try {
    const fresh = JSON.parse(runCatalog(freshDir, `
      const { writeFileSync } = await import("node:fs");
      const path = await import("node:path");
      writeFileSync(path.join(process.env.OKAYCHAT_DATA_DIR, "models-dev.json"), JSON.stringify({ data: ${catalogLiteral}, fetchedAt: Date.now() }));
      let fetchCalls = 0;
      globalThis.fetch = async () => { fetchCalls += 1; throw new Error("a fresh cache must not refresh"); };
      const { getCatalog, catalogLoadStats } = await import(${JSON.stringify(dataUrl)});
      const results = await Promise.all(Array.from({ length: 20 }, () => getCatalog()));
      console.log(JSON.stringify({ fetchCalls, stats: catalogLoadStats, same: results.every((r) => r === results[0]), providers: Object.keys(results[0]) }));
      process.exit(0);
    `));
    assert.deepEqual(fresh, { fetchCalls: 0, stats: { diskLoads: 1, networkRefreshes: 0, failures: 0 }, same: true, providers: ["openai"] });

    const cold = JSON.parse(runCatalog(coldDir, `
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response(JSON.stringify(${catalogLiteral}), { status: 200, headers: { "content-type": "application/json" } });
      };
      const { getCatalog, catalogLoadStats } = await import(${JSON.stringify(dataUrl)});
      const results = await Promise.all(Array.from({ length: 20 }, () => getCatalog()));
      console.log(JSON.stringify({ fetchCalls, stats: catalogLoadStats, same: results.every((r) => r === results[0]) }));
      process.exit(0);
    `));
    assert.deepEqual(cold, { fetchCalls: 1, stats: { diskLoads: 1, networkRefreshes: 1, failures: 0 }, same: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed background refresh backs off instead of retrying on every request", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "okaychat-catalog-backoff-"));
  try {
    const result = JSON.parse(runCatalog(directory, `
      const { writeFileSync } = await import("node:fs");
      const path = await import("node:path");
      writeFileSync(path.join(process.env.OKAYCHAT_DATA_DIR, "models-dev.json"), JSON.stringify({ data: ${catalogLiteral}, fetchedAt: Date.now() - 24 * 60 * 60 * 1000 }));
      let fetchCalls = 0;
      globalThis.fetch = async () => { fetchCalls += 1; throw new Error("models.dev is down"); };
      const { getCatalog, catalogLoadStats } = await import(${JSON.stringify(dataUrl)});
      const first = await getCatalog();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const second = await getCatalog();
      const third = await getCatalog();
      console.log(JSON.stringify({
        fetchCalls,
        failures: catalogLoadStats.failures,
        staleIsServed: first === second && second === third && Object.keys(third).includes("openai"),
      }));
      process.exit(0);
    `));
    assert.deepEqual(result, { fetchCalls: 1, failures: 1, staleIsServed: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
