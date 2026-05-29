import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Audit-metadata behaviour for content.ts. Uses a hermetic temp blog dir via
// the WEBSITE_REPO_PATH env override (read at call-time in getWebsiteRepoPath),
// so no real website clone is touched. The publish sidecar is mocked to a
// no-op so getAllPosts returns the raw on-disk posts.

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
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "content-audit-"));
  blogDir = path.join(tmpRoot, "content", "blog");
  await fs.mkdir(blogDir, { recursive: true });
  process.env.WEBSITE_REPO_PATH = tmpRoot;
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.WEBSITE_REPO_PATH;
});

async function writePost(filename: string, body: string): Promise<void> {
  await fs.writeFile(path.join(blogDir, filename), body, "utf-8");
}

async function readFrontmatter(slug: string): Promise<Record<string, unknown>> {
  const matter = (await import("gray-matter")).default;
  const raw = await fs.readFile(path.join(blogDir, `${slug}.md`), "utf-8");
  return matter(raw).data as Record<string, unknown>;
}

const BASE = (extra = "") => `---
title: Hello World
date: 2026-05-29
excerpt: A short excerpt.
status: draft
${extra}---

Body text here.
`;

describe("content.ts audit frontmatter fields", () => {
  it("parses and passes through publishedAt/publishedBy/approvedAt/approvedBy", async () => {
    await writePost(
      "my-post.md",
      BASE(`publishedAt: "2026-05-01T10:00:00.000Z"
publishedBy: alice
approvedAt: "2026-04-30T09:00:00.000Z"
approvedBy: bob
`),
    );
    const { getPostBySlug } = await import("../content");
    const post = await getPostBySlug("my-post");
    expect(post).not.toBeNull();
    expect(post!.publishedAt).toBe("2026-05-01T10:00:00.000Z");
    expect(post!.publishedBy).toBe("alice");
    expect(post!.approvedAt).toBe("2026-04-30T09:00:00.000Z");
    expect(post!.approvedBy).toBe("bob");
  });

  it("posts without audit fields load with them undefined", async () => {
    await writePost("plain.md", BASE());
    const { getPostBySlug } = await import("../content");
    const post = await getPostBySlug("plain");
    expect(post!.publishedAt).toBeUndefined();
    expect(post!.publishedBy).toBeUndefined();
  });

  it("setStatus(→published) stamps publishedAt + publishedBy default 'dashboard'", async () => {
    await writePost("post-a.md", BASE());
    const { setStatus } = await import("../content");
    const before = Date.now();
    const updated = await setStatus("post-a", "published");
    expect(updated.status).toBe("published");
    expect(updated.publishedBy).toBe("dashboard");
    expect(updated.publishedAt).toBeTruthy();
    expect(new Date(updated.publishedAt!).getTime()).toBeGreaterThanOrEqual(before - 1000);
    // Persisted to disk.
    const fm = await readFrontmatter("post-a");
    expect(fm.status).toBe("published");
    expect(fm.publishedBy).toBe("dashboard");
  });

  it("setStatus(→published, actor) attributes publishedBy to the actor", async () => {
    await writePost("post-b.md", BASE());
    const { setStatus } = await import("../content");
    const updated = await setStatus("post-b", "published", "mike");
    expect(updated.publishedBy).toBe("mike");
  });

  it("setStatus(→approved) stamps approvedAt + approvedBy default 'dashboard'", async () => {
    await writePost("post-c.md", BASE());
    const { setStatus } = await import("../content");
    const updated = await setStatus("post-c", "approved");
    expect(updated.status).toBe("approved");
    expect(updated.approvedBy).toBe("dashboard");
    expect(updated.approvedAt).toBeTruthy();
  });

  it("approved→published preserves the existing approval trail", async () => {
    await writePost(
      "post-d.md",
      BASE(`approvedAt: "2026-04-30T09:00:00.000Z"
approvedBy: bob
status: approved
`).replace("status: draft\n", ""),
    );
    const { setStatus } = await import("../content");
    const updated = await setStatus("post-d", "published");
    expect(updated.status).toBe("published");
    // Approval trail intact.
    expect(updated.approvedAt).toBe("2026-04-30T09:00:00.000Z");
    expect(updated.approvedBy).toBe("bob");
    // New publish stamp added.
    expect(updated.publishedAt).toBeTruthy();
    expect(updated.publishedBy).toBe("dashboard");
  });

  it("unrelated edit does NOT drop existing audit fields", async () => {
    await writePost(
      "post-e.md",
      BASE(`publishedAt: "2026-05-01T10:00:00.000Z"
publishedBy: alice
approvedAt: "2026-04-30T09:00:00.000Z"
approvedBy: bob
`),
    );
    const { updatePost } = await import("../content");
    const updated = await updatePost("post-e", { title: "New Title" });
    expect(updated.title).toBe("New Title");
    expect(updated.publishedAt).toBe("2026-05-01T10:00:00.000Z");
    expect(updated.publishedBy).toBe("alice");
    expect(updated.approvedAt).toBe("2026-04-30T09:00:00.000Z");
    expect(updated.approvedBy).toBe("bob");
    // And persisted, not just in-memory.
    const fm = await readFrontmatter("post-e");
    expect(fm.publishedBy).toBe("alice");
    expect(fm.approvedBy).toBe("bob");
  });

  it("does not emit undefined audit keys into frontmatter (js-yaml guard)", async () => {
    await writePost("post-f.md", BASE());
    const { updatePost } = await import("../content");
    await updatePost("post-f", { title: "T2" });
    const fm = await readFrontmatter("post-f");
    expect("publishedAt" in fm).toBe(false);
    expect("approvedBy" in fm).toBe(false);
  });

  it("re-publishing an already-published post preserves the ORIGINAL publish stamp", async () => {
    await writePost(
      "post-g.md",
      BASE(`publishedAt: "2026-01-01T00:00:00.000Z"
publishedBy: original-actor
status: published
`).replace("status: draft\n", ""),
    );
    const { setStatus } = await import("../content");
    const updated = await setStatus("post-g", "published", "second-actor");
    // Original stamp untouched — no overwrite with a later no-op flip.
    expect(updated.publishedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(updated.publishedBy).toBe("original-actor");
  });

  it("re-approving an already-approved post preserves the ORIGINAL approval stamp", async () => {
    await writePost(
      "post-h.md",
      BASE(`approvedAt: "2026-01-01T00:00:00.000Z"
approvedBy: original-approver
status: approved
`).replace("status: draft\n", ""),
    );
    const { setStatus } = await import("../content");
    const updated = await setStatus("post-h", "approved", "second-approver");
    expect(updated.approvedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(updated.approvedBy).toBe("original-approver");
  });

  it("revertToApproved clears the publish stamp but preserves the approval trail", async () => {
    await writePost(
      "post-i.md",
      BASE(`approvedAt: "2026-04-30T09:00:00.000Z"
approvedBy: bob
publishedAt: "2026-05-01T10:00:00.000Z"
publishedBy: dashboard
status: published
`).replace("status: draft\n", ""),
    );
    const { revertToApproved } = await import("../content");
    const reverted = await revertToApproved("post-i");
    expect(reverted.status).toBe("approved");
    expect(reverted.publishedAt).toBeUndefined();
    expect(reverted.publishedBy).toBeUndefined();
    // Approval trail intact.
    expect(reverted.approvedAt).toBe("2026-04-30T09:00:00.000Z");
    expect(reverted.approvedBy).toBe("bob");
    // Persisted: publish keys actually removed from the file.
    const fm = await readFrontmatter("post-i");
    expect("publishedAt" in fm).toBe(false);
    expect("publishedBy" in fm).toBe(false);
    expect(fm.approvedBy).toBe("bob");
  });

  it("readStatusFromDisk returns the literal on-disk status", async () => {
    await writePost("post-j.md", BASE().replace("status: draft", "status: approved"));
    const { readStatusFromDisk } = await import("../content");
    expect(await readStatusFromDisk("post-j")).toBe("approved");
  });

  it("readStatusFromDisk returns null for a missing post", async () => {
    const { readStatusFromDisk } = await import("../content");
    expect(await readStatusFromDisk("does-not-exist")).toBeNull();
  });
});
