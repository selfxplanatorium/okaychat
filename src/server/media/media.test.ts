import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { UIMessage, UIMessageChunk } from "ai";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-media-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "media-test-secret-only-not-for-production";
const { default: sharp } = await import("sharp");
const { db } = await import("../db.js");
const { requireUser } = await import("../auth.js");
const { sha256 } = await import("../crypto.js");
const { fileRoutes, storeUpload } = await import("../files.js");
const { libraryRoutes } = await import("../library.js");
const { imageRoutes, imagePath, storeImage, deleteThreadImages, referencePaths } = await import("../tools/image.js");
const { publicShareRoutes } = await import("../shares.js");
const { appendMessage, branchThread, deleteThread, ensureThread, listMessagesJson } = await import("../threads.js");
const { resolveImageRefs, uploadRef } = await import("./refs.js");
const { storedImageChunks } = await import("./stream.js");
const { MEDIA_DIR, mediaPath, getMedia, putMedia } = await import("./store.js");
const { collectMediaGarbage, migrateMediaBatch } = await import("./maintenance.js");
const { messageBytes, storageUsed } = await import("../quota.js");
const { inspectRaster, MAX_FRAMES, MediaProcessingError } = await import("./variants.js");
const { estimateTokens, FILE_TOKENS } = await import("../compaction.js");

const app = new Hono().use(requireUser).route("/", fileRoutes).route("/", libraryRoutes).route("/", imageRoutes);
const publicApp = new Hono().route("/shares", publicShareRoutes);
for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 60_000);
}
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  db.exec("DELETE FROM shares; DELETE FROM messages; DELETE FROM images; DELETE FROM uploads; DELETE FROM sandbox_files; DELETE FROM threads; DELETE FROM media; DELETE FROM server_settings WHERE key LIKE 'media_migration:%'; UPDATE users SET storage_limit = NULL");
});

const get = (url: string, user = "alice", headers: Record<string, string> = {}) =>
  app.request(`http://app${url}`, { headers: { cookie: `okaychat_session=${user}`, ...headers } });
const bytes = async (response: Response) => Buffer.from(await response.arrayBuffer());

async function streamImages(threadId: string, chunks: UIMessageChunk[]): Promise<UIMessageChunk[]> {
  const stream = new ReadableStream<UIMessageChunk>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } }).pipeThrough(storedImageChunks("alice", threadId, () => "Image storage failed."));
  const result: UIMessageChunk[] = [];
  for await (const chunk of stream) result.push(chunk);
  return result;
}

test("provider images reach the live browser as references, while temporary streams persist nothing", async () => {
  ensureThread("alice", "streamed");
  const original = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#42814c" } }).png().toBuffer();
  const image: UIMessageChunk = { type: "file", mediaType: "image/png", url: `data:image/png;base64,${original.toString("base64")}` };
  assert.deepEqual(await streamImages("tmp_private", [image]), [image]);
  assert.equal(count("uploads"), 0);
  const chunks = await streamImages("streamed", [image, { type: "finish" }]);
  assert.equal(chunks[0]!.type, "file");
  assert.doesNotMatch(JSON.stringify(chunks), /base64/);
  assert.deepEqual(chunks[1], { type: "finish" });
  const content = { role: "assistant", parts: [chunks[0]] };
  appendMessage("alice", "streamed", { id: "reply", parent_id: null, format: "ai-sdk/v6", content });
  assert.equal(count("uploads"), 1, "saving the streamed reference never copies its original again");
  const [resolved] = await resolveImageRefs("alice", [{ id: "reply", ...content } as UIMessage]);
  assert.equal((resolved!.parts[0] as { url: string }).url, image.url);
});

test("a streamed image storage failure reports an error without sending original bytes", async () => {
  ensureThread("alice", "streamed");
  db.prepare("UPDATE users SET storage_limit = 0 WHERE id = 'alice'").run();
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#42814c" } }).png().toBuffer();
  const chunks = await streamImages("streamed", [{ type: "file", mediaType: "image/png", url: `data:image/png;base64,${png.toString("base64")}` }, { type: "finish" }]);
  assert.deepEqual(chunks, [{ type: "error", errorText: "Image storage failed." }, { type: "finish" }]);
  assert.equal(count("uploads"), 0);
});

/**
 * A UI screenshot at 2x: flat panels plus lines of anti-aliased "glyphs" (varied grey edges), which is what
 * makes real screenshot PNGs large.
 */
