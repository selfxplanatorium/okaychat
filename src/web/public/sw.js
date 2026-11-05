// okaychat service worker. Makes the app installable and keeps the shell
// available on a flaky connection. Never touches /api or /v1: chat streams, the external API,
// auth, and user data always go to the network.
const SHELL_CACHE = "okaychat-shell-v4";
const ASSET_CACHE = "okaychat-assets-v1";
// Hashed assets are immutable, but a browser can open many builds' chunks over time. The cache is bounded
// so a long-lived install cannot grow without limit; entries are pruned in insertion order (FIFO).
const ASSET_LIMIT = 256;
const SHELL = ["/", "/manifest.webmanifest", "/icon.webp", "/wordmark.svg", "/icon-192.png", "/favicon.png"];
const OWN_CACHES = [SHELL_CACHE, ASSET_CACHE];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        // Only this app's caches: another app can share the origin.
        Promise.all(keys.filter((key) => key.startsWith("okaychat-") && !OWN_CACHES.includes(key)).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

// A failed write must never fail the page load: the network response is returned either way. The caller
// passes a clone made synchronously, before the original response is handed to the page.
async function putInCache(cacheName, request, response) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
    return true;
  } catch {
    return false;
  }
}

async function trimAssets() {
  try {
    const cache = await caches.open(ASSET_CACHE);
    const keys = await cache.keys();
    for (let index = 0; index < keys.length - ASSET_LIMIT; index++) await cache.delete(keys[index]);
  } catch {
    // A cache that cannot be pruned still serves what it has; quota errors already left it unbounded only by one entry.
  }
}

const isHtml = (response) => response.ok && (response.headers.get("content-type") ?? "").includes("text/html");

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/v1" || url.pathname.startsWith("/v1/")) return;
  // The desktop helper and its published checksum must match the running deployment, never a stale cache.
  if (url.pathname === "/chatgpt-connect.mjs" || url.pathname === "/chatgpt-connect.mjs.sha256") return;

  // Pages: the network decides, so a deploy is picked up on the next load. The latest same-origin shell is
  // kept for offline deep links regardless of the route it came from. Offline, every route falls back to it.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (isHtml(response)) event.waitUntil(putInCache(SHELL_CACHE, "/", response.clone()));
          return response;
        })
        .catch(async () => (await caches.match("/", { cacheName: SHELL_CACHE })) ?? Response.error()),
    );
    return;
  }

  // Built assets carry a content hash, so a cached copy is always correct.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request, { cacheName: ASSET_CACHE }).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok && response.type === "basic") {
              event.waitUntil(putInCache(ASSET_CACHE, request, response.clone()).then(() => trimAssets()));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Icons, fonts, and other public files: answer from cache, refresh behind it.
  event.respondWith(
    caches.match(request, { cacheName: SHELL_CACHE }).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          event.waitUntil(putInCache(SHELL_CACHE, request, response.clone()));
          return response;
        })
        .catch(() => hit ?? Response.error());
      if (hit) event.waitUntil(network);
      return hit ?? network;
    }),
  );
});

// A system notification opens the app: focus an existing window on the same origin and navigate it to
// the notice's target, or open a new one. The target is always an app path from the server.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : "/";
  event.waitUntil(
    (async () => {
      const url = new URL(target, self.location.origin);
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        if ("navigate" in existing) await existing.navigate(url.href).catch(() => {});
        return;
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
