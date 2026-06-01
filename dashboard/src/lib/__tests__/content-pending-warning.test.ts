import { describe, it, expect } from "vitest";
import { pendingPublishWarning, type PendingMap } from "../content-publish-pending";

// Race-guard R2 (pure): warn when a slug edited directly on main has an open
// publish PR — the exact incident (a direct edit pushed to main while a publish
// PR branched from an older snapshot is in flight, which can revert the edit on
// merge).

const PENDING: PendingMap = {
  "hvem-koren-digital-er": {
    prUrl: "https://github.com/Korendigital-no/Korendigital-nettside/pull/6",
    branch: "blog/publish-20260601-hvem-koren-digital-er",
    publishedAt: "2026-06-01T08:58:35.672Z",
  },
};

describe("pendingPublishWarning", () => {
  it("returns a warning naming the open PR when the slug has a pending publish", () => {
    const w = pendingPublishWarning("hvem-koren-digital-er", PENDING);
    expect(w).not.toBeNull();
    expect(w).toContain("pull/6");
    expect(w).toMatch(/publiser-PR/i);
  });

  it("returns null when the slug has no pending publish PR", () => {
    expect(pendingPublishWarning("some-other-post", PENDING)).toBeNull();
  });

  it("returns null against an empty pending map", () => {
    expect(pendingPublishWarning("hvem-koren-digital-er", {})).toBeNull();
  });
});