async function screenshot(): Promise<Buffer> {
  const width = 2560, height = 1600;
  const raw = Buffer.alloc(width * height * 3, 246);
  let seed = 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (x < 420) { raw.fill(36, i, i + 3); continue; }
      const line = y % 44;
      if (line > 10 && line < 32 && x > 480 && x < 2400 && (x >> 4) % 9 !== 0) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        // Glyph strokes with soft edges in a few tints.
        if (seed % 3 === 0) raw.set([60 + (seed % 120), 60 + (seed % 90), 70 + (seed % 100)], i);
      }
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** A photo-like image: smooth gradients with sensor-like noise, as a high-quality JPEG. */
async function photo(): Promise<Buffer> {
  const width = 2400, height = 1600;
  const raw = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let i = 0; i < raw.length; i += 3) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const p = i / 3, x = p % width, y = Math.floor(p / width), n = (seed % 25) - 12;
    raw[i] = Math.max(0, Math.min(255, (x / width) * 200 + 30 + n));
    raw[i + 1] = Math.max(0, Math.min(255, (y / height) * 180 + 40 + n));
    raw[i + 2] = Math.max(0, Math.min(255, 128 + 100 * Math.sin(x / 90) * Math.cos(y / 70) + n));
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

const userImage = (id: string, url: string, filename = "photo.png") =>
  ({ id, parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "file", mediaType: "image/png", filename, url }, { type: "text", text: "What is this?" }] } });

test("uploaded originals round-trip byte for byte, live in files, and are never in SQLite", async () => {
  const original = await screenshot();
  const id = storeUpload("alice", "screen.png", "image/png", original);
  const row = db.prepare("SELECT length(data) AS n, media_id, mime FROM uploads WHERE id = ?").get(id) as { n: number; media_id: string; mime: string };
  assert.equal(row.n, 0);
  assert.equal(row.mime, "image/png");
  const media = getMedia(row.media_id)!;
  assert.ok(existsSync(mediaPath(media)));
  const served = await get(`/uploads/${id}/file`);
  assert.equal(served.status, 200);
  assert.deepEqual(await bytes(served), original);
  assert.equal(served.headers.get("cache-control"), "private, no-cache");
  // Identical bytes are stored and charged once per account.
  const again = storeUpload("alice", "copy.png", "image/png", original);
  assert.notEqual(again, id);
  assert.equal((db.prepare("SELECT count(*) AS n FROM media").get() as { n: number }).n, 1);
  assert.equal(storageUsed("alice"), original.byteLength);
  // Another account never shares the stored copy.
  storeUpload("bob", "screen.png", "image/png", original);
  assert.equal((db.prepare("SELECT count(*) AS n FROM media").get() as { n: number }).n, 2);
});

test("variants are bounded, smaller, transparent where the original is, and static for animations", async () => {
  for (const [name, original] of [["screen.png", await screenshot()], ["photo.jpg", await photo()]] as const) {
    const id = storeUpload("alice", name, "image/png", original);
    let previous = 0;
    for (const [variant, edge] of [["thumb", 256], ["medium", 640], ["large", 1280]] as const) {
      const response = await get(`/uploads/${id}/file?variant=${variant}`);
      assert.equal(response.status, 200, `${name} ${variant}`);
      assert.equal(response.headers.get("content-type"), "image/webp");
      const body = await bytes(response);
      const meta = await sharp(body).metadata();
      assert.equal(Math.max(meta.width!, meta.height!), edge, `${name} ${variant} long edge`);
      assert.ok(body.byteLength < original.byteLength / 2, `${name} ${variant}: ${body.byteLength} vs ${original.byteLength}`);
      if (process.env.MEDIA_SIZES) console.log(`${name} ${original.byteLength} -> ${variant} ${body.byteLength}`);
      assert.ok(body.byteLength > previous);
      previous = body.byteLength;
    }
    assert.equal((await get(`/uploads/${id}/file?variant=huge`)).status, 400, "only the finite variant names exist");
  }
  const alpha = await sharp({ create: { width: 900, height: 600, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 0.3 } } }).png().toBuffer();
  const transparent = await bytes(await get(`/uploads/${storeUpload("alice", "glass.png", "image/png", alpha)}/file?variant=medium`));
  assert.equal((await sharp(transparent).metadata()).hasAlpha, true);

  const frames = Buffer.alloc(320 * 320 * 3 * 4);
  for (let i = 0; i < frames.length; i += 4) frames.set([Math.floor(i / (320 * 320 * 4)) * 90, (i / 4) % 251, 100, 255], i);
  const gif = await sharp(frames, { raw: { width: 320, height: 960, channels: 4, pageHeight: 320 } }).gif().toBuffer();
  const animated = storeUpload("alice", "anim.gif", "image/gif", gif);
  assert.equal((await sharp(await bytes(await get(`/uploads/${animated}/file?variant=thumb`)), { animated: true }).metadata()).pages ?? 1, 1);
  assert.equal((await sharp(await bytes(await get(`/uploads/${animated}/file`)), { animated: true }).metadata()).pages, 3, "the original keeps its frames");
});

