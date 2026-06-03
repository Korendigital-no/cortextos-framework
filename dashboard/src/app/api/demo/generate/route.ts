import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { runStage, STAGE_ORDER, type StageKey } from '@/lib/demo/pipeline';
import type { BriefInput } from '@/lib/demo/prompts';

export const dynamic = 'force-dynamic';
// The pipeline calls an external LLM; give it room beyond the default.
export const maxDuration = 60;

function isBrief(v: unknown): v is BriefInput {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Record<string, unknown>;
  return ['produkt', 'maalgruppe', 'tilbud', 'plattform', 'husstil_eksempler']
    .every(k => typeof b[k] === 'string' && (b[k] as string).trim().length > 0);
}

export async function POST(request: NextRequest) {
  // This endpoint spends external LLM tokens (server-side key), so it must
  // authenticate itself — do not rely on middleware alone (same lesson as the
  // server-action hardening). Belt-and-suspenders with proxy.ts's /api 401, and
  // it stays safe if the demo is later exposed on a public path.
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

  const { stage, brief, context } = (body ?? {}) as { stage?: unknown; brief?: unknown; context?: unknown };

  if (typeof stage !== 'string' || !STAGE_ORDER.includes(stage as StageKey)) {
    return Response.json({ error: `stage must be one of: ${STAGE_ORDER.join(', ')}` }, { status: 400 });
  }
  if (!isBrief(brief)) {
    return Response.json({ error: 'brief must include non-empty produkt, maalgruppe, tilbud, plattform, husstil_eksempler' }, { status: 400 });
  }

  const ctx = (typeof context === 'object' && context !== null ? context : {}) as Record<string, unknown>;

  try {
    const result = await runStage(stage as StageKey, brief, ctx);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Distinguish a missing-config (no LLM key) from a generation failure so the
    // UI can show an actionable message.
    const status = /not configured/i.test(message) ? 503 : 502;
    return Response.json({ error: message, stage }, { status });
  }
}
