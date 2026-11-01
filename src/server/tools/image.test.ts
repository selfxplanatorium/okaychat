import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { ImageServiceStatus } from "../../shared/image-services.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-image-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "image-test-secret-only-not-for-production";
const { db } = await import("../db.js");
const { requireUser } = await import("../auth.js");
const { sha256 } = await import("../crypto.js");
const { saveConnection, deleteConnection } = await import("../catalog/providers.js");
const { getSettings, updateSettings } = await import("../settings.js");
const { enabledImageServices, imagePath, imageRoutes, imageTools } = await import("./image.js");

// A real 2×3 JPEG: stored images are fully decoded, so a header alone is refused.
const { default: sharp } = await import("sharp");
const JPEG = await sharp({ create: { width: 2, height: 3, channels: 3, background: "#c03020" } }).jpeg().toBuffer();

const requests: Array<{ url: string; auth: string | undefined; body: string }> = [];
let server: Server;
let baseURL = "";

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", auth: req.headers.authorization, body });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/v1/models") {
        res.end(JSON.stringify({ data: [{ id: "gpt-5.5" }, { id: "gpt-image-2" }, { id: "dall-e-3" }, { id: "whisper-1" }] }));
        return;
      }
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: JPEG.toString("base64") }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

// Admin: the mock provider listens on 127.0.0.1, which non-admin connections may not reach.
db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'alice', 'unused', 'admin', ?)").run(Date.now());
db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'alice', ?)").run(sha256("alice"), Date.now() + 60_000);
const app = new Hono().use(requireUser).route("/", imageRoutes);
const call = (url: string, init: RequestInit = {}) => app.request(url, { ...init, headers: { Cookie: "okaychat_session=alice", "Content-Type": "application/json" } });

after(() => {
  server.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
  db.exec("DELETE FROM images; DELETE FROM provider_connections; DELETE FROM user_settings;");
  saveConnection("alice", "openai", { apiKey: "sk-openai", baseURL, enabled: true });
});

const execute = async (tools: ReturnType<typeof imageTools>, input: Record<string, unknown>) =>
  (tools.generate_image!.execute as (input: unknown, options: unknown) => Promise<unknown>)(input, { toolCallId: "c1", messages: [] });

test("a chat provider key enables image generation with the default model", () => {
  const services = enabledImageServices("alice", getSettings("alice"));
  assert.deepEqual(services.map((s) => [s.def.id, s.model]), [["openai", "gpt-image-2"]]);
});

test("one service: the tool has no service argument and stores the detected format", async () => {
  const tools = imageTools("alice", "thr_1", enabledImageServices("alice", getSettings("alice")));
  const shape = (tools.generate_image!.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
  assert.equal("service" in shape, false);

  const image = (await execute(tools, { prompt: "a red fox" })) as { id: string; mime: string; width: number; height: number; model: string };
  assert.equal(image.mime, "image/jpeg");
  assert.deepEqual([image.width, image.height], [2, 3]);
  assert.equal(image.model, "gpt-image-2");
  assert.equal(requests[0]!.url, "/v1/images/generations");
  assert.equal(requests[0]!.auth, "Bearer sk-openai");
  assert.equal(JSON.parse(requests[0]!.body).prompt, "a red fox");
  assert.deepEqual(readFileSync(imagePath("alice", image.id)), JPEG);

  const served = await call(`/images/${image.id}`);
  assert.equal(served.headers.get("content-type"), "image/jpeg");

  // A reference turns the call into an edit.
  await execute(tools, { prompt: "make it blue", reference_image_ids: [image.id] });
  assert.equal(requests[1]!.url, "/v1/images/edits");
});

test("several services: the tool requires a choice and tells the model to ask", async () => {
  const saved = (await (await call("/image-services/fal/key", { method: "PUT", body: JSON.stringify({ apiKey: "fal-key" }) })).json()) as ImageServiceStatus[];
  assert.equal(saved.find((s) => s.id === "fal")!.connected, true);
  updateSettings("alice", { imageServices: { openai: { model: "gpt-image-1.5" } } });

  const services = enabledImageServices("alice", getSettings("alice"));
  assert.deepEqual(services.map((s) => [s.def.id, s.model]), [["openai", "gpt-image-1.5"], ["fal", "fal-ai/flux-pro/kontext"]]);
  const tools = imageTools("alice", "thr_1", services);
  assert.match(tools.generate_image!.description!, /ask the user which service to use/);
  const schema = tools.generate_image!.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } };
  assert.equal(schema.safeParse({ prompt: "x" }).success, false);
  assert.equal(schema.safeParse({ prompt: "x", service: "openai" }).success, true);

  const image = (await execute(tools, { prompt: "x", service: "openai" })) as { model: string };
  assert.equal(image.model, "gpt-image-1.5");
  assert.equal(JSON.parse(requests[0]!.body).model, "gpt-image-1.5");

  await call("/image-services/fal/key", { method: "DELETE" });
  deleteConnection("alice", "openai");
  assert.deepEqual(enabledImageServices("alice", getSettings("alice")), []);
});

test("switched-off services are not offered and bad settings are rejected", () => {
  updateSettings("alice", { imageServices: { openai: { enabled: false } } });
  assert.deepEqual(enabledImageServices("alice", getSettings("alice")), []);
  assert.throws(() => updateSettings("alice", { imageServices: { midjourney: { enabled: true } } as never }));
  assert.throws(() => updateSettings("alice", { imageServices: { openai: { model: "" } } }));
});

test("the model picker lists the provider's image models and falls back without a list API", async () => {
  const openai = (await (await call("/image-services/openai/models")).json()) as { models: Array<{ id: string }>; live: boolean };
  assert.deepEqual(openai, { models: [{ id: "gpt-image-2" }, { id: "dall-e-3" }], live: true });
  assert.equal(requests.at(-1)!.auth, "Bearer sk-openai");

  await call("/image-services/black-forest-labs/key", { method: "PUT", body: JSON.stringify({ apiKey: "bfl-key" }) });
  const bfl = (await (await call("/image-services/black-forest-labs/models")).json()) as { models: Array<{ id: string }>; live: boolean };
  assert.equal(bfl.live, false);
  assert.equal(bfl.models[0]!.id, "flux-3-image");

  assert.equal((await call("/image-services/fal/models")).status, 400);
  assert.equal((await call("/image-services/codex/models")).status, 404);
});
