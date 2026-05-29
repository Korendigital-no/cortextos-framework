import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// content-status-audit drift scanner. Hermetic temp blog dir via the
// WEBSITE_REPO_PATH env override. The publish sidecar is mocked to a no-op so
// the audit sees raw on-disk frontmatter.

let tmpRoot: string;
let blogDir: string;

vi.mock("../content-publish-pending", () => ({
  readPending: async () => ({}),
  deletePending: async () => {},
  upsertPending: async () => {},
}));
vi.mock("../gh-pr-state", () => ({
  fetchPrState: async () => "UNKNOWN",
}));

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "status-audit-"));
  blogDir = path.join(tmpRoot, "content", "blog");
  await fs.mkdir(blogDir, { recursive: true });
  process.env.WEBSITE_REPO_PATH = tmpRoot;
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.WEBSITE_REPO_PATH;
});

async function write(filename: string, content: string): Promise<void> {
  await fs.writeFile(path.join(blogDir, filename), content, "utf-8");
}

const healthy = (status: string) => `---
title: A Post
date: 2026-05-29
excerpt: Short excerpt.
status: ${status}
---

Body.
`;

describe("auditContentStatus", () => {
  it("returns ok:true with no drift for a healthy corpus", async () => {
    await write("alpha.md", healthy("published"));
    await write("beta.md", healthy("draft"));
    await write("gamma.md", healthy("published"));

    const { auditContentStatus } = await import("../content-status-audit");
    const report = await auditContentStatus();

    expect(report.ok).toBe(true);
    expect(report.drift).toHaveLength(0);
    expect(report.published.sort()).toEqual(["alpha", "gamma"]);
  });

  it("flags a published post that fails to parse (missing required field)", async () => {
    await write("good.md", healthy("published"));
    // 'status: published' present but missing required 'excerpt' → schema fail
    // when the loader parses it. The status line lives in raw frontmatter so
    // the auditor can see the *intent* to publish even though parse fails.
    await write(
      "broken.md",
      `---
title: Broken
date: 2026-05-29
status: published
---

Body.
`,
    );

    const { auditContentStatus } = await import("../content-status-audit");
    const report = await auditContentStatus();

    expect(report.ok).toBe(false);
    expect(report.published).toContain("good");
    const driftSlugs = report.drift.map((d) => d.slug ?? d.filename);
    expect(driftSlugs.some((s) => s.includes("broken"))).toBe(true);
    const brokenDrift = report.drift.find((d) => (d.slug ?? d.filename).includes("broken"));
    expect(brokenDrift!.reason).toMatch(/parse|required|field/i);
  });

  it("flags a published post with a duplicate slug", async () => {
    // Two files, same explicit slug, both published → the website loader would
    // collapse/dedupe and one would not render.
    await write(
      "first.md",
      `---
title: First
date: 2026-05-29
excerpt: One.
slug: shared-slug
status: published
---

Body.
`,
    );
    await write(
      "second.md",
      `---
title: Second
date: 2026-05-28
excerpt: Two.
slug: shared-slug
status: published
---

Body.
`,
    );

    const { auditContentStatus } = await import("../content-status-audit");
    const report = await auditContentStatus();

    expect(report.ok).toBe(false);
    const dup = report.drift.find((d) => /duplicate/i.test(d.reason));
    expect(dup).toBeTruthy();
  });

  it("flags a published post whose frontmatter is unparseable YAML", async () => {
    await write("good.md", healthy("published"));
    // Malformed YAML (unterminated quote) that gray-matter throws on, but the
    // raw text clearly declares status: published.
    await write(
      "unparseable.md",
      `---
title: "Broken
date: 2026-05-29
excerpt: x
status: published
---

Body.
`,
    );
    const { auditContentStatus } = await import("../content-status-audit");
    const report = await auditContentStatus();
    expect(report.ok).toBe(false);
    const d = report.drift.find((x) => x.filename === "unparseable.md");
    expect(d).toBeTruthy();
    expect(d!.reason).toMatch(/parse/i);
  });

  it("ignores drift in non-published posts", async () => {
    // A draft that fails to parse is NOT drift — it's not claiming to be live.
    await write("ok.md", healthy("published"));
    await write(
      "draft-broken.md",
      `---
title: Draft Broken
date: 2026-05-29
status: draft
---

Body.
`,
    );

    const { auditContentStatus } = await import("../content-status-audit");
    const report = await auditContentStatus();

    expect(report.ok).toBe(true);
    expect(report.drift).toHaveLength(0);
  });
});
