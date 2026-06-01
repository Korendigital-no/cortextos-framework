"use client";

import { useEffect } from "react";
import { syncServiceWorker } from "@/lib/pwa";

// Drives the service worker lifecycle (PWA installability + offline shell).
// Renders nothing. In production it registers /sw.js; in development it
// unregisters any stale worker left from a production run on the same origin
// (which would otherwise break HMR by serving cached assets). The actual logic
// lives in @/lib/pwa so it's unit-testable without a DOM.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const run = () => {
      syncServiceWorker({
        isProduction: process.env.NODE_ENV === "production",
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
