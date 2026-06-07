import { NextRequest } from "next/server";
import path from "node:path";
import { getPostBySlug, setStatus, updatePost, getWebsiteRepoPath, resolvePostPath, readStatusFromDisk, type ContentStatus } from "@/lib/content";
import { commitAndPushContentFile } from "@/lib/content-git";
import { readPending, pendingPublishWarning } from "@/lib/content-publish-pending";

export const dynamic = "force-dynamic";

const VALID_FIELDS = ["title", "excerpt", "tags", "body", "status", "author", "ogImage"] as const;
const STATUS_VALUES = new Set(["draft", "approved", "published"]);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ post });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const body = (await request.json()) as Record<string, unknown>;

  const updates: Record<string, unknown> = {};
  for (const key of VALID_FIELDS) {
    if (!(key in body)) continue;
    const val = body[key];
    if (key === "tags") {
      if (!Array.isArray(val) || !val.every((t) => typeof t === "string")) {
        return Response.json({ error: "tags must be string[]" }, { status: 400 });
      }
      updates.tags = val;
      continue;
    }
    if (key === "status") {
      if (typeof val !== "string" || !STATUS_VALUES.has(val)) {
        return Response.json(
          { error: "status must be draft | approved | published" },
          { status: 400 },
        );
      }
      updates.status = val;
      continue;
    }
    if (typeof val !== "string") {
      return Response.json({ error: `${key} must be string` }, { status: 400 });
    }
    updates[key] = val;
  }
  if (Object.keys(updates).length === 0) {
    return Response.json({ error: "No fields to update" }, { status: 400 });
  }

  try {
    // Route a status change through setStatus so the audit trail
    // (publishedAt/publishedBy or approvedAt/approvedBy) gets stamped. A bare
    // updatePost({status}) would flip the status WITHOUT stamping, leaving a
    // published/approved post with no audit record. If other fields change in
    // the same request, apply them first (without status), then flip status.
    const { status, ...rest } = updates as { status?: ContentStatus } & Record<string, unknown>;
    // A status flip belongs to the publish PR flow, not a direct push to main.
    // But a `status` that EQUALS the on-disk status is not a flip (codex P2) —
    // a full-form save like { body, status: "draft" } on a draft post must
    // still canonicalise the body edit, not skip it.
    const diskStatus = await readStatusFromDisk(slug);
    const statusChanges = status !== undefined && status !== diskStatus;

    // Publish-flip guard: publishing is owned by publishApproved (the
    // /api/content/publish PR/push flow). A PATCH that flips status TO
    // "published" marks the post published locally while origin/main and the
    // live site never get it — and a later publish run then SKIPS it (no
    // longer "approved"). The reverse flip (un-publishing) diverges the same
    // way: the live site keeps serving a post the dashboard calls a draft.
    // Reject both before ANY field is applied (all-or-nothing — a partial
    // apply would silently push a body edit the operator thought failed).
    // No-op round-trips (full-form save with the on-disk status) pass through.
    if (statusChanges && (status === "published" || diskStatus === "published")) {
      return Response.json(
        {
          error:
            status === "published"
              ? "Publishing goes through the publish flow (POST /api/content/publish), not PATCH — it opens the PR that makes the post canonical on origin/main."
              : "Un-publishing a published post is not supported via PATCH — the live site is built from origin/main and would diverge. Use the publish flow.",
        },
        { status: 409 },
      );
    }

    let updated = await getPostBySlug(slug);
    let sync: Awaited<ReturnType<typeof commitAndPushContentFile>> | null = null;
    // Race-guard R2: a direct-to-main edit of a slug that already has an open
    // publish PR can be silently reverted when that PR (branched from an older
    // snapshot) merges. Surface a warning so the operator reconciles. Only
    // meaningful for the policy-A direct-push path (an edit that actually
    // reaches main), so it's computed alongside the push below.
    let warning: string | null = null;
    if (Object.keys(rest).length > 0) {
      updated = await updatePost(slug, rest);
      // Policy A (#edit-body): a content edit is canonical only once it reaches
      // origin/main — otherwise the editor and the public site (Vercel from
      // origin/main) diverge, which is exactly the bug this fixes. Commit +
      // push JUST this file and return the outcome so the UI can warn if the
      // edit was saved locally but did not reach the canonical repo. Skip only
      // when this request actually changes status (the publish flow owns that).
      if (!statusChanges) {
        const absPath = await resolvePostPath(slug);
        if (absPath) {
          const relPath = path.relative(getWebsiteRepoPath(), absPath);
          sync = await commitAndPushContentFile(
            getWebsiteRepoPath(),
            relPath,
            `content: edit ${slug} via dashboard`,
          );
        }
        // Only warn when the edit actually went out to main (pushed). A
        // not-live/error sync never reached main, so there's no race to flag.
        if (sync?.kind === "pushed") {
          warning = pendingPublishWarning(slug, await readPending());
        }
      }
    }
    if (statusChanges) {
      updated = await setStatus(slug, status);
    }
    if (!updated) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json({ post: updated, sync, warning });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Post not found")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json({ error: msg }, { status: 500 });
  }
}
