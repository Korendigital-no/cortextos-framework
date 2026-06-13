import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import {
  resolveCompanyId, CLIENT_EDITABLE_FIELDS, isValidClientStatus,
  clientHasTimeHistory, hardDeleteClient,
} from '@/lib/client-edit';

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

  // has_time_history mirrors the DELETE decision (live OR trashed entries) so the
  // UI shows the correct "archive vs delete" copy — totals.entry_count only counts
  // LIVE entries and would mislead when all entries are trashed.
  return Response.json({ client, timeEntries, totals, has_time_history: clientHasTimeHistory(db, id) });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const exists = db.prepare('SELECT id FROM crm_clients WHERE id = ?').get(id);
  if (!exists) return Response.json({ error: 'Client not found' }, { status: 404 });

  const body = await request.json();
  const now = new Date().toISOString();
  const sets: string[] = [];
  const values: unknown[] = [];

  // company_name resolves to a crm_companies row (reuse-or-create), then sets
  // company_id — mirrors POST /api/clients.
  if (body.company_name !== undefined) {
    const companyName = String(body.company_name).trim();
    if (!companyName) return Response.json({ error: 'Company name cannot be empty' }, { status: 400 });
    sets.push('company_id = ?');
    values.push(resolveCompanyId(db, companyName, now));
  }

  for (const key of CLIENT_EDITABLE_FIELDS) {
    if (body[key] === undefined) continue;
    if (key === 'status' && !isValidClientStatus(body[key])) {
      return Response.json({ error: `Invalid status: ${body[key]}` }, { status: 400 });
    }
    sets.push(`${key} = ?`);
    values.push(body[key]);
  }

  if (sets.length === 0) return Response.json({ error: 'No fields to update' }, { status: 400 });

  sets.push('updated_at = ?');
  values.push(now);
  values.push(id);
  db.prepare(`UPDATE crm_clients SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return Response.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = db.prepare('SELECT id FROM crm_clients WHERE id = ?').get(id) as { id: string } | undefined;
  if (!client) return Response.json({ error: 'Client not found' }, { status: 404 });

  // Accounting integrity: a client that ever logged time carries billable /
  // invoice-basis records that must be ARCHIVED (recoverable), never destroyed.
  // The system decides soft-vs-hard from billing history — there is no operator
  // override to hard-delete a client with time history.
  if (clientHasTimeHistory(db, id)) {
    const now = new Date().toISOString();
    db.prepare('UPDATE crm_clients SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    return Response.json({ ok: true, soft: true });
  }

  // No time history → a truly empty client, safe to hard cascade-delete.
  hardDeleteClient(db, id);
  return Response.json({ ok: true, soft: false });
}
