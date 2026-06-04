import { describe, it, expect } from "vitest";
import { isPublicPath } from "../proxy";

// The auth proxy 307-redirects every non-public path to /login. PWA assets are
// fetched by the browser on first load (often from the unauthenticated /login
// screen), so they MUST be public or the service worker, manifest, icons and
// offline shell resolve to a login redirect and install/offline breaks. This
// locks that whitelist (codex P2 regression).

describe("proxy isPublicPath — PWA assets reachable while unauthenticated", () => {
  it.each([
    "/sw.js",
    "/manifest.webmanifest",
    "/offline",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/icon-maskable-512.png",
    "/icons/apple-touch-icon.png",
    "/icons/favicon-32.png",
  ])("treats %s as public", (p) => {
    expect(isPublicPath(p)).toBe(true);
  });

  it("health probe is public — exact match only (GAP-0034, upstream #547 parity)", () => {
    expect(isPublicPath("/api/workflows/health")).toBe(true);
    // everything else under /api/workflows stays gated
    expect(isPublicPath("/api/workflows")).toBe(false);
    expect(isPublicPath("/api/workflows/health/extra")).toBe(false);
    expect(isPublicPath("/api/workflows/run")).toBe(false);
  });

  it("still gates real app routes behind auth", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/content")).toBe(false);
    expect(isPublicPath("/api/agents")).toBe(false);
  });

  it("does not over-match lookalike paths", () => {
    // segment-exact: /offline-report is NOT the public /offline shell
    expect(isPublicPath("/offline-report")).toBe(false);
    expect(isPublicPath("/sw.js.map")).toBe(false);
  });

  it("keeps the existing public paths public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/callback/credentials")).toBe(true);
    expect(isPublicPath("/favicon.ico")).toBe(true);
    expect(isPublicPath("/api/crm/webhooks/calcom")).toBe(true);
  });
});
