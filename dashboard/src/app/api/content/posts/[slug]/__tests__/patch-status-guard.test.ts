/**
 * PATCH /api/content/posts/[slug] — publish-flip guard (codex bycatch,
 * upstream-sync 2026-06-04).
 *
 * The bug: PATCH accepted `status: "published"` and flipped the post to
 * published LOCALLY via setStatus — outside publishApproved's PR/push flow.
 * origin/main and the live site never received the change, and a later
 * publish run skipped the post (it was no longer "approved"). The same
 * divergence exists in reverse: un-publishing a published post via PATCH
 * leaves the live site serving a post the dashboard says is a draft.
 *
 * Contract pinned here: PATCH owns only NON-publish status changes
 * (draft <-> approved). Any flip TO or FROM "published" is rejected with
 * 409 + a pointer to the publish flow. Body edits and no-op status
 * round-trips (full-form saves) keep working.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getPostBySlug: vi.fn(),
  setStatus: vi.fn(),
  updatePost: vi.fn(),
  readStatusFromDisk: vi.fn(),
  resolvePostPath: vi.fn(),
  getWebsiteRepoPath: vi.fn(),
  commitAndPushContentFile: vi.fn(),
  readPending: vi.fn(),
  pendingPublishWarning: vi.fn(),
}));

vi.mock("@/lib/content", () => ({
  getPostBySlug: mocks.getPostBySlug,
  setStatus: mocks.setStatus,
  updatePost: mocks.updatePost,
  readStatusFromDisk: mocks.readStatusFromDisk,
  resolvePostPath: mocks.resolvePostPath,
  getWebsiteRepoPath: mocks.getWebsiteRepoPath,
}));

vi.mock("@/lib/content-git", () => ({
  commitAndPushContentFile: mocks.commitAndPushContentFile,
}));

vi.mock("@/lib/content-publish-pending", () => ({
  readPending: mocks.readPending,
  pendingPublishWarning: mocks.pendingPublishWarning,
}));

const { PATCH } = await import("../route");

function patchReq(slug: string, body: Record<string, unknown>) {
  const request = new NextRequest(`http://localhost/api/content/posts/${slug}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return PATCH(request, { params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPostBySlug.mockResolvedValue({ slug: "p", status: "draft" });
  mocks.updatePost.mockResolvedValue({ slug: "p", status: "draft" });
  mocks.setStatus.mockResolvedValue({ slug: "p", status: "approved" });
  mocks.resolvePostPath.mockResolvedValue(null);
  mocks.getWebsiteRepoPath.mockReturnValue("/tmp/website");
  mocks.readPending.mockResolvedValue({});
  mocks.pendingPublishWarning.mockReturnValue(null);
});

describe("PATCH status guard — publish flips are rejected", () => {
  it("rejects status:published on an approved post (publish flow owns the flip)", async () => {
    mocks.readStatusFromDisk.mockResolvedValue("approved");
    const res = await patchReq("p", { status: "published" });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/publish/i);
    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.updatePost).not.toHaveBeenCalled();
  });

  it("rejects status:published on a draft post", async () => {
    mocks.readStatusFromDisk.mockResolvedValue("draft");
    const res = await patchReq("p", { status: "published" });
    expect(res.status).toBe(409);
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it("rejects un-publishing (published -> draft) — live site would diverge", async () => {
    mocks.readStatusFromDisk.mockResolvedValue("published");
    const res = await patchReq("p", { status: "draft" });
    expect(res.status).toBe(409);
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it("rejects a combined body+publish edit WITHOUT applying the body edit", async () => {
    // A partial apply (body saved, flip rejected) would silently push a
    // content edit the operator thought failed — all-or-nothing.
    mocks.readStatusFromDisk.mockResolvedValue("approved");
    const res = await patchReq("p", { body: "new text", status: "published" });
    expect(res.status).toBe(409);
    expect(mocks.updatePost).not.toHaveBeenCalled();
    expect(mocks.commitAndPushContentFile).not.toHaveBeenCalled();
  });
});

describe("PATCH status guard — non-publish flows keep working", () => {
  it("allows draft -> approved", async () => {
    mocks.readStatusFromDisk.mockResolvedValue("draft");
    mocks.setStatus.mockResolvedValue({ slug: "p", status: "approved" });
    const res = await patchReq("p", { status: "approved" });
    expect(res.status).toBe(200);
    expect(mocks.setStatus).toHaveBeenCalledWith("p", "approved");
  });

  it("allows approved -> draft (retract from approval queue)", async () => {
    mocks.readStatusFromDisk.mockResolvedValue("approved");
    mocks.setStatus.mockResolvedValue({ slug: "p", status: "draft" });
    const res = await patchReq("p", { status: "draft" });
    expect(res.status).toBe(200);
    expect(mocks.setStatus).toHaveBeenCalledWith("p", "draft");
  });

  it("full-form save with a NO-OP published status still canonicalises the body edit", async () => {
    // { body, status: "published" } on an already-published post is not a
    // flip — the existing no-op semantics (codex P2 from #edit-body) must
    // survive this guard: body applies + push runs, setStatus does not.
    mocks.readStatusFromDisk.mockResolvedValue("published");
    mocks.updatePost.mockResolvedValue({ slug: "p", status: "published" });
    mocks.resolvePostPath.mockResolvedValue("/tmp/website/content/blog/p.md");
    mocks.commitAndPushContentFile.mockResolvedValue({ kind: "pushed" });
    const res = await patchReq("p", { body: "fix typo", status: "published" });
    expect(res.status).toBe(200);
    expect(mocks.updatePost).toHaveBeenCalledWith("p", { body: "fix typo" });
    expect(mocks.commitAndPushContentFile).toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it("plain body edit (no status field) is untouched by the guard", async () => {
    mocks.readStatusFromDisk.mockResolvedValue("draft");
    mocks.updatePost.mockResolvedValue({ slug: "p", status: "draft" });
    const res = await patchReq("p", { body: "hello" });
    expect(res.status).toBe(200);
    expect(mocks.updatePost).toHaveBeenCalledWith("p", { body: "hello" });
  });
});
