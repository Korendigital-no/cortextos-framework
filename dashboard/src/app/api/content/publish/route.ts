import { NextRequest } from "next/server";
import { publishApproved } from "@/lib/content-publish";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const dryRun = searchParams.get("dryRun") === "true";
  const result = await publishApproved({ dryRun });
  // 200 even on rate-limit so the UI can display the message without a thrown
  // error; the `ok` flag is the success signal.
  return Response.json(result);
}
