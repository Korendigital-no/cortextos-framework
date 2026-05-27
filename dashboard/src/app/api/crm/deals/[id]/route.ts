import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const txn = db.transaction(() => {
    db.prepare('UPDATE crm_activities SET deal_id = NULL WHERE deal_id = ?').run(id);
    db.prepare('DELETE FROM crm_deals WHERE id = ?').run(id);
  });
  txn();
  return Response.json({ ok: true });
}
