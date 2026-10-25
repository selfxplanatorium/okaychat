import { spawn } from "node:child_process";
import { createReadStream, mkdirSync } from "node:fs";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createBlackForestLabs } from "@ai-sdk/black-forest-labs";
import { createFal } from "@ai-sdk/fal";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createReplicate } from "@ai-sdk/replicate";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createXai } from "@ai-sdk/xai";
import { generateImage as generateWithModel, tool, type ImageModel, type ToolSet } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import { IMAGE_SERVICES, imageConnectionId, imageServiceDef, type ImageServiceDef, type ImageServiceStatus } from "../../shared/image-services.js";
import type { UserSettings } from "../../shared/types.js";
import type { AppEnv } from "../auth.js";
import { deleteConnection, getConnection, saveConnection, type Connection } from "../catalog/providers.js";
import { CODEX_COMMAND, codexEnv, codexVersion, disconnect, isConnected, loginStatus, startLogin, withCodexHome } from "../codex.js";
import { newId } from "../crypto.js";
import { db } from "../db.js";
import { env, USER_AGENT } from "../env.js";
import { assertStorage } from "../quota.js";
import { promptText } from "../prompts.js";
import { listImageModels } from "./image-models.js";
import { publicFetch } from "../public-fetch.js";
import { getSettings } from "../settings.js";

// Image generation through one of several services: the user's own ChatGPT plan (by running `codex exec`
// as a relay that only calls Codex's built-in image tool), or an image API reached with the user's key.
// See docs/research/image-generation.md and docs/research/codex-images.md.

const IMAGE_DIR = path.join(env.dataDir, "images");
const TIMEOUT_MS = 5 * 60_000;
const RELAY_MODEL = "gpt-5.6-luna";

const OUTPUT_SCHEMA = {
  type: "object",
  properties: { generated_png_paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1 } },
  required: ["generated_png_paths"],
  additionalProperties: false,
};

const RELAY_FLAGS = [
  "--skip-git-repo-check",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "-c",
  "skills.include_instructions=false",
  "-c",
  'web_search="disabled"',
  "--enable",
  "skip_host_skill_discovery",
  "--sandbox",
  "read-only",
  ...["memories", "goals", "shell_tool", "unified_exec", "hooks", "plugins", "apps", "browser_use", "computer_use", "multi_agent"].flatMap((f) => ["--disable", f]),
  "--color",
  "never",
];

mkdirSync(IMAGE_DIR, { recursive: true });

export interface StoredImage {
  id: string;
  url: string;
  mime: ImageMime;
  width: number | null;
  height: number | null;
}

export interface GeneratedImage extends StoredImage {
  service: string;
  model: string | null;
}

type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

// Every format keeps the `.png` name so older paths stay valid. The `mime` column is authoritative.
export const imagePath = (userId: string, id: string) => path.join(IMAGE_DIR, userId, `${id}.png`);

/** Detect the format from magic bytes. A provider's own media type is never trusted for serving. */
function sniff(buf: Buffer): ImageMime | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  return null;
}

function dimensions(buf: Buffer, mime: ImageMime): { width: number; height: number } | null {
  try {
    switch (mime) {
      // IHDR: width and height are big-endian at bytes 16 and 20.
      case "image/png":
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      case "image/gif":
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      case "image/webp": {
        const chunk = buf.toString("latin1", 12, 16);
        if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
        if (chunk === "VP8L") {
          const bits = buf.readUInt32LE(21);
          return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
        }
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      case "image/jpeg": {
        // Walk the segments to the first start-of-frame marker.
        let i = 2;
        while (i + 9 < buf.length) {
          if (buf[i] !== 0xff) return null;
          const marker = buf[i + 1]!;
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
          i += 2 + buf.readUInt16BE(i + 2);
        }
        return null;
      }
    }
  } catch {
    return null;
  }
}

/** Codex prints `ERROR: {json}` lines. Return only the message, never the transcript, which echoes the prompt. */
function codexError(stderr: string): string {
  for (const line of stderr.split("\n")) {
    if (!line.startsWith("ERROR: {")) continue;
    try {
      const message = (JSON.parse(line.slice(7)) as { error?: { message?: string } }).error?.message;
      if (message) return message.replace(/\s+/g, " ").slice(0, 300);
    } catch {
      // Not JSON. Keep looking.
    }
  }
  return "";
}

function run(args: string[], home: string, prompt: string, signal?: AbortSignal): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_COMMAND, args, { env: codexEnv(home), cwd: home, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort);
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ code, stderr });
    });
    child.stdin.end(prompt);
  });
}

