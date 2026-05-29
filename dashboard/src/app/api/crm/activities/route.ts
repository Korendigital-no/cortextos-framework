import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const contact = searchParams.get('contact') || undefined;
  const deal = searchParams.get('deal') || undefined;
  const type = searchParams.get('type') || undefined;
  const limit = parseInt(searchParams.get('limit') || '50');

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (contact) {
    conditions.push('a.contact_id = ?');
    params.push(contact);
  }
  if (deal) {
    conditions.push('a.deal_id = ?');
    params.push(deal);
  }
  if (type) {
    conditions.push('a.type = ?');
    params.push(type);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const activities = db.prepare(`
    SELECT a.*, c.name as contact_name
    FROM crm_activities a
    LEFT JOIN crm_contacts c ON a.contact_id = c.id
    ${where}
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(...params, limit);

  return Response.json(activities);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { type, subject, body: actBody, contact_id, deal_id, due_at } = body;

  if (!type) {
    return Response.json({ error: 'Type is required' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO crm_activities (id, type, subject, body, contact_id, deal_id, agent, due_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'dashboard', ?, ?)
  `).run(id, type, subject || null, actBody || null, contact_id || null, deal_id || null, due_at || null, now);

  const activity = db.prepare('SELECT * FROM crm_activities WHERE id = ?').get(id);
  return Response.json(activity, { status: 201 });
}
