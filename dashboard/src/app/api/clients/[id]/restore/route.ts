import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST /api/clients/[id]/restore — un-archive a soft-deleted client (clears
 * deleted_at). Powers the "Undo" on a client archive so a mis-click never loses
 * a client (and its preserved billing history) for good. Idempotent: restoring
 * a live client is a no-op success.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const now = new Date().toISOString();
  const res = db
    .prepare('UPDATE crm_clients SET deleted_at = NULL, updated_at = ? WHERE id = ?')
    .run(now, id);
  if (res.changes === 0) return Response.json({ error: 'Client not found' }, { status: 404 });
  return Response.json({ ok: true });
}
