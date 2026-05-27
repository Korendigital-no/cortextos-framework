import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params;
  const body = await request.json();
  const { description, hours, date } = body;

  if (!description || !hours || !date) {
    return Response.json({ error: 'description, hours, and date are required' }, { status: 400 });
  }

  if (typeof hours !== 'number' || hours <= 0 || hours > 24) {
    return Response.json({ error: 'hours must be between 0 and 24' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO crm_time_entries (id, client_id, description, hours, date, agent, created_at)
    VALUES (?, ?, ?, ?, ?, 'dashboard', datetime('now'))
  `).run(id, clientId, description, hours, date);

  return Response.json({ id }, { status: 201 });
}
