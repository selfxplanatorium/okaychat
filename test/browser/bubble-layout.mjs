#!/usr/bin/env node
// Live check for the Timeline / Bubbles message layout (docs/implementation/appearance.md, "Message layout").
// Not part of `npm test`: it needs a running server and an account.
//
//   OKAYCHAT_CHECK_URL=https://<host>:5173 OKAYCHAT_CHECK_EMAIL=… OKAYCHAT_CHECK_PASSWORD=… node test/browser/bubble-layout.mjs
//
// It builds one fixture chat through the public API, checks both layouts at several viewports, switches the
// layout live from a second tab, and deletes the fixture. The account's own layout is restored afterwards.
import { mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright-core";

const BASE = (process.env.OKAYCHAT_CHECK_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");
const EMAIL = process.env.OKAYCHAT_CHECK_EMAIL;
const PASSWORD = process.env.OKAYCHAT_CHECK_PASSWORD;
const SHOTS = "/tmp/okaychat-bubble-check";
if (!EMAIL || !PASSWORD) {
  console.error("Set OKAYCHAT_CHECK_EMAIL and OKAYCHAT_CHECK_PASSWORD.");
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });

const ALL_VIEWPORTS = [
  { name: "1440", options: { viewport: { width: 1440, height: 900 } } },
  { name: "390", options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  { name: "720", options: { viewport: { width: 720, height: 450 } } },
  { name: "1440-dark", options: { viewport: { width: 1440, height: 900 }, colorScheme: "dark" } },
  { name: "1440-reduced", options: { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" } },
];

// OKAYCHAT_CHECK_ONLY=390,720 limits the run to those viewport names.
const only = process.env.OKAYCHAT_CHECK_ONLY?.split(",");
const VIEWPORTS = only ? ALL_VIEWPORTS.filter((vp) => only.includes(vp.name)) : ALL_VIEWPORTS;

// 64×64 opaque PNG, built at runtime so the file stays text.
function png64() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rows = Buffer.alloc(64 * (1 + 64 * 3));
  for (let y = 0; y < 64; y++) {
    const at = y * (1 + 64 * 3);
    for (let x = 0; x < 64; x++) rows.set([x * 4, y * 4, 160], at + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) {
    failures++;
    throw new Error(`Check failed: ${label}`);
  }
}

// The runtime merges adjacent assistant rows into one message, so only user messages can form a rendered run:
// u1+u2 are a user run, a1/u3/a2 are singles.
const ids = { u1: "bubble-check-u1", u2: "bubble-check-u2", a1: "bubble-check-a1", u3: "bubble-check-u3", a2: "bubble-check-a2" };

async function api(page, path, init = {}) {
  return page.evaluate(async ([path, init]) => {
    const res = await fetch(`/api${path}`, {
      ...init,
      headers: init.json ? { "Content-Type": "application/json" } : undefined,
      body: init.json ? JSON.stringify(init.json) : init.body,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }, [path, init]);
}

async function createFixture(page) {
  const image = png64().toString("base64");
  const fileId = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("file", new File([bytes], "shot.png", { type: "image/png" }));
    const res = await fetch("/api/files/store", { method: "POST", body: form });
    return (await res.json()).fileId;
  }, image);
  const thread = await api(page, "/threads", { method: "POST", json: {} });
  const threadId = thread.body.id;
  const append = (id, parent, role, parts) => api(page, `/threads/${threadId}/messages`, {
    method: "POST",
    json: { id, parent_id: parent, format: "ai-sdk/v6", content: { id, role, parts, metadata: {} } },
  });
  await append(ids.u1, null, "user", [{ type: "text", text: "First prompt." }]);
  await append(ids.u2, ids.u1, "user", [{ type: "text", text: "Second prompt, long enough to wrap at 390 px without widening the page." }]);
  await append(ids.a1, ids.u2, "assistant", [
    { type: "step-start" },
    { type: "reasoning", text: "Thinking about the bubble fixture reasoning.", state: "done" },
    {
      type: "tool-web_search", toolCallId: "bubble-search", state: "output-available", input: { query: "bubble layout" },
      output: { engine: "searxng", results: [
        { title: "Bubble result one", url: "https://example.test/one", snippet: "First result." },
        { title: "Bubble result two", url: "https://example.test/two", snippet: "Second result." },
      ] },
    },
    { type: "step-start" },
    { type: "text", text: "Here is what I found, with a screenshot of the layout.", state: "done" },
    { type: "file", mediaType: "image/png", filename: "shot.png", url: `okaychat-upload:${fileId}` },
  ]);
  await append(ids.u3, ids.a1, "user", [{ type: "text", text: "Thanks." }]);
  await append(ids.a2, ids.u3, "assistant", [
    { type: "text", text: "A follow-up paragraph of plain prose, long enough to show how a reply bubble wraps inside the reading lane.", state: "done" },
  ]);
  return { threadId, fileId };
}

/** Collects page errors, console errors and failed API requests for one page. */
function watch(page, label) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error" || /ResizeObserver loop/.test(msg.text())) return;
    if (/status of 429/.test(msg.text()) && msg.location().url.includes("/api/channels/events")) return;
    problems.push(`console: ${msg.text()}`);
  });
  page.on("requestfailed", (request) => {
    // Navigations and unloads abort in-flight requests; those are not failures.
    if (request.url().includes("/api/") && !/ERR_ABORTED/.test(request.failure()?.errorText ?? "")) problems.push(`requestfailed: ${request.url()}`);
  });
  // Channels allow two live streams per account; another tab falls back to polling after this 429.
  const expected = (url, status) => status === 429 && url.includes("/api/channels/events");
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400 && !expected(response.url(), response.status())) problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  return () => check(`${label}: no page error, console error or failed /api request`, problems.length === 0, problems.join("; "));
}

