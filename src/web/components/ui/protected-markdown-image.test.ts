import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { ProtectedMarkdownImage } from "./protected-markdown-image.js";

// The component's hooks need a DOM harness. These render checks cover the two props that would
// otherwise start a request without consent; the consent-matching logic is tested through imageReveal.
test("a loaded image drops srcSet and sizes and never sends a referrer", () => {
  const html = renderToStaticMarkup(
    createElement(ProtectedMarkdownImage, {
      src: "/api/images/img_1",
      alt: "preview",
      srcSet: "https://tracker.test/pixel.png?d=secret 2x",
      sizes: "100vw",
    }),
  );
  assert.match(html, /<img /);
  assert.match(html, /src="\/api\/images\/img_1"/);
  assert.doesNotMatch(html, /srcset|tracker\.test/i, "a secondary remote source cannot start a request");
  assert.doesNotMatch(html, /sizes=/);
  assert.match(html, /referrerPolicy="no-referrer"/i);
});

test("a remote image renders no img until the reader consents", () => {
  const html = renderToStaticMarkup(
    createElement(ProtectedMarkdownImage, { src: "https://tracker.test/pixel.png?d=secret", alt: "status" }),
  );
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<link[^>]+as="image"/i, "nothing preloads the remote URL before consent");
  assert.match(html, /Load image/);
  assert.match(html, /send your IP address/);
});
