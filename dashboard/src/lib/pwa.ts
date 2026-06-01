// Service-worker lifecycle, factored out of the React component so it can be
// unit-tested in a plain Node env (no DOM). Dependency-injected: the caller
// passes the ServiceWorkerContainer + CacheStorage so tests can mock them.

export type SwSyncResult = "registered" | "unregistered" | "skipped";

const CACHE_PREFIX = "cortextos-";

export interface SwSyncOptions {
  isProduction: boolean;
  sw?: Pick<ServiceWorkerContainer, "register" | "getRegistrations">;
  cacheStorage?: Pick<CacheStorage, "keys" | "delete">;
}

/**
 * Production: register `/sw.js`.
 *
 * Development: do NOT just skip — actively unregister any service worker left
 * over from a production run on the same origin (localhost serves both
 * `next start` and `next dev`). A lingering worker keeps controlling the page
 * and serves `/_next/static` cache-first, which breaks HMR and ships stale
 * assets (codex P2). We also drop the caches our SW created so dev never serves
 * stale bytes.
 */
export async function syncServiceWorker(opts: SwSyncOptions): Promise<SwSyncResult> {
  const { isProduction, sw, cacheStorage } = opts;
  if (!sw) return "skipped";

  if (!isProduction) {
    const regs = await sw.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    if (cacheStorage) {
      const keys = await cacheStorage.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => cacheStorage.delete(k)),
      );
    }
    return regs.length > 0 ? "unregistered" : "skipped";
  }

  await sw.register("/sw.js");
  return "registered";
}
