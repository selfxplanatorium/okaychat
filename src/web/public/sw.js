// okaychat service worker. Makes the app installable and keeps the shell
// available on a flaky connection. Never touches /api: chat streams, auth, and
// user data always go to the network.
const CACHE = "okaychat-shell-v2";
const SHELL = ["/", "/manifest.webmanifest", "/icon.webp", "/wordmark.svg", "/icon-192.png", "/favicon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function putInCache(request, response) {
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // The desktop helper and its published checksum must match the running deployment, never a stale cache.
  if (url.pathname === "/chatgpt-connect.mjs" || url.pathname === "/chatgpt-connect.mjs.sha256") return;

  // Pages: the network decides, so a deploy is picked up on the next load.
  // Offline, every route falls back to the cached SPA shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => (url.pathname === "/" ? putInCache("/", response) : response))
        .catch(async () => (await caches.match("/")) ?? Response.error()),
    );
    return;
  }

  // Built assets carry a content hash, so a cached copy is always correct.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request).then((response) => putInCache(request, response))));
    return;
  }

  // Icons, fonts, and other public files: answer from cache, refresh behind it.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => putInCache(request, response))
        .catch(() => hit ?? Response.error());
      if (hit) event.waitUntil(network);
      return hit ?? network;
    }),
  );
});