test("orientation is applied to variants, and a variant is never bigger than its original", async () => {
  const rotated = await sharp({ create: { width: 900, height: 300, channels: 3, background: "#204080" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const meta = await sharp(await bytes(await get(`/uploads/${storeUpload("alice", "phone.jpg", "image/jpeg", rotated)}/file?variant=medium`))).metadata();
  assert.deepEqual([meta.width, meta.height], [213, 640]);
  const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const response = await get(`/uploads/${storeUpload("alice", "dot.png", "image/png", tiny)}/file?variant=thumb`);
  const body = await bytes(response);
  // A variant is never bigger than its original: when encoding would not shrink it, the original is served.
  assert.ok(body.byteLength <= tiny.byteLength);
  if (response.headers.get("content-type") === "image/png") assert.deepEqual(body, tiny);
  // A 1×1 GIF beats any WebP encoding, so the original is served (and remembered without a second encode).
  const gif = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#f00" } }).gif().toBuffer();
  const pixel = storeUpload("alice", "pixel.gif", "image/gif", gif);
  for (let i = 0; i < 2; i++) {
    const served = await get(`/uploads/${pixel}/file?variant=thumb`);
    assert.equal(served.headers.get("content-type"), "image/gif");
    assert.deepEqual(await bytes(served), gif);
  }
});

test("declared types are not trusted: SVG and fake images stay opaque, corrupt rasters get a fallback status", async () => {
  const svg = storeUpload("alice", "logo.svg", "image/svg+xml", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"));
  const svgRow = db.prepare("SELECT media_id, mime, length(data) AS n FROM uploads WHERE id = ?").get(svg) as { media_id: string | null; mime: string; n: number };
  assert.deepEqual([svgRow.media_id, svgRow.mime], [null, "image/svg+xml"]);
  const served = await get(`/uploads/${svg}/file?variant=thumb`);
  assert.match(served.headers.get("content-disposition")!, /^attachment/, "never rendered inline on our origin");
  assert.equal(served.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  const fake = storeUpload("alice", "notes.png", "image/png", Buffer.from("plain text pretending to be a PNG"));
  assert.equal((db.prepare("SELECT mime FROM uploads WHERE id = ?").get(fake) as { mime: string }).mime, "application/octet-stream");
  // A PNG signature with a damaged body is stored (lossless) but has no preview.
  const broken = Buffer.concat([(await sharp({ create: { width: 400, height: 400, channels: 3, background: "#0f0" } }).png().toBuffer()).subarray(0, 60), Buffer.alloc(400)]);
  const damaged = storeUpload("alice", "broken.png", "image/png", broken);
  assert.equal((await get(`/uploads/${damaged}/file?variant=thumb`)).status, 422);
  assert.deepEqual(await bytes(await get(`/uploads/${damaged}/file`)), broken);
  // A header claiming a decompression bomb is refused before anything is written.
  const bomb = Buffer.from(await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } }).png().toBuffer());
  bomb.writeUInt32BE(60_000, 16);
  bomb.writeUInt32BE(60_000, 20);
  assert.throws(() => storeUpload("alice", "bomb.png", "image/png", bomb), /megapixels/);
});

test("validators are answered only after the owner check, and missing files are 404", async () => {
  const id = storeUpload("alice", "screen.png", "image/png", await screenshot());
  const first = await get(`/uploads/${id}/file?variant=thumb`);
  const etag = first.headers.get("etag")!;
  assert.match(etag, /^"[0-9a-f]{32}-thumb"$/);
  assert.equal((await get(`/uploads/${id}/file?variant=thumb`, "alice", { "If-None-Match": etag })).status, 304);
  assert.equal((await get(`/uploads/${id}/file?variant=thumb`, "bob", { "If-None-Match": etag })).status, 404);
  const media = getMedia((db.prepare("SELECT media_id FROM uploads WHERE id = ?").get(id) as { media_id: string }).media_id)!;
  rmSync(mediaPath(media));
  assert.equal((await get(`/uploads/${id}/file`)).status, 404);
});

test("stored chats keep references, not base64; the model gets owned bytes only", async () => {
  ensureThread("alice", "t1");
  const original = await screenshot();
  const inline = `data:image/png;base64,${original.toString("base64")}`;
  appendMessage("alice", "t1", userImage("m1", inline));
  const json = listMessagesJson("alice", "t1");
  assert.doesNotMatch(json, /base64/);
  const ref = (JSON.parse(json)[0].content.parts[0] as { url: string }).url;
  assert.match(ref, /^okaychat-upload:upl_/);
  // Resending the same legacy message (a stale tab) neither duplicates nor changes it.
  appendMessage("alice", "t1", userImage("m1", inline));
  assert.equal((db.prepare("SELECT count(*) AS n FROM uploads").get() as { n: number }).n, 1);

  const message = { id: "m1", role: "user", parts: [{ type: "file", mediaType: "image/png", filename: "photo.png", url: ref }] } as UIMessage;
  const [mine] = await resolveImageRefs("alice", [message]);
  const part = mine!.parts[0] as { type: string; url: string };
  assert.equal(part.url, inline, "the model receives the lossless original");
  const [theirs] = await resolveImageRefs("bob", [message]);
  assert.deepEqual(theirs!.parts[0], { type: "text", text: '[Attached file "photo.png" is no longer available.]' });
  const [remote] = await resolveImageRefs("alice", [{ ...message, parts: [{ type: "file", mediaType: "image/png", url: "http://169.254.169.254/latest" }] } as UIMessage]);
  assert.equal(remote!.parts[0]!.type, "text", "a client-chosen URL is never handed to the SDK to download");

  // Temporary chats are never normalized or stored.
  const before = (db.prepare("SELECT count(*) AS n FROM media").get() as { n: number }).n;
  assert.throws(() => appendMessage("alice", "tmp_x", userImage("m1", inline)));
  assert.equal((db.prepare("SELECT count(*) AS n FROM media").get() as { n: number }).n, before);
});

test("a Library deletion removes the original and a stale resend cannot resurrect it", async () => {
  ensureThread("alice", "t1");
  const original = await photo();
  const inline = `data:image/jpeg;base64,${original.toString("base64")}`;
  appendMessage("alice", "t1", userImage("m1", inline));
  const upload = (db.prepare("SELECT id, media_id FROM uploads").get() as { id: string; media_id: string });
  const file = mediaPath(getMedia(upload.media_id)!);
  await get(`/uploads/${upload.id}/file?variant=thumb`);
  const response = await app.request(`http://app/library/upload/${upload.id}`, { method: "DELETE", headers: { cookie: "okaychat_session=alice" } });
  assert.equal(response.status, 200);
  assert.equal(existsSync(file), false);
  assert.deepEqual(readdirSync(path.join(dataDir, "media-cache", "alice")).filter((name) => name.startsWith(upload.media_id)), [], "previews go with the original");
  assert.equal(storageUsed("alice") < 2000, true);
  appendMessage("alice", "t1", userImage("m1", inline));
  assert.equal((db.prepare("SELECT count(*) AS n FROM uploads").get() as { n: number }).n, 0);
  const [resolved] = await resolveImageRefs("alice", [{ id: "m1", role: "user", parts: (JSON.parse(listMessagesJson("alice", "t1"))[0].content.parts) } as UIMessage]);
  assert.equal(resolved!.parts[0]!.type, "text");
});

test("the legacy migration moves BLOBs and inline images to files, resumably and idempotently", async () => {
  const original = await screenshot();
  ensureThread("alice", "legacy");
  db.prepare("INSERT INTO uploads (id, user_id, name, mime, data, created_at) VALUES ('upl_old', 'alice', 'old.png', 'image/png', ?, 1)").run(original);
  db.prepare("INSERT INTO uploads (id, user_id, name, mime, data, created_at) VALUES ('upl_doc', 'alice', 'doc.txt', 'text/plain', ?, 2)").run(Buffer.from("text stays a BLOB"));
  const inline = `data:image/png;base64,${original.toString("base64")}`;
  const content = { role: "user", parts: [{ type: "file", mediaType: "image/png", filename: "old.png", url: inline }, { type: "text", text: "keep me" }] };
  db.prepare("INSERT INTO messages (id, thread_id, format, content, bytes, created_at) VALUES ('m1', 'legacy', 'ai-sdk/v6', ?, 10, 1)").run(JSON.stringify(content));
  const charged = storageUsed("alice");
  // One row per step, as a restart would resume it.
  while (migrateMediaBatch(1)) { /* keep stepping */ }
  assert.equal(migrateMediaBatch(1), 0);
  const old = db.prepare("SELECT length(data) AS n, media_id FROM uploads WHERE id = 'upl_old'").get() as { n: number; media_id: string };
  assert.equal(old.n, 0);
  assert.deepEqual(await bytes(await get("/uploads/upl_old/file")), original);
  assert.equal((db.prepare("SELECT length(data) AS n FROM uploads WHERE id = 'upl_doc'").get() as { n: number }).n, 17);
  const stored = JSON.parse((db.prepare("SELECT content FROM messages WHERE id = 'm1'").get() as { content: string }).content);
  assert.equal(stored.parts[0].url.split("#")[0], uploadRef("upl_old"), "the inline copy reuses the upload that already holds the bytes");
  assert.deepEqual(stored.parts[1], { type: "text", text: "keep me" });
  const messageBytes = (db.prepare("SELECT bytes FROM messages WHERE id = 'm1'").get() as { bytes: number }).bytes;
  assert.equal(storageUsed("alice") - messageBytes, charged - 10, "moving bytes never charges them twice");
  // Running again from scratch changes nothing.
  db.exec("DELETE FROM server_settings WHERE key LIKE 'media_migration:%'");
  while (migrateMediaBatch(5)) { /* again */ }
  assert.equal((db.prepare("SELECT count(*) AS n FROM media").get() as { n: number }).n, 1);
});

test("forks keep generated images after the source is deleted, and shares follow the visible branch", async () => {
  ensureThread("alice", "source");
  const png = await sharp({ create: { width: 700, height: 500, channels: 3, background: "#3366aa" } }).png().toBuffer();
  const image = (await storeImage("alice", "source", png, "a blue square"))!;
  appendMessage("alice", "source", userImage("u1", "okaychat-upload:none"));
  const { media: plot } = putMedia("alice", await screenshot());
  db.prepare("INSERT INTO sandbox_files (id, user_id, thread_id, path, mime, data, size, created_at, media_id) VALUES ('sbf_1', 'alice', 'source', 'plot.png', 'image/png', x'', ?, 1, ?)").run(plot.size, plot.id);
  appendMessage("alice", "source", { id: "a1", parent_id: "u1", format: "ai-sdk/v6", content: { role: "assistant", parts: [
    { type: "tool-generate_image", toolCallId: "c1", state: "output-available", input: { prompt: "a blue square" }, output: image },
    { type: "tool-run_code", toolCallId: "c2", state: "output-available", input: { code: "plot()" }, output: { files: [{ path: "plot.png", size: plot.size, image: true, url: "/api/sandbox/source/stored?path=plot.png&v=1" }] } },
  ] } });
  const used = storageUsed("alice");
  branchThread("alice", "source", "a1", "fork");
  assert.equal(storageUsed("alice") - used < 2_000, true, "the fork references the images instead of copying their bytes");
  deleteThread("alice", "source");
  await deleteThreadImages("alice", "source");
  assert.ok(existsSync(imagePath("alice", image.id)), "the fork still shows it");
  assert.equal((db.prepare("SELECT media_id FROM sandbox_files WHERE thread_id = 'fork' AND path = 'plot.png'").get() as { media_id: string }).media_id, plot.id);
  assert.ok(existsSync(mediaPath(plot)), "the run image survives with the fork");
  assert.equal((await get(`/images/${image.id}?variant=thumb`)).status, 200);

  db.prepare("INSERT INTO shares (token, user_id, thread_id, created_at) VALUES ('tok', 'alice', 'fork', 1)").run();
  const shared = await publicApp.request(`http://app/shares/tok/images/${image.id}?variant=medium`);
  assert.equal(shared.status, 200);
  assert.equal(shared.headers.get("cache-control"), "private, no-cache");
  const etag = shared.headers.get("etag")!;
  assert.equal((await publicApp.request(`http://app/shares/tok/images/${image.id}?variant=medium`, { headers: { "If-None-Match": etag } })).status, 304);
  db.exec("DELETE FROM shares");
  assert.equal((await publicApp.request(`http://app/shares/tok/images/${image.id}?variant=medium`, { headers: { "If-None-Match": etag } })).status, 404, "revocation applies to revalidation too");

  deleteThread("alice", "fork");
  await deleteThreadImages("alice", "fork");
  assert.equal(existsSync(imagePath("alice", image.id)), false, "the last chat showing it takes it along");
});

test("a shared upload is served only while the shared branch shows it", async () => {
  ensureThread("alice", "t1");
  const original = await photo();
  appendMessage("alice", "t1", userImage("u1", `data:image/jpeg;base64,${original.toString("base64")}`));
  const upload = (db.prepare("SELECT id FROM uploads").get() as { id: string }).id;
  const other = storeUpload("alice", "private.png", "image/png", await screenshot());
  db.prepare("INSERT INTO shares (token, user_id, thread_id, created_at) VALUES ('tok', 'alice', 't1', 1)").run();
  assert.equal((await publicApp.request(`http://app/shares/tok/uploads/${upload}?variant=large`)).status, 200);
  assert.equal((await publicApp.request(`http://app/shares/tok/uploads/${other}`)).status, 404, "same owner, not on the shared branch");
  const page = await (await publicApp.request("http://app/shares/tok")).json() as { messages: Array<{ parts: Array<{ type: string; url?: string }> }> };
  assert.equal(page.messages[0]!.parts[0]!.url, `/api/public/shares/tok/uploads/${upload}`);
  assert.doesNotMatch(JSON.stringify(page), /base64/);
});

test("image edits accept the user's own attached images by file_id, at original quality", async () => {
  const id = storeUpload("alice", "ref.png", "image/png", await screenshot());
  const [file] = referencePaths("alice", [id]);
  assert.match(file!, /\.png$/, "Codex stages references by extension");
  assert.throws(() => referencePaths("bob", [id]), /Unknown reference image/);
});

test("GC removes unreferenced media and old orphan files, never fresh or referenced ones", async () => {
  const kept = storeUpload("alice", "kept.png", "image/png", await screenshot());
  const { media: loose } = putMedia("alice", await sharp({ create: { width: 30, height: 30, channels: 3, background: "#123456" } }).png().toBuffer());
  db.prepare("UPDATE media SET created_at = 0 WHERE id = ?").run(loose.id);
  const userDir = path.join(MEDIA_DIR, "alice");
  mkdirSync(userDir, { recursive: true });
  const stale = path.join(userDir, "med_stale.png");
  const fresh = path.join(userDir, "med_fresh.png");
  writeFileSync(stale, "x");
  writeFileSync(fresh, "x");
  utimesSync(stale, new Date(0), new Date(0));
  const result = collectMediaGarbage();
  assert.equal(result.media, 1);
  assert.equal(existsSync(mediaPath(loose)), false);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true, "a write still in flight is inside the grace period");
  assert.equal((await get(`/uploads/${kept}/file`)).status, 200);
});

test("context estimates count an image as one image, not as its base64 characters", () => {
  const huge = `data:image/png;base64,${"A".repeat(20_000_000)}`;
  const message = { id: "m", role: "user", parts: [{ type: "file", mediaType: "image/png", url: huge }] };
  assert.ok(estimateTokens([message]) < FILE_TOKENS + 100);
  assert.ok(estimateTokens([{ ...message, parts: [{ type: "file", mediaType: "image/png", url: "okaychat-upload:upl_x" }] }]) >= FILE_TOKENS);
});

const assistantImage = (id: string, url: string, filename = "drawing.png") =>
  ({ id, parent_id: "u1", format: "ai-sdk/v6", content: { role: "assistant", parts: [{ type: "text", text: "Here it is." }, { type: "file", mediaType: "image/png", filename, url }] } });
const storedParts = (thread: string, id: string) =>
  (JSON.parse((db.prepare("SELECT content FROM messages WHERE thread_id = ? AND id = ?").get(thread, id) as { content: string }).content) as { parts: Array<{ type: string; url?: string; text?: string }> }).parts;
const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const solid = (color: string) => sharp({ create: { width: 300, height: 200, channels: 3, background: color } }).png().toBuffer();

test("migrated messages are charged like appended ones, so a remaining inline PDF is not billed twice", async () => {
  ensureThread("alice", "legacy");
  const png = await solid("#884422");
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(100_000 - 9, 0x20)]);
  const content = { role: "user", parts: [
    { type: "file", mediaType: "image/png", filename: "a.png", url: `data:image/png;base64,${png.toString("base64")}` },
    { type: "file", mediaType: "application/pdf", filename: "doc.pdf", url: `data:application/pdf;base64,${pdf.toString("base64")}` },
    { type: "text", text: "two files" },
  ] };
  db.prepare("INSERT INTO messages (id, thread_id, format, content, bytes, created_at) VALUES ('m1', 'legacy', 'ai-sdk/v6', ?, 10, 1)").run(JSON.stringify(content));
  while (migrateMediaBatch(1)) { /* step */ }
  const row = db.prepare("SELECT content, bytes FROM messages WHERE id = 'm1'").get() as { content: string; bytes: number };
  assert.match(row.content, /okaychat-upload:/);
  assert.match(row.content, /data:application\/pdf/, "only raster images move");
  assert.equal(row.bytes, messageBytes(row.content));
  assert.ok(row.bytes < 1000, `${row.bytes} bytes charged to the message`);
});