/** Runs one Codex relay and returns the PNG it produced. */
async function generateWithCodex(userId: string, prompt: string, references: string[], signal?: AbortSignal): Promise<Buffer> {
  if (!(await codexVersion())) throw new Error("The Codex CLI is not installed on this server.");
  return withCodexHome(userId, async (home) => {
    const schema = path.join(home, "schema.json");
    const instructions = path.join(home, "relay.txt");
    const last = path.join(home, "last-message.json");
    await writeFile(schema, JSON.stringify(OUTPUT_SCHEMA));
    await writeFile(instructions, promptText("imageRelay"));
    const args = [
      ...RELAY_FLAGS,
      "-c",
      `model_instructions_file=${JSON.stringify(instructions)}`,
      "--cd",
      home,
      "--output-schema",
      schema,
      "--output-last-message",
      last,
      ...references.flatMap((r) => ["--image", r]),
      "--",
      "-",
    ];
    // The `$imagegen` mention invokes Codex's built-in image skill.
    const brief = `$imagegen\n\n${prompt}`;
    let result = await run(["exec", "-m", RELAY_MODEL, "-c", 'model_reasoning_effort="none"', ...args], home, brief, signal);
    // The light relay model is not on every plan. One retry with the account default.
    if (result.code !== 0 && codexError(result.stderr).includes("model is not supported")) {
      result = await run(["exec", ...args], home, brief, signal);
    }
    if (signal?.aborted) throw new Error("Cancelled.");
    if (result.code !== 0) throw new Error(`Codex failed${codexError(result.stderr) ? `: ${codexError(result.stderr)}` : ` (exit ${result.code}).`}`);

    const paths = (JSON.parse(await readFile(last, "utf8")) as { generated_png_paths?: string[] }).generated_png_paths ?? [];
    const root = await realpath(path.join(home, "generated_images"));
    // Accept only a real PNG inside CODEX_HOME/generated_images. Anything else could point at another file.
    const file = paths[0] ? await realpath(paths[0]).catch(() => null) : null;
    const buf = file && file.startsWith(root + path.sep) ? await readFile(file) : null;
    if (!buf || sniff(buf) !== "image/png") throw new Error("Codex did not return a generated PNG.");
    return buf;
  });
}

/** An image service the user can generate with right now. */
export interface ImageService {
  def: ImageServiceDef;
  /** Null for Codex, whose backend picks the model. */
  model: string | null;
  conn?: Connection;
}

function connectionFor(userId: string, def: ImageServiceDef): Connection | undefined {
  if (def.credential === "codex") return undefined;
  const conn = getConnection(userId, imageConnectionId(def));
  return conn?.enabled && conn.apiKey ? conn : undefined;
}

export function imageServiceStatuses(userId: string, settings: UserSettings = getSettings(userId)): ImageServiceStatus[] {
  return IMAGE_SERVICES.map((def) => {
    const choice = settings.imageServices?.[def.id];
    const conn = connectionFor(userId, def);
    return {
      id: def.id,
      name: def.name,
      credential: def.credential,
      keyUrl: def.keyUrl,
      connected: def.credential === "codex" ? isConnected(userId) : !!conn,
      shared: !!conn?.shared,
      enabled: choice?.enabled ?? true,
      model: def.credential === "codex" ? null : (choice?.model ?? def.models[0] ?? null),
    };
  });
}

export function enabledImageServices(userId: string, settings: UserSettings): ImageService[] {
  return imageServiceStatuses(userId, settings)
    .filter((s) => s.connected && s.enabled)
    .map((s) => {
      const def = imageServiceDef(s.id)!;
      return { def, model: s.model, conn: connectionFor(userId, def) };
    });
}

