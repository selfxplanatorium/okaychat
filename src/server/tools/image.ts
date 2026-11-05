import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
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
import { tx } from "../db.js";
import { getMedia, mediaPath, removeVariants } from "../media/store.js";
import { sniffRaster, type RasterMime } from "../media/sniff.js";
import { inspectRaster, MediaProcessingError, serveImage } from "../media/variants.js";
import { assertFeature } from "../permissions/guard.js";
import { reserveOperation } from "../permissions/limits.js";

// Image generation through one of several services: the user's own ChatGPT plan (by running `codex exec`
// as a relay that only calls Codex's built-in image tool), or an image API reached with the user's key.
// See docs/implementation/image-generation.md and docs/implementation/codex-images.md.

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

type ImageMime = RasterMime;

// Every format keeps the `.png` name so older paths stay valid. The `mime` column is authoritative.
export const imagePath = (userId: string, id: string) => path.join(IMAGE_DIR, userId, `${id}.png`);

/** Detect the format from magic bytes. A provider's own media type is never trusted for serving. */
const sniff = (buf: Buffer): ImageMime | null => sniffRaster(buf);

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

// Image-only providers load when an image is first generated with them; OpenAI and Google are loaded for chat anyway.
async function imageModel(service: ImageService): Promise<ImageModel> {
  const { apiKey, baseURL, guarded } = service.conn!;
  const settings = { apiKey, baseURL, headers: { "User-Agent": USER_AGENT }, fetch: guarded ? publicFetch : undefined };
  const model = service.model!;
  switch (service.def.id) {
    case "openai":
      return createOpenAI(settings).image(model);
    case "google":
      return createGoogleGenerativeAI(settings).image(model);
    case "xai":
      return (await import("@ai-sdk/xai")).createXai(settings).image(model);
    case "togetherai":
      return (await import("@ai-sdk/togetherai")).createTogetherAI(settings).image(model);
    case "black-forest-labs":
      return (await import("@ai-sdk/black-forest-labs")).createBlackForestLabs(settings).image(model);
    case "fal":
      return (await import("@ai-sdk/fal")).createFal(settings).image(model);
    case "replicate":
      return (await import("@ai-sdk/replicate")).createReplicate({ apiToken: apiKey, baseURL, headers: settings.headers, fetch: settings.fetch }).image(model);
    case "codex":
      throw new Error("Codex has no image API.");
  }
}

