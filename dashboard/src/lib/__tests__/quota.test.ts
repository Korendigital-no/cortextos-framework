import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Regression coverage for JAVASCRIPT-NEXTJS-2: a connection-level fetch throw
// (EHOSTUNREACH → "TypeError: fetch failed") must NOT propagate out of
// fetchQuotaSnapshot. The module's contract (see its docstring) is that
// transient network errors fall back to the last-good cache, or null on cold
// boot — never an unhandled rejection that 500s /api/quota and pages Sentry.

let tmpRoot: string;

const SNAPSHOT = {
  five_hour_remaining_pct: 80,
  seven_day_remaining_pct: 55,
  fetched_at: new Date(Date.now() - 60_000).toISOString(),
  source: "env" as const,
};

function writeCache(root: string) {
  const dir = path.join(root, "state", "dashboard");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "quota-last-good.json"), JSON.stringify(SNAPSHOT));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quota-test-"));
  process.env.CTX_ROOT = tmpRoot;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token"; // getOAuthToken returns a token
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CTX_ROOT;
});

describe("fetchQuotaSnapshot network-error resilience", () => {
  it("returns cached last-good (stale) when fetch throws a connection error", async () => {
    writeCache(tmpRoot);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    const { fetchQuotaSnapshot } = await import("../quota");

    const result = await fetchQuotaSnapshot();

    expect(result).not.toBeNull();
    expect(result!.stale).toBe(true);
    expect(result!.five_hour_remaining_pct).toBe(SNAPSHOT.five_hour_remaining_pct);
    expect(result!.cache_age_ms).toBeGreaterThan(0);
  });

  it("returns null (not throw) on cold boot when fetch throws and no cache exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    const { fetchQuotaSnapshot } = await import("../quota");

    await expect(fetchQuotaSnapshot()).resolves.toBeNull();
  });

  it("returns fresh data and writes cache when fetch succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ five_hour: { utilization: 20 }, seven_day: { utilization: 45 } }),
        } as Response),
      ),
    );
    const { fetchQuotaSnapshot } = await import("../quota");

    const result = await fetchQuotaSnapshot();

    expect(result).not.toBeNull();
    expect(result!.stale).toBe(false);
    expect(result!.five_hour_remaining_pct).toBe(80); // 1 - 0.20
    expect(fs.existsSync(path.join(tmpRoot, "state", "dashboard", "quota-last-good.json"))).toBe(true);
  });
});
