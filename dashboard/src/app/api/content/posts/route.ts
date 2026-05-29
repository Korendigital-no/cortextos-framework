import { getAllPosts } from "@/lib/content";

export const dynamic = "force-dynamic";

export async function GET() {
  const posts = await getAllPosts();
  // Trim body in the list endpoint — only metadata + word count + first-N
  // chars excerpt is needed by the index card. Detail endpoint returns body.
  const summaries = posts.map(({ body: _body, ...rest }) => rest);
  return Response.json({ posts: summaries });
}
