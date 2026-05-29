import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const company = db.prepare(`SELECT * FROM crm_companies WHERE id = ?`).get(id);
  if (!company) return Response.json({ error: 'Company not found' }, { status: 404 });

  const contacts = db.prepare(`
    SELECT id, name, email, phone, match_confidence, needs_review, created_at
    FROM crm_contacts
    WHERE company_id = ?
    ORDER BY name COLLATE NOCASE
  `).all(id);

  const deals = db.prepare(`
    SELECT d.id, d.title, d.value_nok, d.stage, d.created_at,
      c.id as contact_id, c.name as contact_name
    FROM crm_deals d
    LEFT JOIN crm_contacts c ON d.contact_id = c.id
    WHERE d.company_id = ?
    ORDER BY d.created_at DESC
  `).all(id);

  return Response.json({ company, contacts, deals });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();
  const allowed = ['name', 'domain', 'industry', 'notes'];
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of allowed) {
    if (body[key] !== undefined) {
      const val = body[key];
      if (val !== null && typeof val !== 'string') {
        return Response.json({ error: `${key} must be a string` }, { status: 400 });
      }
      sets.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (sets.length === 0) return Response.json({ error: 'No fields to update' }, { status: 400 });
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE crm_companies SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return Response.json({ ok: true });
}

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
