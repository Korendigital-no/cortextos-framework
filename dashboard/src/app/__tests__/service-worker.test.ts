import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// The service worker is plain JS in public/ (not imported by the app), so we
// load its source into a sandboxed fake ServiceWorkerGlobalScope and exercise
// the fetch-routing logic — the part most likely to break (and the part that
// must NEVER intercept auth-sensitive /api/* or non-GET requests).

const SW_SRC = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "public", "sw.js"),
  "utf-8",
);
const ORIGIN = "https://dash.example.com";

type Listeners = Record<string, (event: unknown) => void>;

function loadSW() {
  const listeners: Listeners = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
  };
  const cache = {
    match: vi.fn(async (): Promise<Response | undefined> => undefined),
    put: vi.fn(),
    addAll: vi.fn(),
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async (): Promise<string[]> => []),
    delete: vi.fn(async (_key: string): Promise<boolean> => true),
  };
  const fetchMock = vi.fn(async (_input?: unknown, _init?: unknown) => new Response("ok", { status: 200 }));
  // Execute the committed SW source in an isolated VM context. `self` resolves
  // to our fake ServiceWorkerGlobalScope; the remaining globals are provided so
  // the SW's bare references (caches/fetch/Response/URL) bind to our mocks.
  const context: vm.Context = vm.createContext({
    self,
    caches,
    fetch: fetchMock,
    Response,
    URL,
    console,
  });
  vm.runInContext(SW_SRC, context, { filename: "sw.js" });
  return { listeners, self, caches, fetchMock };
}

function fetchEvent(urlPath: string, init: { method?: string; mode?: string } = {}) {
  const respondWith = vi.fn();
  const waitUntil = vi.fn((p: unknown) => p);
  const event = {
    request: {
      url: urlPath.startsWith("http") ? urlPath : `${ORIGIN}${urlPath}`,
      method: init.method ?? "GET",
      mode: init.mode ?? "no-cors",
      clone: () => ({}),
    },
    respondWith,
    waitUntil,
  };
  return { event, respondWith, waitUntil };
}

// Dispatches a lifecycle (install/activate) event and resolves once its
// waitUntil promise settles.
async function runLifecycle(handler: (event: unknown) => void) {
  let captured: Promise<unknown> = Promise.resolve();
  handler({ waitUntil: (p: Promise<unknown>) => { captured = p; } });
  await captured;
}

describe("service worker", () => {
  let sw: ReturnType<typeof loadSW>;
  beforeEach(() => {
    sw = loadSW();
  });

  it("registers install, activate and fetch handlers", () => {
    expect(typeof sw.listeners.install).toBe("function");
    expect(typeof sw.listeners.activate).toBe("function");
    expect(typeof sw.listeners.fetch).toBe("function");
  });

  it("NEVER intercepts /api/* (auth-sensitive, must stay live)", () => {
    const { event, respondWith } = fetchEvent("/api/agents", { mode: "navigate" });
    sw.listeners.fetch(event);
    expect(respondWith).not.toHaveBeenCalled();
  });

  it("NEVER intercepts non-GET requests", () => {
    const { event, respondWith } = fetchEvent("/content", { method: "POST", mode: "navigate" });
    sw.listeners.fetch(event);
    expect(respondWith).not.toHaveBeenCalled();
  });

  it("does not intercept cross-origin requests", () => {
    const { event, respondWith } = fetchEvent("https://other.example.com/x.js");
    sw.listeners.fetch(event);
    expect(respondWith).not.toHaveBeenCalled();
  });

  it("handles navigations (network-first with offline fallback)", () => {
    const { event, respondWith } = fetchEvent("/dashboard", { mode: "navigate" });
    sw.listeners.fetch(event);
    expect(respondWith).toHaveBeenCalledTimes(1);
  });

  it("handles build assets + icons (stale-while-revalidate)", () => {
    const a = fetchEvent("/_next/static/chunks/main.js");
    sw.listeners.fetch(a.event);
    expect(a.respondWith).toHaveBeenCalledTimes(1);

    const b = fetchEvent("/icons/icon-192.png");
    sw.listeners.fetch(b.event);
    expect(b.respondWith).toHaveBeenCalledTimes(1);
  });

  it("revalidates build assets from network bypassing the HTTP cache", async () => {
    // Stale-while-revalidate must refetch with cache:"reload" so the browser's
    // own `immutable` HTTP cache can't pin a stale chunk under a reused filename.
    const { event, respondWith } = fetchEvent("/_next/static/chunks/x.js");
    sw.listeners.fetch(event);
    await respondWith.mock.calls[0][0];
    expect(sw.fetchMock).toHaveBeenCalledTimes(1);
    expect(sw.fetchMock.mock.calls[0][1]).toMatchObject({ cache: "reload" });
  });

  it("keeps the asset cache write alive via waitUntil on a cache miss", async () => {
    // match → undefined (miss); fetch → ok. The put must be handed to
    // event.waitUntil so the worker isn't killed before it persists (codex P2).
    const { event, respondWith, waitUntil } = fetchEvent("/_next/static/chunks/x.js");
    sw.listeners.fetch(event);
    await respondWith.mock.calls[0][0]; // let the async handler run to the put
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("serves cached asset instantly and revalidates in the background on a hit", async () => {
    const hit = new Response("cached-chunk", { status: 200 });
    sw.caches.open.mockResolvedValueOnce({
      match: vi.fn(async () => hit),
      put: vi.fn(),
      addAll: vi.fn(),
    });
    const { event, respondWith, waitUntil } = fetchEvent("/_next/static/chunks/x.js");
    sw.listeners.fetch(event);
    const res = await respondWith.mock.calls[0][0];
    expect(await res.text()).toBe("cached-chunk"); // instant cached copy
    expect(waitUntil).toHaveBeenCalled(); // background revalidate kept alive
    expect(sw.fetchMock).toHaveBeenCalledWith(expect.anything(), { cache: "reload" });
  });

  it("activate evicts ALL older cortextos-* caches, keeps current + foreign", async () => {
    sw.caches.keys.mockResolvedValueOnce([
      "cortextos-v0", // ours, old → delete
      "cortextos-v1", // ours, old → delete (current is now v2)
      "cortextos-v2", // ours, current → keep
      "some-other-app-cache", // not ours → keep (codex P3)
    ]);
    await runLifecycle(sw.listeners.activate);
    const deleted = sw.caches.delete.mock.calls.map((c) => c[0]).sort();
    expect(deleted).toEqual(["cortextos-v0", "cortextos-v1"]);
  });

  it("serves the offline shell when a navigation fetch fails", async () => {
    sw.fetchMock.mockRejectedValueOnce(new Error("offline"));
    const matched = new Response("offline shell", { status: 200 });
    sw.caches.open.mockResolvedValueOnce({
      match: vi.fn(async () => matched),
      put: vi.fn(),
      addAll: vi.fn(),
    });
    const { event, respondWith } = fetchEvent("/dashboard", { mode: "navigate" });
    sw.listeners.fetch(event);
    const res = await respondWith.mock.calls[0][0];
    expect(await res.text()).toBe("offline shell");
  });
});
