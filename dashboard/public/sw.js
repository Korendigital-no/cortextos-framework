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
//   - Build assets (/_next/static) + icons: stale-while-revalidate. Turbopack
//     reuses chunk filenames across builds (module-id based, not content-hash)
//     while Next serves them `immutable, max-age=1y`. A plain cache-first — or
//     the browser's own HTTP cache — therefore pins STALE JS under a still-live
//     filename after a deploy (e.g. a nav change shipped but not seen). We serve
//     the cached copy instantly for speed, but always revalidate from the
//     network bypassing the HTTP cache (cache: "reload") and update the cache,
//     so a changed-content same-name chunk self-heals on the next load.
//
// Bump CACHE_VERSION to invalidate old caches on the next activate.
const CACHE_VERSION = "v3";
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

  // Build assets + icons: stale-while-revalidate (see header note). Always
  // revalidate from the network with cache: "reload" so the browser's own
  // `immutable` HTTP cache can't pin a stale chunk under a reused filename.
  if (url.pathname.startsWith("/_next/static") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        const revalidate = fetch(request, { cache: "reload" })
          .then((res) => {
            // Keep the cache write alive past respondWith via waitUntil — without
            // it the worker can be terminated (notably on mobile) before the put
            // finishes, so the asset is never persisted for offline use (codex P2).
            if (res.ok) event.waitUntil(cache.put(request, res.clone()));
            return res;
          })
          .catch(() => undefined);
        // Serve cache instantly when present, but let the refresh finish in the
        // background so the next load gets the new content. On a miss, await it.
        if (cached) {
          event.waitUntil(revalidate);
          return cached;
        }
        return (await revalidate) ?? Response.error();
      })(),
    );
  }
});