async function measure(page) {
  return page.evaluate((ids) => {
    const root = (id) => document.querySelector(`[data-message-id="${id}"]`);
    const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
    const group = document.querySelector('[data-slot="aui_message-group"]');
    const content = (id) => root(id).querySelector('[data-slot="aui_assistant-message-content"]');
    const bubble = (id) => root(id).querySelector(".aui-user-message-content");
    const css = (el, prop) => getComputedStyle(el).getPropertyValue(prop);
    const alpha = (color) => {
      const m = color.match(/rgba?\(([^)]+)\)/) ?? color.match(/color\(srgb ([^)]+)\)/);
      if (!m) return color === "transparent" ? 0 : 1;
      const parts = m[1].split(/[ ,/]+/).filter(Boolean);
      return parts.length >= 4 ? Number(parts[3]) : 1;
    };
    return {
      layout: document.documentElement.dataset.messageLayout ?? null,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      lane: rect(group),
      rowGap: css(group, "row-gap"),
      runs: Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, root(id)?.dataset.messageRun ?? null])),
      a1: { ...rect(content(ids.a1)), alpha: alpha(css(content(ids.a1), "background-color")), maxWidth: css(content(ids.a1), "max-width"), wide: root(ids.a1).dataset.bubbleWide ?? null },
      a2: { ...rect(content(ids.a2)), alpha: alpha(css(content(ids.a2), "background-color")), maxWidth: css(content(ids.a2), "max-width"), marginTop: css(root(ids.a2), "margin-block-start") },
      u1: rect(bubble(ids.u1)),
      u2: { ...rect(bubble(ids.u2)), maxWidth: css(bubble(ids.u2), "max-width"), marginTop: css(root(ids.u2), "margin-block-start") },
      u3: { ...rect(bubble(ids.u3)), marginTop: css(root(ids.u3), "margin-block-start") },
    };
  }, ids);
}

const near = (a, b) => Math.abs(a - b) <= 1;

