import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const txn = db.transaction(() => {
    db.prepare('UPDATE crm_contacts SET company_id = NULL WHERE company_id = ?').run(id);
    db.prepare('UPDATE crm_deals SET company_id = NULL WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM crm_companies WHERE id = ?').run(id);
  });
  txn();
  return Response.json({ ok: true });
}
