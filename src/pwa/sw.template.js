/*
 * Al Qarib service worker — deliberately tiny and allowlist-only (document 12, PWA-03..07).
 *
 * WHAT IT DOES
 *   1. Precaches a fixed list of PUBLIC files: the generic offline document and app icons.
 *   2. Serves the generic offline document when a page navigation cannot reach the network.
 *   3. Serves exactly the precached public files cache-first.
 *
 * WHAT IT NEVER DOES
 *   - It never caches or answers /api/**, authentication routes, page HTML, Next.js RSC/Flight
 *     or prefetch payloads, server actions, statements, payroll, reports, receipts or any
 *     download. Those requests are not intercepted at all: they go straight to the network.
 *   - It never caches a navigation response, never uses stale-while-revalidate, never stores a
 *     response for a request it was not explicitly told about, and has no Background Sync,
 *     IndexedDB or replay queue. Installing the app does not enable offline banking.
 *   - It never calls skipWaiting() on its own: the page asks the person first (PWA-07).
 *
 * The build identifier and the precache list below are substituted by
 * scripts/build-service-worker.mjs (the placeholder names appear only in the code).
 */
const BUILD_ID = "__BUILD_ID__";
const CACHE_PREFIX = "alqarib-public-";
const CACHE_NAME = CACHE_PREFIX + BUILD_ID;
const OFFLINE_URL = "/offline.html";
const PRECACHE_URLS = __PRECACHE__;
const PRECACHE_PATHS = new Set(PRECACHE_URLS);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: "reload" })))),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      // Remove only this application's obsolete public caches; never touch other storage.
      await Promise.all(
        names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "GET_VERSION" && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ buildId: BUILD_ID, cacheName: CACHE_NAME, precache: PRECACHE_URLS });
  }
});

function isPrecachedPublicAsset(request, url) {
  return (
    request.method === "GET" &&
    url.origin === self.location.origin &&
    url.search === "" &&
    !request.headers.has("authorization") &&
    PRECACHE_PATHS.has(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (isPrecachedPublicAsset(request, url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => cache.match(url.pathname).then((hit) => hit || fetch(request))),
    );
    return;
  }

  if (request.mode === "navigate" && request.method === "GET") {
    // Network only. The response is returned untouched and is NEVER written to a cache.
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const offline = await cache.match(OFFLINE_URL);
        return (
          offline ||
          new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } })
        );
      }),
    );
    return;
  }

  // Everything else — APIs, RSC/Flight, auth, downloads, scripts, styles — is not intercepted.
});