async function checkLayout(page, layout, vp) {
  const tag = `${layout}@${vp.name}`;
  await page.waitForFunction((l) => (document.documentElement.dataset.messageLayout ?? "timeline") === l, layout);
  await page.locator(`[data-message-id="${ids.a2}"]`).waitFor();
  // Let content-visibility and lazy images settle before measuring.
  await page.locator(`[data-message-id="${ids.a1}"] img`).first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
  const m = await measure(page);
  const desktop = vp.options.viewport.width >= 768;
  check(`${tag}: no horizontal page scroll`, m.scrollWidth <= m.innerWidth + 1, `${m.scrollWidth} vs ${m.innerWidth}`);
  for (const key of ["a1", "a2", "u1", "u2", "u3"]) {
    check(`${tag}: ${key} inside the lane`, m[key].left >= m.lane.left - 1 && m[key].right <= m.lane.right + 1, JSON.stringify({ el: m[key], lane: m.lane }));
  }
  check(`${tag}: runs u1/u2/a1/u3/a2 = start/end/single/single/single`, m.runs.u1 === "start" && m.runs.u2 === "end" && m.runs.a1 === "single" && m.runs.u3 === "single" && m.runs.a2 === "single", JSON.stringify(m.runs));
  check(`${tag}: a1 is wide (image reply)`, m.a1.wide === "1");
  if (layout === "timeline") {
    check(`${tag}: assistant content transparent`, m.a1.alpha === 0 && m.a2.alpha === 0);
    check(`${tag}: assistant max-width none`, m.a2.maxWidth === "none");
    check(`${tag}: group row-gap 24px`, m.rowGap === "24px", m.rowGap);
    check(`${tag}: assistant margin 0px`, m.a2.marginTop === "0px", m.a2.marginTop);
    check(`${tag}: user end margin ${desktop ? "-48px" : "-96px"}`, m.u2.marginTop === (desktop ? "-48px" : "-96px"), m.u2.marginTop);
    check(`${tag}: user single margin ${desktop ? "-48px" : "-96px"}`, m.u3.marginTop === (desktop ? "-48px" : "-96px"), m.u3.marginTop);
  } else {
    check(`${tag}: assistant content opaque`, m.a1.alpha === 1 && m.a2.alpha === 1);
    check(`${tag}: prose reply ≤ 640px`, m.a2.width <= 640.5, String(m.a2.width));
    if (m.lane.width > 641) check(`${tag}: prose reply narrower than the lane`, m.a2.width < m.lane.width - 1, `${m.a2.width} vs ${m.lane.width}`);
    check(`${tag}: image reply spans the lane`, near(m.a1.width, m.lane.width), `${m.a1.width} vs ${m.lane.width}`);
    check(`${tag}: group row-gap 16px`, m.rowGap === "16px", m.rowGap);
    check(`${tag}: assistant single margin 0px`, m.a2.marginTop === "0px", m.a2.marginTop);
    check(`${tag}: user end margin ${desktop ? "-60px" : "-108px"}`, m.u2.marginTop === (desktop ? "-60px" : "-108px"), m.u2.marginTop);
    check(`${tag}: user single margin ${desktop ? "-48px" : "-96px"}`, m.u3.marginTop === (desktop ? "-48px" : "-96px"), m.u3.marginTop);
    // Computed max-width keeps the min() expression, so check the rendered width (u2 is wider than the cap in timeline).
    check(`${tag}: user bubble ≤ 544px`, m.u2.width <= 544.5 && m.u2.maxWidth.includes("544px"), `${m.u2.width} / ${m.u2.maxWidth}`);
    check(`${tag}: user bubble end edge on the lane end`, near(m.u2.right, m.lane.right), `${m.u2.right} vs ${m.lane.right}`);
    check(`${tag}: assistant bubble start edge on the lane start`, near(m.a2.left, m.lane.left) && near(m.a1.left, m.lane.left), `${m.a2.left} vs ${m.lane.left}`);
  }
  await page.screenshot({ path: `${SHOTS}/${layout}-${vp.name}.png`, fullPage: false });

  // Expanded work log stays inside a1 and widens nothing.
  const a1 = page.locator(`[data-message-id="${ids.a1}"]`);
  const trigger = a1.locator('[data-slot="tool-group-trigger"]').first();
  await trigger.scrollIntoViewIfNeeded();
  // The cached history is swapped for the server's rows shortly after load, which resets a group opened
  // before the swap; retry the click until the group stays open.
  for (let attempt = 0; attempt < 5 && (await trigger.getAttribute("aria-expanded")) !== "true"; attempt++) {
    await trigger.click();
    await page.waitForTimeout(400);
  }
  const reasoning = a1.getByText("Thinking about the bubble fixture reasoning.").first();
  // The search is its own one-line row inside the group; open it to show the results.
  const searchRow = a1.getByRole("button", { name: /bubble layout/ }).first();
  await searchRow.waitFor({ state: "visible", timeout: 5_000 });
  for (let attempt = 0; attempt < 5 && (await searchRow.getAttribute("aria-expanded")) !== "true"; attempt++) {
    await searchRow.click();
    await page.waitForTimeout(400);
  }
  await a1.getByText("Bubble result one").first().waitFor({ state: "visible", timeout: 5_000 });
  await reasoning.waitFor({ state: "visible", timeout: 5_000 });
  const inside = await page.evaluate((id) => {
    const content = document.querySelector(`[data-message-id="${id}"] [data-slot="aui_assistant-message-content"]`);
    const box = content.getBoundingClientRect();
    const find = (text) => [...content.querySelectorAll("*")].find((el) => el.childElementCount === 0 && el.textContent?.includes(text));
    const within = (el) => { const r = el.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1; };
    const one = find("Bubble result one"), two = find("Bubble result two"), why = find("Thinking about the bubble fixture reasoning.");
    return { found: !!(one && two && why), inside: !!(one && two && why) && within(one) && within(two) && within(why), scroll: document.documentElement.scrollWidth <= window.innerWidth + 1 };
  }, ids.a1);
  check(`${tag}: expanded work log shows results and reasoning inside a1`, inside.found && inside.inside, JSON.stringify(inside));
  check(`${tag}: expanded work log causes no horizontal scroll`, inside.scroll);
  await page.screenshot({ path: `${SHOTS}/${layout}-${vp.name}-worklog.png`, fullPage: false });

  // The last message's action menu opens fully inside the viewport.
  const a2 = page.locator(`[data-message-id="${ids.a2}"]`);
  await a2.scrollIntoViewIfNeeded();
  const more = a2.locator('[data-command="message.more"]').first();
  if (!(await more.isVisible())) await a2.hover();
  await more.click();
  const menu = page.locator('[role="menu"]').first();
  await menu.waitFor({ state: "visible", timeout: 5_000 });
  const box = await menu.boundingBox();
  const size = page.viewportSize();
  check(`${tag}: action menu fully inside the viewport`, !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 0.5 && box.y + box.height <= size.height + 0.5, JSON.stringify(box));
  await page.screenshot({ path: `${SHOTS}/${layout}-${vp.name}-menu.png`, fullPage: false });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: 5_000 });
}