function imageModel(service: ImageService): ImageModel {
  const { apiKey, baseURL, guarded } = service.conn!;
  const settings = { apiKey, baseURL, headers: { "User-Agent": USER_AGENT }, fetch: guarded ? publicFetch : undefined };
  const model = service.model!;
  switch (service.def.id) {
    case "openai":
      return createOpenAI(settings).image(model);
    case "google":
      return createGoogleGenerativeAI(settings).image(model);
    case "xai":
      return createXai(settings).image(model);
    case "togetherai":
      return createTogetherAI(settings).image(model);
    case "black-forest-labs":
      return createBlackForestLabs(settings).image(model);
    case "fal":
      return createFal(settings).image(model);
    case "replicate":
      return createReplicate({ apiToken: apiKey, baseURL, headers: settings.headers, fetch: settings.fetch }).image(model);
    case "codex":
      throw new Error("Codex has no image API.");
  }
}

async function generateWithApi(service: ImageService, prompt: string, references: string[], signal?: AbortSignal): Promise<Buffer> {
  const images = await Promise.all(references.map((r) => readFile(r)));
  const abortSignal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
  try {
    const result = await generateWithModel({
      model: imageModel(service),
      prompt: images.length ? { text: prompt, images } : prompt,
      // A retry bills a second image, so allow only one.
      maxRetries: 1,
      abortSignal,
    });
    return Buffer.from(result.image.uint8Array);
  } catch (error) {
    if (signal?.aborted) throw new Error("Cancelled.");
    const message = (error as Error).message.replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`${service.def.name} failed: ${message}`);
  }
}

export async function generateImage(opts: { userId: string; threadId: string; service: ImageService; prompt: string; references: string[]; signal?: AbortSignal }): Promise<GeneratedImage> {
  const references = opts.references.map((id) => {
    const row = db.prepare("SELECT id FROM images WHERE id = ? AND user_id = ?").get(id, opts.userId);
    if (!row) throw new Error(`Unknown reference image \`${id}\`. Use ids returned by generate_image.`);
    return imagePath(opts.userId, id);
  });
  const buf = opts.service.def.credential === "codex"
    ? await generateWithCodex(opts.userId, opts.prompt, references, opts.signal)
    : await generateWithApi(opts.service, opts.prompt, references, opts.signal);
  const stored = await storeImage(opts.userId, opts.threadId, buf, opts.prompt);
  if (!stored) throw new Error(`${opts.service.def.name} did not return a PNG, JPEG, WebP, or GIF image.`);
  return { ...stored, service: opts.service.def.name, model: opts.service.model };
}

/**
 * Saves a raster image to the thread's images (Library, quota, thread deletion). Returns null when the
 * bytes are not PNG, JPEG, WebP, or GIF. `label` is the prompt column: the request or the image's source.
 */
export async function storeImage(userId: string, threadId: string, buf: Buffer, label: string): Promise<StoredImage | null> {
  const mime = sniff(buf);
  if (!mime) return null;
  // The model sees the quota message; nothing is written before the check.
  assertStorage(userId, buf.length);
  const size = dimensions(buf, mime);
  const id = newId("img");
  mkdirSync(path.join(IMAGE_DIR, userId), { recursive: true });
  await writeFile(imagePath(userId, id), buf);
  db.prepare("INSERT INTO images (id, user_id, thread_id, prompt, width, height, size, mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    userId,
    threadId,
    label,
    size?.width ?? null,
    size?.height ?? null,
    buf.length,
    mime,
    Date.now(),
  );
  return { id, url: `/api/images/${id}`, mime, width: size?.width ?? null, height: size?.height ?? null };
}

/** Generated images belong to their thread. Called when a thread is deleted. */
export async function deleteThreadImages(userId: string, threadId: string) {
  const rows = db.prepare("SELECT id FROM images WHERE user_id = ? AND thread_id = ?").all(userId, threadId) as Array<{ id: string }>;
  db.prepare("DELETE FROM images WHERE user_id = ? AND thread_id = ?").run(userId, threadId);
  await Promise.all(rows.map((r) => rm(imagePath(userId, r.id), { force: true })));
}

const PROMPT_RULES =
  "Pass the user's image request in their own words, verbatim where possible. Only light cleanup or resolving references from the conversation is allowed; preserve their meaning and level of detail. Do not add visual details such as subjects, composition, style, lighting, colors, text, or aspect ratio unless the user supplied them or explicitly asked you to embellish the prompt. A short or vague request is valid. If you want to embellish it, ask the user first; otherwise generate it as given. To edit or keep consistency with earlier images, pass their ids as references. Takes up to a minute or two. The image is shown to the user; do not describe it back in full.";

