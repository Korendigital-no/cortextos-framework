import { NextRequest } from "next/server";
import { getPostBySlug, updatePost } from "@/lib/content";

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
    const updated = await updatePost(slug, updates);
    return Response.json({ post: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Post not found")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json({ error: msg }, { status: 500 });
  }
}
