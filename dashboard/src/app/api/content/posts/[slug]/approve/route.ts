import { NextRequest } from "next/server";
import { setStatus, getPostBySlug } from "@/lib/content";

export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) return Response.json({ error: "Not found" }, { status: 404 });
  if (post.status === "published") {
    return Response.json(
      { error: "Already published — approve flow only applies to draft posts" },
      { status: 409 },
    );
  }
  const updated = await setStatus(slug, "approved");
  return Response.json({ post: updated });
}