async function generateWithApi(service: ImageService, prompt: string, references: string[], signal?: AbortSignal): Promise<Buffer> {
  const images = await Promise.all(references.map((r) => readFile(r)));
  const abortSignal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
  try {
    const result = await generateWithModel({
      model: await imageModel(service),
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

/**
 * Reference images for an edit: earlier generated images (`img_…`) or the user's own attached images (the
 * `file_id` of an image attachment). Both only from this account; the original bytes are used, never a preview.
 */
export function referencePaths(userId: string, ids: string[]): string[] {
  return ids.map((id) => {
    if (db.prepare("SELECT id FROM images WHERE id = ? AND user_id = ?").get(id, userId)) return imagePath(userId, id);
    const upload = db.prepare("SELECT media_id FROM uploads WHERE id = ? AND user_id = ?").get(id, userId) as { media_id: string | null } | undefined;
    const media = upload?.media_id ? getMedia(upload.media_id) : undefined;
    if (media && media.user_id === userId) return mediaPath(media);
    throw new Error(`Unknown reference image \`${id}\`. Use ids returned by generate_image or the file_id of an attached image.`);
  });
}

export async function generateImage(opts: { userId: string; threadId: string; service: ImageService; prompt: string; references: string[]; signal?: AbortSignal }): Promise<GeneratedImage> {
  // Image generation is a policy decision, not just a credential one: own keys and Codex do not bypass it.
  assertFeature(opts.userId, "images");
  const lease = reserveOperation({ userId: opts.userId }, "image.generate");
  try {
    const references = referencePaths(opts.userId, opts.references);
    const buf = opts.service.def.credential === "codex"
      ? await generateWithCodex(opts.userId, opts.prompt, references, opts.signal)
      : await generateWithApi(opts.service, opts.prompt, references, opts.signal);
    const stored = await storeImage(opts.userId, opts.threadId, buf, opts.prompt);
    if (!stored) throw new Error(`${opts.service.def.name} did not return a PNG, JPEG, WebP, GIF, or AVIF image.`);
    return { ...stored, service: opts.service.def.name, model: opts.service.model };
  } finally {
    lease.release();
  }
}

/**
 * Saves a raster image to the thread's images (Library, quota, thread deletion). Returns null when the
 * bytes are not a raster image that fully decodes within the pixel limit. `label` is the prompt column:
 * the request or the image's source.
 */
export async function storeImage(userId: string, threadId: string, buf: Buffer, label: string): Promise<StoredImage | null> {
  const mime = sniff(buf);
  if (!mime) return null;
  let size: { width: number; height: number };
  try {
    size = await inspectRaster(buf);
  } catch (error) {
    if (error instanceof MediaProcessingError) return null;
    throw error;
  }
  // The model sees the quota message; nothing is written before the check.
  assertStorage(userId, buf.length);
  const id = newId("img");
  const file = imagePath(userId, id);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${id}`;
  await writeFile(temp, buf);
  await rename(temp, file);
  try {
    // Other writes may have used the space during the await; check again right before the charge is recorded.
    tx(() => {
      assertStorage(userId, buf.length);
      db.prepare("INSERT INTO images (id, user_id, thread_id, prompt, width, height, size, mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id, userId, threadId, label, size.width, size.height, buf.length, mime, Date.now(),
      );
      if (db.prepare("SELECT 1 FROM threads WHERE id = ? AND user_id = ?").get(threadId, userId)) {
        db.prepare("INSERT INTO image_threads (image_id, thread_id) VALUES (?, ?)").run(id, threadId);
      }
    });
  } catch (error) {
    // Quota, a deleted chat, or a failed insert: no row means no file.
    await rm(file, { force: true });
    throw error;
  }
  return { id, url: `/api/images/${id}`, mime, width: size.width, height: size.height };
}

/** Deletes one generated image: metadata first, then its file and derivatives. */
export async function deleteImage(userId: string, id: string): Promise<boolean> {
  if (!db.prepare("DELETE FROM images WHERE id = ? AND user_id = ?").run(id, userId).changes) return false;
  await rm(imagePath(userId, id), { force: true });
  removeVariants(userId, id);
  return true;
}

/**
 * Generated images live while a chat shows them. Called after a thread is deleted (its image_threads rows
 * are gone by cascade): an image a fork still references survives.
 */
export async function deleteThreadImages(userId: string, _threadId: string) {
  const rows = db.prepare("SELECT id FROM images i WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM image_threads r WHERE r.image_id = i.id)").all(userId) as Array<{ id: string }>;
  for (const row of rows) await deleteImage(userId, row.id);
}

const PROMPT_RULES =
  "Pass the user's image request in their own words, verbatim where possible. Only light cleanup or resolving references from the conversation is allowed; preserve their meaning and level of detail. Do not add visual details such as subjects, composition, style, lighting, colors, text, or aspect ratio unless the user supplied them or explicitly asked you to embellish the prompt. A short or vague request is valid. If you want to embellish it, ask the user first; otherwise generate it as given. To edit or keep consistency with earlier images, pass their ids as references; an image the user attached is referenced by its file_id. Takes up to a minute or two. The image is shown to the user; do not describe it back in full.";

const serviceLabel = (s: ImageService) => `\`${s.def.id}\`: ${s.def.name}${s.model ? ` (${s.model})` : ""}`;

/** `services` must be non-empty. The description lists them, so it only changes when the user's choices do. */
export function imageTools(userId: string, threadId: string, services: ImageService[], signal?: AbortSignal): ToolSet {
  const base = {
    prompt: z.string().min(1).describe("The user's image request, verbatim or lightly cleaned up. No invented visual details unless the user explicitly requested embellishment."),
    reference_image_ids: z.array(z.string()).max(8).optional().describe("Images to edit or use as references, in order: ids returned by generate_image, or the file_id of an image the user attached"),
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
    const row = db.prepare("SELECT id, mime, size FROM images WHERE id = ? AND user_id = ?").get(c.req.param("id"), user.id) as { id: string; mime: string; size: number } | undefined;
    if (!row) return c.json({ error: "Not found" }, 404);
    // Generated images never change, so the id is the validator.
    return serveImage(c, { namespace: user.id, key: row.id, file: imagePath(user.id, row.id), mime: row.mime, size: row.size, etag: row.id });
  })
  .get("/image-services", (c) => c.json(imageServiceStatuses(c.get("user").id)))
  .get("/image-services/:id/models", async (c) => {
    assertFeature(c.get("user").id, "images");
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
