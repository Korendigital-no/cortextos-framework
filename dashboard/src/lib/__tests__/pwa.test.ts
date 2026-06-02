import { describe, it, expect, vi } from "vitest";
import { syncServiceWorker, enableUpdateAutoReload } from "../pwa";

// Service-worker lifecycle (codex P2): production registers; development must
// actively UNREGISTER any stale worker (not merely skip) so a SW left from a
// production run on the same origin can't break HMR by serving cached assets.

function fakeSw(registrations: Array<{ unregister: () => Promise<boolean> }> = []) {
  return {
    register: vi.fn(async () => ({}) as ServiceWorkerRegistration),
    getRegistrations: vi.fn(async () => registrations as unknown as readonly ServiceWorkerRegistration[]),
  };
}

function fakeCaches(keys: string[]) {
  return {
    keys: vi.fn(async () => keys),
    delete: vi.fn(async () => true),
  };
}

describe("syncServiceWorker", () => {
  it("registers /sw.js in production", async () => {
    const sw = fakeSw();
    const result = await syncServiceWorker({ isProduction: true, sw });
    expect(result).toBe("registered");
    expect(sw.register).toHaveBeenCalledWith("/sw.js");
    expect(sw.getRegistrations).not.toHaveBeenCalled();
  });

  it("unregisters a stale worker in development (does not register)", async () => {
    const unregister = vi.fn(async () => true);
    const sw = fakeSw([{ unregister }]);
    const result = await syncServiceWorker({ isProduction: false, sw });
    expect(result).toBe("unregistered");
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(sw.register).not.toHaveBeenCalled();
  });

  it("drops only cortextos-* caches in development", async () => {
    const sw = fakeSw([{ unregister: vi.fn(async () => true) }]);
    const cacheStorage = fakeCaches(["cortextos-v1", "some-other-cache", "cortextos-v2"]);
    await syncServiceWorker({ isProduction: false, sw, cacheStorage });
    expect(cacheStorage.delete).toHaveBeenCalledTimes(2);
    expect(cacheStorage.delete).toHaveBeenCalledWith("cortextos-v1");
    expect(cacheStorage.delete).toHaveBeenCalledWith("cortextos-v2");
    expect(cacheStorage.delete).not.toHaveBeenCalledWith("some-other-cache");
  });

  it("is a no-op 'skipped' in dev when nothing is installed", async () => {
    const sw = fakeSw([]);
    const result = await syncServiceWorker({ isProduction: false, sw });
    expect(result).toBe("skipped");
    expect(sw.register).not.toHaveBeenCalled();
  });

  it("skips when service workers are unsupported (no container)", async () => {
    const result = await syncServiceWorker({ isProduction: true, sw: undefined });
    expect(result).toBe("skipped");
  });
});

// --- enableUpdateAutoReload ---
// When a new SW takes control after a deploy, reload once so the page swaps the
// stale chunks for fresh ones — without the broken-reload window. Must NOT
// reload on the initial first-install claim, and must NEVER loop.

function fakeUpdateSw(controller: object | null) {
  let listener: (() => void) | undefined;
  const addEventListener = vi.fn((type: string, fn: () => void) => {
    if (type === "controllerchange") listener = fn;
  });
  const container = { controller, addEventListener } as unknown as Pick<
    ServiceWorkerContainer,
    "controller" | "addEventListener"
  >;
  return { container, addEventListener, fire: () => listener?.() };
}

function fakeStorage(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    getItem: vi.fn((k: string) => (k in store ? store[k] : null)),
    setItem: vi.fn((k: string, v: string) => {
      store[k] = v;
    }),
  };
}

describe("enableUpdateAutoReload", () => {
  it("does NOT wire or reload on the initial install (no existing controller)", () => {
    const sw = fakeUpdateSw(null);
    const reload = vi.fn();
    const wired = enableUpdateAutoReload({
      sw: sw.container,
      storage: fakeStorage(),
      now: () => 1_000_000,
      reload,
    });
    expect(wired).toBe(false);
    expect(sw.addEventListener).not.toHaveBeenCalled();
    sw.fire();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads once on a real controller change (an update)", () => {
    const sw = fakeUpdateSw({});
    const reload = vi.fn();
    const storage = fakeStorage();
    const wired = enableUpdateAutoReload({
      sw: sw.container,
      storage,
      now: () => 1_000_000,
      reload,
    });
    expect(wired).toBe(true);
    sw.fire();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith("cortextos-sw-last-reload", "1000000");
  });

  it("loop guard: does NOT reload again within the guard window", () => {
    const sw = fakeUpdateSw({});
    const reload = vi.fn();
    // last auto-reload was 2s ago; guard window is 10s -> skip.
    const storage = fakeStorage({ "cortextos-sw-last-reload": "998000" });
    enableUpdateAutoReload({ sw: sw.container, storage, now: () => 1_000_000, reload, loopGuardMs: 10_000 });
    sw.fire();
    expect(reload).not.toHaveBeenCalled();
  });

  it("future deploy passes the guard once enough time has elapsed", () => {
    const sw = fakeUpdateSw({});
    const reload = vi.fn();
    // last auto-reload was 60s ago; guard window 10s -> allowed.
    const storage = fakeStorage({ "cortextos-sw-last-reload": "940000" });
    enableUpdateAutoReload({ sw: sw.container, storage, now: () => 1_000_000, reload, loopGuardMs: 10_000 });
    sw.fire();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads at most once per page life even if controllerchange fires twice", () => {
    const sw = fakeUpdateSw({});
    const reload = vi.fn();
    enableUpdateAutoReload({ sw: sw.container, storage: fakeStorage(), now: () => 1_000_000, reload });
    sw.fire();
    sw.fire();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still reloads when storage throws (private mode / quota)", () => {
    const sw = fakeUpdateSw({});
    const reload = vi.fn();
    const throwingStorage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    };
    enableUpdateAutoReload({ sw: sw.container, storage: throwingStorage, now: () => 1_000_000, reload });
    sw.fire();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
