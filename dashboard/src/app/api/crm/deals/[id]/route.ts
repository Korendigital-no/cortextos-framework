import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deal = db.prepare(`
    SELECT d.*, c.name as contact_name, c.email as contact_email, co.name as company_name
    FROM crm_deals d
    LEFT JOIN crm_contacts c ON d.contact_id = c.id
    LEFT JOIN crm_companies co ON d.company_id = co.id
    WHERE d.id = ?
  `).get(id);
  if (!deal) return Response.json({ error: 'Deal not found' }, { status: 404 });

  const activities = db.prepare(`
    SELECT a.*, c.name as contact_name FROM crm_activities a
    LEFT JOIN crm_contacts c ON a.contact_id = c.id
    WHERE a.deal_id = ? ORDER BY a.created_at DESC
  `).all(id);

  return Response.json({ deal, activities });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const txn = db.transaction(() => {
    db.prepare('UPDATE crm_activities SET deal_id = NULL WHERE deal_id = ?').run(id);
    db.prepare('DELETE FROM crm_deals WHERE id = ?').run(id);
  });
  txn();
  return Response.json({ ok: true });
}
