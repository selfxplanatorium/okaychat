import assert from "node:assert/strict";
import { test } from "node:test";
import { CompositeAttachmentAdapter } from "@assistant-ui/react";
import { BinaryAttachmentAdapter, CodeAttachmentAdapter, DocumentAttachmentAdapter, StoredImageAttachmentAdapter } from "./attachments";

const pending = async (adapter: StoredImageAttachmentAdapter | CodeAttachmentAdapter | BinaryAttachmentAdapter, name: string, type: string) => adapter.add({ file: new File(["bytes"], name, { type }) });

test("stored images send an owned reference, never the base64 original", async (t) => {
  const calls: Array<{ url: string; body: FormData }> = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body as FormData });
    return Response.json({ fileId: "upl_image", mime: "image/png" });
  });
  const adapter = new StoredImageAttachmentAdapter(() => false);
  const sent = await adapter.send(await pending(adapter, "photo.png", "image/png"));
  assert.deepEqual(sent.content[0], { type: "image", image: "okaychat-upload:upl_image", filename: "photo.png" });
  assert.doesNotMatch(JSON.stringify(sent.content), /base64/);
  assert.match(JSON.stringify(sent.content[1]), /file_id=\\"upl_image\\"/);
  assert.equal(sent.contentType, "image/png");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/api/files/store");
  assert.equal((calls[0]!.body.get("file") as File).name, "photo.png");
});

test("a file the server does not recognize as a raster image is refused as an image", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ fileId: "upl_heic", mime: "application/octet-stream" }));
  const adapter = new StoredImageAttachmentAdapter(() => false);
  const attachment = await pending(adapter, "photo.heic", "image/heic");
  await assert.rejects(() => adapter.send(attachment), /not a PNG/);
});

test("quota failures block image, native PDF, text, and binary sends instead of silently losing files", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Storage quota exceeded" }, { status: 413 }));
  const cases = [
    [new StoredImageAttachmentAdapter(() => false), "photo.png", "image/png"],
    [new CodeAttachmentAdapter(() => false), "code.py", "text/plain"],
    [new BinaryAttachmentAdapter(() => false), "archive.zip", "application/zip"],
    [new DocumentAttachmentAdapter(() => false), "native.pdf", "application/pdf"],
  ] as const;
  for (const [adapter, name, mime] of cases) {
    const attachment = await adapter.add({ file: new File(["bytes"], name, { type: mime }) });
    await assert.rejects(() => adapter.send(attachment), /Storage quota exceeded/, name);
  }
});

test("the document adapter accepts presentations, OpenDocument text, and EPUB files", () => {
  const accepted = new DocumentAttachmentAdapter().accept.split(",");
  for (const type of [".pptx", ".ppsx", ".odt", ".epub"]) assert.ok(accepted.includes(type), type);
});

test("a presentation attachment routes to the document adapter and is extracted", async (t) => {
  const calls: Array<{ url: string; body: FormData }> = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body as FormData });
    return Response.json({ text: "## Slide 1\nDeck text", pages: 1, fileId: "upl_deck" });
  });
  const adapter = new CompositeAttachmentAdapter([new DocumentAttachmentAdapter(() => false), new BinaryAttachmentAdapter(() => false)]);
  const attachment = await adapter.add({
    file: new File(["bytes"], "deck.pptx", { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }),
  });
  const sent = await adapter.send(attachment as Parameters<typeof adapter.send>[0]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/api/files/extract");
  assert.ok(calls[0]!.body instanceof FormData);
  assert.equal((calls[0]!.body.get("file") as File).name, "deck.pptx");
  assert.match(JSON.stringify(sent), /Deck text/);
  assert.match(JSON.stringify(sent), /upl_deck/);
});

test("temporary image and text sends never call storage or add file_id markers", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Temporary sends must not call storage"); });
  for (const adapter of [new StoredImageAttachmentAdapter(() => true), new CodeAttachmentAdapter(() => true)]) {
    const attachment = await adapter.add({ file: new File(["bytes"], "test.txt", { type: "text/plain" }) });
    const sent = await adapter.send(attachment);
    assert.doesNotMatch(JSON.stringify(sent), /file_id/);
    assert.equal(sent.status.type, "complete");
  }
});

test("the fallback accepts arbitrary attachments and preserves their bytes for tools", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ fileId: "upl_binary" }));
  const adapter = new CompositeAttachmentAdapter([new StoredImageAttachmentAdapter(() => false), new BinaryAttachmentAdapter(() => false)]);
  const attachment = await adapter.add({ file: new File(["bytes"], "archive.unknown", { type: "application/octet-stream" }) });
  assert.ok(Symbol.asyncIterator in attachment === false);
  const sent = await adapter.send(attachment as Parameters<typeof adapter.send>[0]);
  assert.match(JSON.stringify(sent), /upl_binary/);
});
