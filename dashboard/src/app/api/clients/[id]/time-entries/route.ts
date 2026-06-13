import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { projectBelongsToClient, clientIsActive } from '@/lib/crm-client-auth';
import { normalizeBillable } from '@/lib/billable';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params;
  // Write gate: no logging time against a missing or archived client.
  if (!clientIsActive(clientId)) return Response.json({ error: 'Client not found or archived' }, { status: 404 });
  const body = await request.json();
  const { description, hours, date, project_id, billable } = body;

  if (!description || !hours || !date) {
    return Response.json({ error: 'description, hours, and date are required' }, { status: 400 });
  }

  if (typeof hours !== 'number' || hours <= 0 || hours > 24) {
    return Response.json({ error: 'hours must be between 0 and 24' }, { status: 400 });
  }

  // A project-scoped entry must belong to THIS client, else the time would be
  // logged against another client's project. NULL project_id = client-level.
  if (project_id != null && !projectBelongsToClient(project_id, clientId)) {
    return Response.json({ error: 'Project not found for this client' }, { status: 404 });
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO crm_time_entries (id, client_id, project_id, description, hours, date, billable, agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'dashboard', datetime('now'))
  `).run(id, clientId, project_id ?? null, description, hours, date, normalizeBillable(billable));

  return Response.json({ id }, { status: 201 });
}
