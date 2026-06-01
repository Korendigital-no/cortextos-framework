import { describe, it, expect, vi } from "vitest";
import { syncServiceWorker } from "../pwa";

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
