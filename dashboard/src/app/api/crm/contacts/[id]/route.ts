import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const contact = db.prepare(`
    SELECT c.*, co.name as company_name, co.domain as company_domain
    FROM crm_contacts c
    LEFT JOIN crm_companies co ON c.company_id = co.id
    WHERE c.id = ?
  `).get(id);

  if (!contact) {
    return Response.json({ error: 'Contact not found' }, { status: 404 });
  }

  const deals = db.prepare(`
    SELECT * FROM crm_deals
    WHERE contact_id = ?
    ORDER BY created_at DESC
  `).all(id);

  const activities = db.prepare(`
    SELECT a.*, m.title as meeting_title, m.summary as meeting_summary
    FROM crm_activities a
    LEFT JOIN crm_meetings m ON a.meeting_id = m.id
    WHERE a.contact_id = ?
    ORDER BY a.created_at DESC
  `).all(id);

  const meetings = db.prepare(`
    SELECT m.* FROM crm_meetings m
    JOIN crm_activities a ON a.meeting_id = m.id
    WHERE a.contact_id = ?
    ORDER BY m.created_at DESC
  `).all(id);

  return Response.json({ contact, deals, activities, meetings });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();

  const allowed = ['name', 'email', 'phone', 'company_id', 'notes', 'tags', 'match_confidence', 'needs_review'];
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const key of allowed) {
    if (body[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(body[key]);
    }
  }

  if (sets.length === 0) {
    return Response.json({ error: 'No fields to update' }, { status: 400 });
  }

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE crm_contacts SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(id);
  return Response.json(updated);
}
