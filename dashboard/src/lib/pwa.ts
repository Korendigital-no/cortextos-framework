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

const RELOAD_TS_KEY = "cortextos-sw-last-reload";
const DEFAULT_LOOP_GUARD_MS = 10_000;

export interface UpdateAutoReloadOptions {
  sw: Pick<ServiceWorkerContainer, "controller" | "addEventListener">;
  storage: Pick<Storage, "getItem" | "setItem">;
  now: () => number;
  reload: () => void;
  /** Min gap between auto-reloads; shorter repeats are treated as a loop. */
  loopGuardMs?: number;
}

/**
 * Reload the page exactly once when a NEW service worker takes control after a
 * deploy, so the page swaps stale `/_next/static` chunks for the fresh build
 * instead of leaving the user on a broken page (the "Something went wrong"
 * error boundary). Without this, a poisoned client self-heals only on a SECOND
 * manual reload — one broken-reload window per deploy.
 *
 * Safe by construction:
 *  - Only wires when a controller ALREADY exists. On a first-ever visit there
 *    is no controller, so the initial install's `controllerchange` is the page
 *    gaining its first SW — NOT an update — and must not trigger a reload.
 *  - One reload per page life (in-memory guard).
 *  - Loop guard: refuses to reload again within `loopGuardMs` of the last
 *    auto-reload (persisted timestamp), so a pathologically re-activating SW can
 *    never spin the page in an infinite reload loop. Real deploys are minutes
 *    apart and always clear the window.
 *
 * Returns whether the listener was wired (false on a first install).
 */
export function enableUpdateAutoReload(opts: UpdateAutoReloadOptions): boolean {
  const { sw, storage, now, reload, loopGuardMs = DEFAULT_LOOP_GUARD_MS } = opts;
  // No pre-existing controller => first SW claim for this page, not an update.
  if (!sw.controller) return false;

  let reloaded = false;
  sw.addEventListener("controllerchange", () => {
    if (reloaded) return; // at most one reload per page life
    // Storage can throw (private mode, full quota). Read defensively; an
    // unreadable timestamp just means "no prior reload" — the controllerchange
    // event itself is the real gate against loops (it only fires on an actual
    // worker swap, which does not recur without a new deploy).
    let last = 0;
    try {
      last = Number(storage.getItem(RELOAD_TS_KEY) ?? "0");
    } catch {
      last = 0;
    }
    if (now() - last < loopGuardMs) return; // loop guard
    reloaded = true;
    try {
      storage.setItem(RELOAD_TS_KEY, String(now()));
    } catch {
      /* persisting the guard timestamp is best-effort — still reload below */
    }
    reload();
  });
  return true;
}
