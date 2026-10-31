import assert from "node:assert/strict";
import { test } from "node:test";
import { imageReveal, markdownImageSource, remoteImageHost } from "./markdown-image-policy.js";

test("app-owned image routes load without consent", () => {
  for (const url of [
    "/api/images/img_123",
    "/api/images/img_123?v=2",
    "/api/uploads/upl_123/file",
    "/api/sandbox/thr_abc/stored?path=a.png&preview=1",
    "/api/account/avatar?v=4",
    "/api/public/shares/tok_123/images/img_1",
    "/api/public/shares/tok_123/artifacts/art_1/file",
  ]) assert.deepEqual(markdownImageSource(url), { kind: "app", url }, url);
});

test("remote, protocol-relative, and lookalike paths wait for consent or are blocked", () => {
  assert.deepEqual(markdownImageSource("https://tracker.test/pixel.png?d=secret"), { kind: "remote", url: "https://tracker.test/pixel.png?d=secret" });
  assert.deepEqual(markdownImageSource("//tracker.test/pixel.png"), { kind: "remote", url: "https://tracker.test/pixel.png" });
  assert.equal(markdownImageSource("/api/images/../mcp/servers").kind, "blocked");
  assert.equal(markdownImageSource("/api/mcp/servers").kind, "blocked");
  assert.equal(markdownImageSource("image.png").kind, "blocked");
  assert.equal(markdownImageSource("javascript:alert(1)").kind, "blocked");
});

test("inline raster data works, while SVG and other data URLs are blocked", () => {
  assert.equal(markdownImageSource("data:image/png;base64,iVBORw0KGgo=").kind, "inline");
  assert.equal(markdownImageSource("blob:http://localhost/abc").kind, "inline");
  assert.equal(markdownImageSource("data:image/svg+xml,<svg onload=alert(1)>").kind, "blocked");
  assert.equal(markdownImageSource("data:text/html,<script>alert(1)</script>").kind, "blocked");
});

test("remote hosts are shown without a leading www", () => {
  assert.equal(remoteImageHost("https://www.example.test/a.png"), "example.test");
  assert.equal(remoteImageHost("not a url"), undefined);
});

test("consent belongs to one exact URL, so an approved URL never reveals another", () => {
  const a = markdownImageSource("https://innocuous.test/a.png");
  const b = markdownImageSource("https://tracker.test/pixel.png?d=secret");
  assert.equal(imageReveal(a, { approvedUrl: a.url }), "image");
  assert.equal(imageReveal(b, { approvedUrl: a.url }), "consent", "A's approval does not grant B");
  assert.equal(imageReveal(b, { approvedUrl: b.url }), "image");
  // Normalization happens before the comparison: the same URL written protocol-relative matches.
  const protocolRelative = markdownImageSource("//innocuous.test/a.png");
  assert.equal(imageReveal(protocolRelative, { approvedUrl: a.url }), "image");
  // A failure belongs to its own URL too.
  assert.equal(imageReveal(a, { approvedUrl: a.url, failedUrl: a.url }), "failed");
  assert.equal(imageReveal(b, { approvedUrl: b.url, failedUrl: a.url }), "image");
  // App-owned and inline images never wait, and blocked schemes never render.
  assert.equal(imageReveal(markdownImageSource("/api/images/img_1"), {}), "image");
  assert.equal(imageReveal(markdownImageSource("data:image/png;base64,iVBORw0KGgo="), {}), "image");
  assert.equal(imageReveal(markdownImageSource("data:image/svg+xml,<svg/>"), {}), "blocked");
  assert.equal(imageReveal(markdownImageSource("javascript:alert(1)"), {}), "blocked");
});
