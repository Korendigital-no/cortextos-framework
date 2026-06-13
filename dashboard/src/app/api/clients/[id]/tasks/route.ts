import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { clientExists, clientIsActive, projectBelongsToClient } from '@/lib/crm-client-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params;
  if (!clientExists(clientId)) return Response.json({ error: 'Client not found' }, { status: 404 });

  const { searchParams } = request.nextUrl;
  const projectId = searchParams.get('project') || undefined;
  const status = searchParams.get('status') || undefined;

  const conditions: string[] = ['client_id = ?'];
  const values: unknown[] = [clientId];

  if (projectId) { conditions.push('project_id = ?'); values.push(projectId); }
  if (status) { conditions.push('status = ?'); values.push(status); }

  const tasks = db.prepare(`
    SELECT * FROM crm_client_tasks
    WHERE ${conditions.join(' AND ')}
    ORDER BY status = 'completed', due_at IS NULL, due_at, created_at DESC
  `).all(...values);

  return Response.json(tasks);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params;
  // Write gate: archived (soft-deleted) clients are frozen — restore first.
  if (!clientIsActive(clientId)) return Response.json({ error: 'Client not found or archived' }, { status: 404 });

  const body = await request.json();
  const { title, description, status, priority, due_at, project_id, assigned_to } = body;

  if (!title || typeof title !== 'string') {
    return Response.json({ error: 'title is required' }, { status: 400 });
  }

  if (project_id && !projectBelongsToClient(project_id, clientId)) {
    return Response.json({ error: 'Project does not belong to this client' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO crm_client_tasks (id, client_id, project_id, title, description, status, priority, due_at, assigned_to, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, clientId, project_id ?? null, title.trim(), description ?? null, status ?? 'pending', priority ?? 'normal', due_at ?? null, assigned_to ?? 'me', now, now);

  return Response.json({ id }, { status: 201 });
}
