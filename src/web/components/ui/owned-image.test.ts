import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";

// A minimal DOM so the component's load/error state can be driven. Rendering only; no network.
const { window, document } = parseHTML("<!doctype html><html><body><div id=root></div></body></html>");
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { OwnedImage } = await import("./owned-image.js");

const container = document.getElementById("root")!;
const root = createRoot(container);
const render = (props: Parameters<typeof OwnedImage>[0]) => act(async () => root.render(createElement(OwnedImage, props)));
const fail = () => act(async () => { container.querySelector("img")!.dispatchEvent(new window.Event("error")); });

test("the fallback's controls never sit inside the image's link, and Retry reloads the same preview", async () => {
  await render({ src: "/api/images/img_1", href: "/api/images/img_1", alt: "chart", variant: "large" });
  assert.equal(container.querySelector("a > img")?.getAttribute("src"), "/api/images/img_1?variant=large");
  await fail();
  const fallback = container.querySelector("[data-slot=owned-image-fallback]")!;
  assert.ok(fallback);
  assert.equal(fallback.closest("a"), null, "no link wraps the fallback");
  const retry = fallback.querySelector("button")!;
  assert.equal(retry.getAttribute("data-command"), "chat.retryImage");
  assert.equal(fallback.querySelector("a")?.getAttribute("href"), "/api/images/img_1");
  await act(async () => { retry.dispatchEvent(new window.Event("click", { bubbles: true })); });
  assert.equal(container.querySelector("img")?.getAttribute("src"), "/api/images/img_1?variant=large&retry=1");
});

test("a failure belongs to its own source: another image starts loading normally", async () => {
  await render({ src: "/api/images/img_a", alt: "a" });
  await fail();
  assert.ok(container.querySelector("[data-slot=owned-image-fallback]"));
  await render({ src: "/api/images/img_b", alt: "b" });
  assert.equal(container.querySelector("[data-slot=owned-image-fallback]"), null);
  assert.equal(container.querySelector("img")?.getAttribute("src"), "/api/images/img_b?variant=medium");
});

test("inside a control (a Library tile) the fallback has no controls of its own", async () => {
  await render({ src: "/api/uploads/upl_1/file", alt: "", variant: "thumb", controls: false });
  await fail();
  const fallback = container.querySelector("[data-slot=owned-image-fallback]")!;
  assert.equal(fallback.querySelector("button, a"), null);
});

test("an owned reference with a content digest previews the upload it names", async () => {
  await render({ src: "okaychat-upload:upl_9#sha256=" + "a".repeat(64), alt: "" });
  assert.equal(container.querySelector("img")?.getAttribute("src"), "/api/uploads/upl_9/file?variant=medium");
});
