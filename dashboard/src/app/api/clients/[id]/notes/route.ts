import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { clientExists, clientIsActive, projectBelongsToClient } from '@/lib/crm-client-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params;
  if (!clientExists(clientId)) return Response.json({ error: 'Client not found' }, { status: 404 });

  const { searchParams } = request.nextUrl;
  const projectId = searchParams.get('project') || undefined;

  let notes;
  if (projectId) {
    notes = db.prepare('SELECT * FROM crm_client_notes WHERE client_id = ? AND project_id = ? ORDER BY created_at DESC').all(clientId, projectId);
  } else {
    notes = db.prepare('SELECT * FROM crm_client_notes WHERE client_id = ? ORDER BY created_at DESC').all(clientId);
  }
  return Response.json(notes);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params;
  // Write gate: archived (soft-deleted) clients are frozen — restore first.
  if (!clientIsActive(clientId)) return Response.json({ error: 'Client not found or archived' }, { status: 404 });

  const body = await request.json();
  const { body: noteBody, project_id } = body;

  if (!noteBody || typeof noteBody !== 'string' || !noteBody.trim()) {
    return Response.json({ error: 'body is required' }, { status: 400 });
  }

  if (project_id && !projectBelongsToClient(project_id, clientId)) {
    return Response.json({ error: 'Project does not belong to this client' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO crm_client_notes (id, client_id, project_id, body, agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'dashboard', ?, ?)
  `).run(id, clientId, project_id ?? null, noteBody.trim(), now, now);

  return Response.json({ id }, { status: 201 });
}
