import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Every App Router error boundary must forward the error to Sentry. The morning
// of 2026-06-02 we were blind to a dashboard-wide error-boundary storm because
// the (dashboard) route-segment boundaries swallowed errors without reporting —
// only global-error.tsx called captureException. This invariant test makes a new
// `error.tsx` that forgets to wire Sentry fail CI instead of silently going dark.

const APP_DIR = path.join(__dirname, "..");

function findErrorBoundaries(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...findErrorBoundaries(full));
    } else if (entry.name === "error.tsx" || entry.name === "global-error.tsx") {
      out.push(full);
    }
  }
  return out;
}

describe("error boundaries report to Sentry", () => {
  const boundaries = findErrorBoundaries(APP_DIR);

  it("finds the dashboard error boundaries", () => {
    // Sanity: we expect at least the (dashboard) boundary + global-error.
    expect(boundaries.length).toBeGreaterThanOrEqual(2);
  });

  it.each(boundaries.map((f) => [path.relative(APP_DIR, f), f]))(
    "%s imports Sentry and calls captureException",
    (_rel, file) => {
      const src = fs.readFileSync(file, "utf-8");
      expect(src).toMatch(/@sentry\/nextjs/);
      expect(src).toMatch(/Sentry\.captureException\(\s*error/);
    },
  );
});
