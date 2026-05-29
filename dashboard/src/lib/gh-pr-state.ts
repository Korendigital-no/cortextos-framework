// In-process cache around `gh pr view <url> --json state` for the
// content-publish sidecar self-heal flow. content.ts calls
// fetchPrState(prUrl) once per pending entry per list-posts request;
// without caching, a 5-pending-PR list would shell out 5 times per
// dashboard refresh. With a 60s TTL the worst-case is one shell call
// per PR per minute even on a hot-reload loop.

import { spawnSync } from "node:child_process";
import { getWebsiteRepoPath } from "@/lib/content";

export type PrState = "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN";

interface CacheEntry {
  state: PrState;
  fetchedAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/**
 * Test seam: clear the cache between unit tests.
 * Not for production use.
 */
export function _clearCacheForTests(): void {
  cache.clear();
}

/**
 * Fetch the GitHub state of a PR by URL, cached for 60 seconds.
 * Returns UNKNOWN if gh is unavailable, the PR doesn't exist, or the
 * response is unparseable — the caller treats UNKNOWN as "leave it in
 * the sidecar, show as published, retry next tick".
 */
export async function fetchPrState(prUrl: string): Promise<PrState> {
  const now = Date.now();
  const cached = cache.get(prUrl);
  if (cached && now - cached.fetchedAt < TTL_MS) {
    return cached.state;
  }

  // gh pr view accepts a URL or <number> arg. URL is robust against
  // different repo contexts; --repo not needed.
  const cwd = getWebsiteRepoPath();
  const res = spawnSync("gh", ["pr", "view", prUrl, "--json", "state"], {
    cwd,
    encoding: "utf-8",
    timeout: 15_000,
  });

  let state: PrState = "UNKNOWN";
  if (res.status === 0) {
    try {
      const parsed = JSON.parse(res.stdout) as { state?: string };
      const raw = (parsed.state ?? "").toUpperCase();
      if (raw === "OPEN" || raw === "MERGED" || raw === "CLOSED") {
        state = raw;
      }
    } catch {
      state = "UNKNOWN";
    }
  }

  cache.set(prUrl, { state, fetchedAt: now });
  return state;
}