test("a legacy row over the pixel bound is left as it is and does not block the rows after it", async () => {
  const bomb = Buffer.from(await solid("#000000"));
  bomb.writeUInt32BE(60_000, 16);
  bomb.writeUInt32BE(60_000, 20);
  const good = await solid("#00aa00");
  db.prepare("INSERT INTO uploads (id, user_id, name, mime, data, created_at) VALUES ('upl_bomb', 'alice', 'bomb.png', 'image/png', ?, 1)").run(bomb);
  db.prepare("INSERT INTO uploads (id, user_id, name, mime, data, created_at) VALUES ('upl_good', 'alice', 'good.png', 'image/png', ?, 2)").run(good);
  ensureThread("alice", "legacy");
  const content = { role: "user", parts: [
    { type: "file", mediaType: "image/png", filename: "bomb.png", url: `data:image/png;base64,${bomb.toString("base64")}` },
    { type: "file", mediaType: "image/png", filename: "good.png", url: `data:image/png;base64,${good.toString("base64")}` },
  ] };
  db.prepare("INSERT INTO messages (id, thread_id, format, content, bytes, created_at) VALUES ('m1', 'legacy', 'ai-sdk/v6', ?, 10, 1)").run(JSON.stringify(content));

  // A transient failure (the user's media directory cannot be created) stops the step and keeps the cursor.
  const blocker = path.join(MEDIA_DIR, "alice");
  rmSync(blocker, { recursive: true, force: true });
  mkdirSync(MEDIA_DIR, { recursive: true });
  writeFileSync(blocker, "not a directory");
  try {
    assert.throws(() => { while (migrateMediaBatch(1)) { /* step */ } });
    assert.ok((db.prepare("SELECT length(data) AS n FROM uploads WHERE id = 'upl_good'").get() as { n: number }).n > 0, "the original stays until a copy exists");
  } finally {
    rmSync(blocker, { force: true });
  }
  // Resuming moves the good row and the good part; the oversized ones keep their bytes.
  while (migrateMediaBatch(1)) { /* step */ }
  const bombRow = db.prepare("SELECT media_id, data FROM uploads WHERE id = 'upl_bomb'").get() as { media_id: string | null; data: Uint8Array };
  assert.equal(bombRow.media_id, null);
  assert.deepEqual(Buffer.from(bombRow.data), bomb);
  assert.ok((db.prepare("SELECT media_id FROM uploads WHERE id = 'upl_good'").get() as { media_id: string | null }).media_id);
  const parts = storedParts("legacy", "m1");
  assert.match(parts[0]!.url!, /^data:image\/png;base64,/);
  assert.equal(parts[1]!.url, `okaychat-upload:upl_good#sha256=${getMedia((db.prepare("SELECT media_id FROM uploads WHERE id = 'upl_good'").get() as { media_id: string }).media_id)!.sha256}`);
  assert.equal(migrateMediaBatch(1), 0, "finished");
});