/** Switches the layout from the settings page in a second tab, then refreshes the chat tab through focus. */
async function switchLive(context, chat, target, vp) {
  const tag = `${target}@${vp.name}`;
  await chat.evaluate((id) => {
    window.__bubbleRoot = document.querySelector(`[data-message-id="${id}"]`);
    window.__bubbleThread = document.querySelector(".aui-thread-root");
  }, ids.a1);
  const settings = await context.newPage();
  const done = watch(settings, `${tag} settings`);
  await settings.goto(`${BASE}/settings/appearance`);
  const select = settings.getByRole("combobox", { name: "Message layout" });
  await select.waitFor({ state: "visible", timeout: 15_000 });
  check(`${tag}: settings shows the Message layout row`, await settings.getByText("Message layout", { exact: true }).first().isVisible());
  await select.scrollIntoViewIfNeeded();
  await select.click();
  const patched = settings.waitForResponse((r) => r.url().endsWith("/api/appearance") && r.request().method() === "PATCH", { timeout: 10_000 });
  await settings.getByRole("option", { name: target === "bubbles" ? "Bubbles" : "Timeline (default)" }).click();
  const response = await patched;
  check(`${tag}: PATCH /api/appearance sends one key`, response.ok() && JSON.stringify(response.request().postDataJSON()) === JSON.stringify({ messageLayout: target }), response.request().postData() ?? "");
  done();
  await settings.close();
  await chat.bringToFront();
  await chat.evaluate(() => window.dispatchEvent(new Event("focus")));
  await chat.waitForFunction((l) => (document.documentElement.dataset.messageLayout ?? "timeline") === l, target, { timeout: 10_000 });
  const same = await chat.evaluate((id) => ({
    navigations: performance.getEntriesByType("navigation").length,
    root: window.__bubbleRoot === document.querySelector(`[data-message-id="${id}"]`) && !!window.__bubbleRoot,
    thread: window.__bubbleThread === document.querySelector(".aui-thread-root") && !!window.__bubbleThread,
  }), ids.a1);
  check(`${tag}: live switch without reload`, same.navigations === 1);
  check(`${tag}: live switch keeps message and thread nodes`, same.root && same.thread, JSON.stringify(same));
}

