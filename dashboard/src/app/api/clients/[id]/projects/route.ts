import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { clientExists, clientIsActive } from '@/lib/crm-client-auth';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params;
  if (!clientExists(clientId)) return Response.json({ error: 'Client not found' }, { status: 404 });

  const projects = db.prepare(`
    SELECT p.*,
      (SELECT COALESCE(SUM(hours), 0) FROM crm_time_entries WHERE project_id = p.id) as total_hours,
      (SELECT COUNT(*) FROM crm_client_tasks WHERE project_id = p.id AND status != 'completed') as open_tasks
    FROM crm_client_projects p
    WHERE p.client_id = ?
    ORDER BY p.status = 'active' DESC, p.updated_at DESC
  `).all(clientId);

  return Response.json(projects);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params;
  // Write gate: archived (soft-deleted) clients are frozen — restore first.
  if (!clientIsActive(clientId)) return Response.json({ error: 'Client not found or archived' }, { status: 404 });

  const body = await request.json();
  const { name, description, status, started_at, due_at, budget_hours, budget_nok } = body;

  if (!name || typeof name !== 'string') {
    return Response.json({ error: 'name is required' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO crm_client_projects (id, client_id, name, description, status, started_at, due_at, budget_hours, budget_nok, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, clientId, name.trim(), description ?? null, status ?? 'active', started_at ?? null, due_at ?? null, budget_hours ?? null, budget_nok ?? null, now, now);

  return Response.json({ id }, { status: 201 });
}
