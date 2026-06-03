import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { generateStaticAd } from '@/lib/demo/image';

export const dynamic = 'force-dynamic';
// GPT Image generation takes ~40s; give it headroom.
export const maxDuration = 90;

export async function POST(request: NextRequest) {
  // Spends external image-gen tokens (server-side key) — authenticate, don't
  // rely on middleware alone (same rule as /api/demo/generate).
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { produkt, plattform, conceptTitle } = (body ?? {}) as Record<string, unknown>;
  if (typeof produkt !== 'string' || !produkt.trim()
    || typeof plattform !== 'string' || !plattform.trim()
    || typeof conceptTitle !== 'string' || !conceptTitle.trim()) {
    return Response.json({ error: 'produkt, plattform and conceptTitle are required' }, { status: 400 });
  }

  try {
    const result = await generateStaticAd({ produkt, plattform, conceptTitle });
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /not configured/i.test(message) ? 503 : 502;
    return Response.json({ error: message }, { status });
  }
}