const serviceLabel = (s: ImageService) => `\`${s.def.id}\`: ${s.def.name}${s.model ? ` (${s.model})` : ""}`;

/** `services` must be non-empty. The description lists them, so it only changes when the user's choices do. */
export function imageTools(userId: string, threadId: string, services: ImageService[], signal?: AbortSignal): ToolSet {
  const base = {
    prompt: z.string().min(1).describe("The user's image request, verbatim or lightly cleaned up. No invented visual details unless the user explicitly requested embellishment."),
    reference_image_ids: z.array(z.string()).max(8).optional().describe("Ids of earlier generated images to edit or use as references, in order"),
  };
  if (services.length === 1) {
    const only = services[0]!;
    return {
      generate_image: tool({
        description: `Generate or edit an image with ${serviceLabel(only)}. ${PROMPT_RULES}`,
        inputSchema: z.object(base),
        execute: ({ prompt, reference_image_ids }) => generateImage({ userId, threadId, service: only, prompt, references: reference_image_ids ?? [], signal }),
      }),
    };
  }
  const ids = services.map((s) => s.def.id) as [string, ...string[]];
  return {
    generate_image: tool({
      description:
        `Generate or edit an image. The user has several image services enabled:\n${services.map((s) => `- ${serviceLabel(s)}`).join("\n")}\n` +
        "Before the first image in this conversation, ask the user which service to use and wait for the answer, unless they already named one. Never pick one yourself. Afterwards keep using their choice until they ask for another. " +
        PROMPT_RULES,
      inputSchema: z.object({ service: z.enum(ids).describe("The image service the user chose"), ...base }),
      execute: ({ service, prompt, reference_image_ids }) =>
        generateImage({ userId, threadId, service: services.find((s) => s.def.id === service)!, prompt, references: reference_image_ids ?? [], signal }),
    }),
  };
}

export const imageRoutes = new Hono<AppEnv>()
  .get("/images/:id", async (c) => {
    const user = c.get("user");
    const row = db.prepare("SELECT id, mime FROM images WHERE id = ? AND user_id = ?").get(c.req.param("id"), user.id) as { id: string; mime: string } | undefined;
    if (!row) return c.json({ error: "Not found" }, 404);
    const stream = Readable.toWeb(createReadStream(imagePath(user.id, row.id))) as ReadableStream;
    return new Response(stream, { headers: { "Content-Type": row.mime, "Cache-Control": "private, no-store" } });
  })
  .get("/image-services", (c) => c.json(imageServiceStatuses(c.get("user").id)))
  .get("/image-services/:id/models", async (c) => {
    const def = imageServiceDef(c.req.param("id"));
    if (!def || def.credential === "codex") return c.json({ error: "Not found" }, 404);
    const conn = connectionFor(c.get("user").id, def);
    if (!conn) return c.json({ error: `Connect ${def.name} first.` }, 400);
    return c.json(await listImageModels(def, conn));
  })
  .put("/image-services/:id/key", async (c) => {
    const def = imageServiceDef(c.req.param("id"));
    if (def?.credential !== "own") return c.json({ error: "This service has no image-only key. Connect its provider instead." }, 400);
    const body = (await c.req.json().catch(() => null)) as { apiKey?: unknown } | null;
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey || apiKey.length > 500) return c.json({ error: "Enter an API key." }, 400);
    saveConnection(c.get("user").id, imageConnectionId(def), { apiKey, enabled: true });
    return c.json(imageServiceStatuses(c.get("user").id));
  })
  .delete("/image-services/:id/key", (c) => {
    const def = imageServiceDef(c.req.param("id"));
    if (def?.credential !== "own") return c.json({ error: "Not found" }, 404);
    deleteConnection(c.get("user").id, imageConnectionId(def));
    return c.json(imageServiceStatuses(c.get("user").id));
  })
  .get("/codex", async (c) => {
    const userId = c.get("user").id;
    return c.json({ version: await codexVersion(), connected: isConnected(userId), login: loginStatus(userId) });
  })
  .post("/codex/login", async (c) => {
    if (!(await codexVersion())) return c.json({ error: "The Codex CLI is not installed on this server." }, 400);
    try {
      return c.json(await startLogin(c.get("user").id));
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500);
    }
  })
  .delete("/codex", (c) => {
    disconnect(c.get("user").id);
    return c.json({ ok: true });
  });