test("generated and MCP images must decode completely, frames included", async () => {
  const jpeg = await sharp({ create: { width: 400, height: 400, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 40 } } }).jpeg().toBuffer();
  ensureThread("alice", "t1");
  for (const share of [0.3, 0.5, 0.8]) {
    const cut = jpeg.subarray(0, Math.floor(jpeg.length * share));
    await assert.rejects(inspectRaster(cut), MediaProcessingError, `${share} of a JPEG`);
    assert.equal(await storeImage("alice", "t1", cut, "cut"), null);
  }
  assert.deepEqual((await inspectRaster(jpeg)).width, 400);
  const frames = Buffer.alloc(64 * 64 * 4 * 3);
  for (let i = 0; i < frames.length; i += 4) frames.set([Math.floor(i / (64 * 64 * 4)) * 90, (i / 4) % 251, 100, 255], i);
  const gif = await sharp(frames, { raw: { width: 64, height: 192, channels: 4, pageHeight: 64 } }).gif().toBuffer();
  assert.deepEqual(await inspectRaster(gif), { format: "gif", width: 64, height: 64, pages: 3, alpha: true });
  await assert.rejects(inspectRaster(gif.subarray(0, gif.length - 40)), MediaProcessingError, "a GIF cut between frames");
  const many = Buffer.alloc(2 * 2 * 4 * (MAX_FRAMES + 1));
  for (let i = 0; i < many.length; i += 4) many.set([(i / 16) % 256, Math.floor(i / 4096) * 60, 7, 255], i);
  const long = await sharp(many, { raw: { width: 2, height: 2 * (MAX_FRAMES + 1), channels: 4, pageHeight: 2 } }).webp({ lossless: true }).toBuffer();
  assert.equal((await sharp(long, { animated: true }).metadata()).pages, MAX_FRAMES + 1);
  await assert.rejects(inspectRaster(long), /frames/);
});