const browser = await chromium.launch();
let fixture;
let originalLayout;
let current;
const setup = await browser.newContext({ locale: "en-US" });
const setupPage = await setup.newPage();
try {
  await setupPage.goto(`${BASE}/`);
  const login = await api(setupPage, "/auth/login", { method: "POST", json: { email: EMAIL, password: PASSWORD } });
  check("sign in", login.status === 200, String(login.status));
  // Opening the app once initializes the account's appearance snapshot if it has none.
  await setupPage.goto(`${BASE}/`);
  await setupPage.waitForFunction(() => document.documentElement.dataset.messageLayout !== undefined, null, { timeout: 15_000 });
  await setupPage.waitForTimeout(1000);
  originalLayout = (await api(setupPage, "/appearance")).body?.messageLayout ?? "timeline";
  fixture = await createFixture(setupPage);
  check("fixture created", !!fixture.threadId && !!fixture.fileId, JSON.stringify(fixture));
  const cookies = (await setup.storageState()).cookies;
  // Leave the app so this tab holds no live connection; same-origin fetches still work from here.
  await setupPage.goto(`${BASE}/api/auth/status`);

  for (const vp of VIEWPORTS) {
    check(`${vp.name}: start in timeline`, (await api(setupPage, "/appearance", { method: "PATCH", json: { messageLayout: "timeline" } })).status === 200);
    const context = await browser.newContext({ ...vp.options, locale: "en-US", storageState: { cookies, origins: [] } });
    // Records the attribute in the first frame after DOMContentLoaded (used after the reload below).
    await context.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => requestAnimationFrame(() => {
        window.__firstFrameLayout = document.documentElement.dataset.messageLayout ?? null;
      }));
    });
    const chat = await context.newPage();
    const done = watch(chat, vp.name);
    await chat.goto(`${BASE}/c/${fixture.threadId}`);
    current = chat;
    await checkLayout(chat, "timeline", vp);
    await switchLive(context, chat, "bubbles", vp);
    await checkLayout(chat, "bubbles", vp);

    // A reload keeps bubbles, and the first frame already carries it.
    await chat.reload();
    await chat.locator(`[data-message-id="${ids.a2}"]`).waitFor();
    const first = await chat.evaluate(() => window.__firstFrameLayout);
    check(`bubbles@${vp.name}: reload keeps bubbles`, (await chat.evaluate(() => document.documentElement.dataset.messageLayout)) === "bubbles");
    check(`bubbles@${vp.name}: first frame after reload is already bubbles`, first === "bubbles", String(first));
    await checkLayout(chat, "bubbles", vp);
    await switchLive(context, chat, "timeline", vp);
    await checkLayout(chat, "timeline", vp);
    done();
    await context.close();
  }
} catch (error) {
  failures ||= 1;
  console.log(`FAIL ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  await current?.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => {});
} finally {
  if (fixture?.threadId) await api(setupPage, `/threads/${fixture.threadId}`, { method: "DELETE" }).catch(() => {});
  if (fixture?.fileId) await api(setupPage, `/library/upload/${fixture.fileId}`, { method: "DELETE" }).catch(() => {});
  if (originalLayout) await api(setupPage, "/appearance", { method: "PATCH", json: { messageLayout: originalLayout } }).catch(() => {});
  await browser.close();
}
console.log(failures ? `FAILED (${failures})` : "ALL PASS");
process.exit(failures ? 1 : 0);
