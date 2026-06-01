// cortextOS dashboard service worker.
//
// Goals: make the app installable (Chrome requires a SW with a fetch handler)
// and give a graceful offline shell — without ever serving stale authed data.
//
// Strategy:
//   - GET only; never touch mutations.
//   - Same-origin only.
//   - /api/* is NEVER intercepted — auth-sensitive + dynamic, always live.
//   - Navigations: network-first, fall back to the cached /offline shell when
//     the network is down. Authed HTML is never cached, so no stale-data risk.
//   - Build assets (/_next/static) + icons: cache-first (fast, offline-capable).
//
// Bump CACHE_VERSION to invalidate old caches on the next activate.
const CACHE_VERSION = "v1";
const CACHE_PREFIX = "cortextos-";
const CACHE = `${CACHE_PREFIX}${CACHE_VERSION}`;
const OFFLINE_URL = "/offline";
const PRECACHE = [OFFLINE_URL, "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll is atomic-ish: if any precache request fails the install fails,
      // so wrap individually to avoid a single 404 wedging activation.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const res = await fetch(url, { cache: "no-cache" });
            if (res.ok) await cache.put(url, res);
          } catch {
            /* best effort — offline shell still works once online */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Only evict OUR own old cache versions. CacheStorage is origin-wide, so
      // deleting every non-current cache could wipe unrelated offline data if
      // the dashboard ever shares an origin with other code (codex P3).
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never intercept API/auth

  // Navigations: network-first, offline shell as fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE);
          const offline = await cache.match(OFFLINE_URL);
          return offline ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Build assets + icons: cache-first, populate on miss.
  if (url.pathname.startsWith("/_next/static") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const res = await fetch(request);
          // Keep the cache write alive past respondWith via waitUntil — without
          // it the worker can be terminated (notably on mobile) before the put
          // finishes, so the asset is never persisted for offline use (codex P2).
          if (res.ok) event.waitUntil(cache.put(request, res.clone()));
          return res;
        } catch {
          return cached ?? Response.error();
        }
      })(),
    );
  }
});

// Let the page trigger an immediate update (skip the waiting state).
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
