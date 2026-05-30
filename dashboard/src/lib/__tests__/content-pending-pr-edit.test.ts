import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Regression for the pending-PR body-edit bug (codex P1).
//
// When a post has an OPEN publish PR, the sidecar overlays its status as
// "published" (getAllPosts/getPostBySlug return published) while the file on
// disk is still "approved". A body edit must NOT serialize that overlaid
// "published" status — doing so, combined with policy-A commit+push, would make
// the post live from a body edit and bypass the PR merge. updatePost reads the
// RAW on-disk status so the edit preserves "approved".

let tmpRoot: string;
let blogDir: string;
const SLUG = "pending-pr-post";

// Sidecar reports an OPEN PR for the post → applyPublishSidecar overlays
// status: "published".
vi.mock("../content-publish-pending", () => ({
  readPending: async () => ({
    [SLUG]: { prUrl: "https://github.com/x/y/pull/7", branch: "blog/publish-x", publishedAt: "2026-05-30T00:00:00Z" },
  }),
  deletePending: async () => {},
  upsertPending: async () => {},
}));
vi.mock("../gh-pr-state", () => ({
  fetchPrState: async () => "OPEN",
}));
// content-git is irrelevant here (updatePost itself does no git); stub to be safe.
vi.mock("../content-git", () => ({
  commitAndPushContentFile: async () => ({ ok: true, pushed: true, message: "ok" }),
}));

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "content-pending-"));
  blogDir = path.join(tmpRoot, "content", "blog");
  await fs.mkdir(blogDir, { recursive: true });
  process.env.WEBSITE_REPO_PATH = tmpRoot;
  vi.resetModules();
  await fs.writeFile(
    path.join(blogDir, `${SLUG}.md`),
    `---\ntitle: Pending\ndate: 2026-05-29\nexcerpt: E\nstatus: approved\n---\noriginal body\n`,
    "utf-8",
  );
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.WEBSITE_REPO_PATH;
});

async function readDiskStatus(): Promise<string> {
  const matter = (await import("gray-matter")).default;
  const raw = await fs.readFile(path.join(blogDir, `${SLUG}.md`), "utf-8");
  return (matter(raw).data as { status: string }).status;
}

describe("updatePost on a post with an open publish PR", () => {
  it("overlay reports published, but a body edit preserves the on-disk 'approved' status (no publish bypass)", async () => {
    const { getPostBySlug, updatePost } = await import("../content");

    // Sanity: the overlay makes getPostBySlug report published.
    const overlaid = await getPostBySlug(SLUG);
    expect(overlaid?.status).toBe("published");

    // Body-only edit.
    await updatePost(SLUG, { body: "edited body" });

    // On disk, status must still be approved — the body edit did NOT publish it.
    expect(await readDiskStatus()).toBe("approved");
    const matter = (await import("gray-matter")).default;
    const raw = await fs.readFile(path.join(blogDir, `${SLUG}.md`), "utf-8");
    expect(matter(raw).content.trim()).toBe("edited body");
  });
});