test("assistant image output is stored as a reference, and resent bytes are matched by content", async () => {
  ensureThread("alice", "t1");
  appendMessage("alice", "t1", userImage("u1", "okaychat-upload:none"));
  const drawn = await solid("#2255aa");
  const inline = `data:image/png;base64,${drawn.toString("base64")}`;
  appendMessage("alice", "t1", assistantImage("a1", inline));
  assert.doesNotMatch(listMessagesJson("alice", "t1"), /base64/);
  const ref = storedParts("t1", "a1")[1]!.url!;
  assert.match(ref, /^okaychat-upload:upl_[A-Za-z0-9_-]+#sha256=[0-9a-f]{64}$/);
  const upload = (db.prepare("SELECT id FROM uploads").get() as { id: string }).id;
  assert.equal(ref.split("#")[0], uploadRef(upload));
  // The model and a share get the bytes; the share only through its own route.
  const [model] = await resolveImageRefs("alice", [{ id: "a1", role: "assistant", parts: storedParts("t1", "a1") } as UIMessage]);
  assert.equal((model!.parts[1] as { url: string }).url, inline);
  db.prepare("INSERT INTO shares (token, user_id, thread_id, created_at) VALUES ('tok', 'alice', 't1', 1)").run();
  assert.equal((await publicApp.request(`http://app/shares/tok/uploads/${upload}?variant=thumb`)).status, 200);

  // The tab that streamed it still holds the inline bytes and resends them: nothing new is stored.
  appendMessage("alice", "t1", assistantImage("a1", inline));
  assert.equal(count("uploads"), 1);
  assert.equal(storedParts("t1", "a1")[1]!.url, ref);
  // After a Library deletion the same resend cannot bring it back.
  await app.request(`http://app/library/upload/${upload}`, { method: "DELETE", headers: { cookie: "okaychat_session=alice" } });
  appendMessage("alice", "t1", assistantImage("a1", inline));
  assert.equal(count("uploads"), 0);
  assert.equal(storedParts("t1", "a1")[1]!.url, ref);
  // Different bytes in the same slot are a real replacement.
  const other = await solid("#aa2255");
  appendMessage("alice", "t1", assistantImage("a1", `data:image/png;base64,${other.toString("base64")}`));
  assert.notEqual(storedParts("t1", "a1")[1]!.url, ref);
  assert.equal(count("uploads"), 1);

  // A fork keeps showing it after the source chat is deleted.
  const replaced = storedParts("t1", "a1")[1]!.url!;
  branchThread("alice", "t1", "a1", "fork");
  deleteThread("alice", "t1");
  const [forked] = await resolveImageRefs("alice", [{ id: "a1", role: "assistant", parts: storedParts("fork", "a1") } as UIMessage]);
  assert.equal((forked!.parts[1] as { url: string }).url, `data:image/png;base64,${other.toString("base64")}`);
  assert.equal(storedParts("fork", "a1")[1]!.url, replaced);
});

test("an edited reply never stores resent image bytes, and a stale resend of its own image is not a conflict", async () => {
  ensureThread("alice", "t1");
  appendMessage("alice", "t1", userImage("u1", "okaychat-upload:none"));
  const drawn = await solid("#118811");
  const inline = `data:image/png;base64,${drawn.toString("base64")}`;
  appendMessage("alice", "t1", assistantImage("a1", inline));
  const stored = storedParts("t1", "a1");
  db.prepare("UPDATE messages SET content = ?, edited_at = 1 WHERE id = 'a1'").run(JSON.stringify({ role: "assistant", parts: [{ type: "text", text: "Edited." }, stored[1]] }));
  const edited = { ...assistantImage("a1", inline), content: { role: "assistant", parts: [{ type: "text", text: "Edited." }, { type: "file", mediaType: "image/png", filename: "drawing.png", url: inline }] } };
  appendMessage("alice", "t1", edited);
  assert.equal(storedParts("t1", "a1")[0]!.text, "Edited.");
  const media = count("media");
  const other = await solid("#881111");
  assert.throws(() => appendMessage("alice", "t1", { ...edited, content: { ...edited.content, parts: [edited.content.parts[0]!, { ...edited.content.parts[1]!, url: `data:image/png;base64,${other.toString("base64")}` }] } }), /edited/);
  assert.equal(count("media"), media, "a refused resend writes nothing");
  assert.equal(count("uploads"), 1);
});

test("a user image replaced under the same file name is stored, not silently dropped", async () => {
  ensureThread("alice", "t1");
  appendMessage("alice", "t1", userImage("m1", `data:image/png;base64,${(await solid("#123123")).toString("base64")}`));
  const first = storedParts("t1", "m1")[0]!.url;
  appendMessage("alice", "t1", userImage("m1", `data:image/png;base64,${(await solid("#321321")).toString("base64")}`));
  assert.notEqual(storedParts("t1", "m1")[0]!.url, first);
});

test("the migration moves assistant image output too", async () => {
  ensureThread("alice", "legacy");
  const drawn = await solid("#456456");
  db.prepare("INSERT INTO messages (id, thread_id, format, content, bytes, created_at) VALUES ('a1', 'legacy', 'ai-sdk/v6', ?, 10, 1)")
    .run(JSON.stringify(assistantImage("a1", `data:image/png;base64,${drawn.toString("base64")}`).content));
  while (migrateMediaBatch(1)) { /* step */ }
  assert.match(storedParts("legacy", "a1")[1]!.url!, /^okaychat-upload:/);
  assert.equal(storedParts("legacy", "a1")[0]!.text, "Here it is.");
});

test("a variant cache namespace is used instead of the account", async () => {
  const original = await solid("#224466");
  const { media } = putMedia("alice", original);
  const { variantFile } = await import("./variants.js");
  const chosen = await variantFile({ namespace: "ch-test", key: media.id, file: mediaPath(media), mime: media.mime, size: media.size, etag: media.id }, "thumb");
  assert.equal(chosen.original, false);
  assert.match(chosen.file, /media-cache[\\/]ch-test[\\/]/);
  assert.equal(existsSync(path.join(dataDir, "media-cache", "alice", `${media.id}.thumb.webp`)), false);
});

test("a release inside a transaction that rolls back keeps the original", async () => {
  const { tx } = await import("../db.js");
  const { releaseMedia } = await import("./store.js");
  const id = storeUpload("alice", "kept.png", "image/png", await solid("#0a0a0a"));
  const media = getMedia((db.prepare("SELECT media_id FROM uploads WHERE id = ?").get(id) as { media_id: string }).media_id)!;
  assert.throws(() => tx(() => {
    db.prepare("DELETE FROM uploads WHERE id = ?").run(id);
    releaseMedia(media.id);
    throw new Error("later step failed");
  }));
  assert.ok(existsSync(mediaPath(media)), "the restored upload still has its file");
  assert.equal((await get(`/uploads/${id}/file`)).status, 200);
  tx(() => {
    db.prepare("DELETE FROM uploads WHERE id = ?").run(id);
    releaseMedia(media.id);
    assert.ok(existsSync(mediaPath(media)), "nothing is deleted before the commit");
  });
  assert.equal(existsSync(mediaPath(media)), false);
});
