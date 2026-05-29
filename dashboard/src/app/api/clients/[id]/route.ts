import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const client = db.prepare(`
    SELECT c.*, co.name as company_name
    FROM crm_clients c
    LEFT JOIN crm_companies co ON c.company_id = co.id
    WHERE c.id = ?
  `).get(id);

  if (!client) return Response.json({ error: 'Client not found' }, { status: 404 });

  const timeEntries = db.prepare('SELECT * FROM crm_time_entries WHERE client_id = ? ORDER BY date DESC').all(id);

  const totals = db.prepare(`
    SELECT COALESCE(SUM(hours), 0) as total_hours, COUNT(*) as entry_count
    FROM crm_time_entries WHERE client_id = ?
  `).get(id) as { total_hours: number; entry_count: number };

  return Response.json({ client, timeEntries, totals });
}
