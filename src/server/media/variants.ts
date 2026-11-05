import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Context } from "hono";
import { MAX_IMAGE_PIXELS, VARIANTS, isVariant, variantPath, type VariantName } from "./store.js";

// Bounded display derivatives of raster originals: a finite set of long-edge sizes (no arbitrary resize
// cache), static WebP with transparency kept, EXIF orientation applied and metadata stripped. Originals
// are never changed; derivatives are a regenerable cache outside the user's quota. sharp loads on first
// use. SVG and anything that does not sniff as raster never reach it. See docs/implementation/media.md.

export interface ImageSource {
  /** Cache namespace: an account id for owned media, `ch-<channelId>` for channel attachments. */
  namespace: string;
  /** Cache key: a media id or a generated image id. Unique per original bytes. */
  key: string;
  file: string;
  mime: string;
  size: number;
  /** Validator of the original bytes (digest or immutable id). */
  etag: string;
}

const DECODABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
const CONCURRENCY = Math.max(1, Number(process.env.OKAYCHAT_MEDIA_CONCURRENCY) || 2);
const QUALITY: Record<VariantName, number> = { thumb: 70, medium: 78, large: 80 };

type Sharp = typeof import("sharp").default;
let sharpModule: Promise<Sharp> | null = null;
function loadSharp(): Promise<Sharp> {
  sharpModule ??= import("sharp").then((mod) => {
    const sharp = mod.default;
    // Our own queue bounds parallel work; libvips' operation cache would only hold decoded pixels in memory.
    sharp.cache(false);
    sharp.concurrency(1);
    return sharp;
  });
  return sharpModule;
}

let running = 0;
const waiting: Array<() => void> = [];
async function queued<T>(work: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const inflight = new Map<string, Promise<{ file: string; original: boolean }>>();

export class MediaProcessingError extends Error {}

/** Encodes one variant. Returns the original when the variant would not be smaller. */
export async function renderVariant(input: string | Buffer, variant: VariantName, originalSize: number): Promise<{ data: Buffer; width: number; height: number } | null> {
  const sharp = await loadSharp();
  const edge = VARIANTS[variant];
  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error", sequentialRead: true })
      .autoOrient()
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .webp({ quality: QUALITY[variant], alphaQuality: 90, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    return data.byteLength >= originalSize ? null : { data, width: info.width, height: info.height };
  } catch (error) {
    throw new MediaProcessingError((error as Error).message);
  }
}

/** Most frames an animated original may have; their pixels together stay within MAX_IMAGE_PIXELS too. */
export const MAX_FRAMES = 1000;

/**
 * Validates a raster by decoding every pixel of every frame inside libvips (`stats()` must read them all and
 * returns only per-channel numbers, so no raw buffer reaches JS), under the shared processing queue. The
 * pixel limit covers all frames together. A truncated or corrupt file is rejected. Returns the format,
 * frame count, and dimensions after orientation. The input is never changed.
 */
export async function inspectRaster(input: Buffer): Promise<{ format: string; width: number; height: number; pages: number; alpha: boolean }> {
  const sharp = await loadSharp();
  return queued(async () => {
    try {
      const image = sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error", animated: true });
      const meta = await image.metadata();
      if (!meta.format || !["png", "jpeg", "webp", "gif", "heif"].includes(meta.format) || !meta.width || !meta.height) throw new Error("not a supported raster");
      const pages = meta.pages ?? 1;
      if (pages > MAX_FRAMES) throw new Error(`more than ${MAX_FRAMES} frames`);
      // libvips' GIF decoder accepts a file cut off between frames; a complete GIF ends with its trailer byte.
      if (meta.format === "gif" && input.at(-1) !== 0x3b) throw new Error("truncated GIF");
      await image.stats();
      const frameHeight = meta.pageHeight ?? meta.height;
      const turned = (meta.orientation ?? 1) >= 5;
      return { format: meta.format, width: turned ? frameHeight : meta.width, height: turned ? meta.width : frameHeight, pages, alpha: !!meta.hasAlpha };
    } catch (error) {
      throw new MediaProcessingError((error as Error).message);
    }
  });
}

/** Re-encodes a profile picture: oriented, metadata stripped, at most 512 px, WebP. */
export async function normalizeAvatar(input: Buffer): Promise<Buffer> {
  const sharp = await loadSharp();
  try {
    return await queued(() => sharp(input, { limitInputPixels: 16_777_216, failOn: "error" })
      .autoOrient()
      .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85, alphaQuality: 90, effort: 4 })
      .toBuffer());
  } catch (error) {
    throw new MediaProcessingError((error as Error).message);
  }
}

/** The file to serve for a variant, generating it once (single flight) when missing. */
export async function variantFile(src: ImageSource, variant: VariantName): Promise<{ file: string; original: boolean }> {
  if (!DECODABLE.has(src.mime)) return { file: src.file, original: true };
  const webp = variantPath(src.namespace, src.key, variant, "webp");
  const marker = variantPath(src.namespace, src.key, variant, "orig");
  if (existsSync(webp)) return { file: webp, original: false };
  if (existsSync(marker)) return { file: src.file, original: true };
  const pending = inflight.get(webp);
  if (pending) return pending;
  const job = queued(async () => {
    const out = await renderVariant(src.file, variant, src.size);
    mkdirSync(path.dirname(webp), { recursive: true });
    if (!out) {
      // Small originals are served as they are; the marker remembers that without a second encode.
      writeFileSync(marker, "");
      return { file: src.file, original: true };
    }
    const temp = `${webp}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, out.data);
    await rename(temp, webp);
    return { file: webp, original: false };
  }).finally(() => inflight.delete(webp));
  inflight.set(webp, job);
  return job;
}

const matches = (header: string | undefined, etag: string) =>
  !!header && header.split(",").some((value) => value.trim().replace(/^W\//, "") === etag);

/**
 * Serves an original or one of its variants with a validator. Callers authorize first: nothing here
 * looks at ownership, and a 304 is only reachable after that check. `no-cache` keeps every reuse a
 * conditional request to us, so revocation and account switches always apply.
 */
export async function serveImage(
  c: Context,
  src: ImageSource,
  opts: { headers?: Record<string, string>; cacheControl?: string } = {},
): Promise<Response> {
  const requested = c.req.query("variant");
  if (requested !== undefined && !isVariant(requested)) return c.json({ error: "Unknown image size" }, 400);
  const variant = requested as VariantName | undefined;
  if (!existsSync(src.file)) return c.json({ error: "Not found" }, 404);
  let chosen: { file: string; original: boolean } = { file: src.file, original: true };
  if (variant) {
    try {
      chosen = await variantFile(src, variant);
    } catch (error) {
      if (!(error instanceof MediaProcessingError)) throw error;
      // A damaged or unsupported original: the client shows its fallback with an explicit Open original.
      return c.json({ error: "No preview is available for this image." }, 422);
    }
  }
  const etag = `"${src.etag}${chosen.original ? "" : `-${variant}`}"`;
  const headers: Record<string, string> = {
    ...opts.headers,
    "Content-Type": chosen.original ? src.mime : "image/webp",
    "Cache-Control": opts.cacheControl ?? "private, no-cache",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    Vary: "Cookie",
  };
  if (matches(c.req.header("If-None-Match"), etag)) return new Response(null, { status: 304, headers });
  let size: number;
  try {
    size = statSync(chosen.file).size;
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
  const stream = Readable.toWeb(createReadStream(chosen.file)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, "Content-Length": String(size) } });
}
