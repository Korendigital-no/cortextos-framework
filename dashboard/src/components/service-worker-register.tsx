"use client";

import { useEffect } from "react";
import { enableUpdateAutoReload, syncServiceWorker } from "@/lib/pwa";

// Drives the service worker lifecycle (PWA installability + offline shell).
// Renders nothing. In production it registers /sw.js and auto-reloads once when
// a new worker takes control after a deploy (so fresh chunks replace stale ones
// without the "Something went wrong" broken-reload window); in development it
// unregisters any stale worker left from a production run on the same origin
// (which would otherwise break HMR by serving cached assets). The actual logic
// lives in @/lib/pwa so it's unit-testable without a DOM.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const isProduction = process.env.NODE_ENV === "production";

    // Wire the update auto-reload listener IMMEDIATELY — not deferred to `load`.
    // An updated worker can claim this already-controlled page and fire
    // `controllerchange` before the window load event, and we must not miss it
    // (that would leave the page on the broken-reload path this is meant to fix).
    // Reading `sessionStorage` can itself throw a SecurityError when Web Storage
    // is blocked, so the access stays INSIDE the try — a failure here must never
    // prevent the service worker registration below.
    if (isProduction) {
      try {
        enableUpdateAutoReload({
          sw: navigator.serviceWorker,
          storage: sessionStorage,
          now: () => Date.now(),
          reload: () => window.location.reload(),
        });
      } catch (err) {
        console.error("[pwa] update auto-reload wiring failed:", err);
      }
    }

    const run = () => {
      syncServiceWorker({
        isProduction,
        sw: navigator.serviceWorker,
        cacheStorage: typeof caches !== "undefined" ? caches : undefined,
      }).catch((err) => {
        // Progressive enhancement — never throw into the app.
        console.error("[pwa] service worker sync failed:", err);
      });
    };

    // Defer to load so registration doesn't contend with first paint.
    if (document.readyState === "complete") run();
    else {
      window.addEventListener("load", run, { once: true });
      return () => window.removeEventListener("load", run);
    }
  }, []);

  return null;
}
