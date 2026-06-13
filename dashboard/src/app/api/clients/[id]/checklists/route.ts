import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { clientExists, clientIsActive, projectBelongsToClient } from '@/lib/crm-client-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params;
  if (!clientExists(clientId)) return Response.json({ error: 'Client not found' }, { status: 404 });

  const { searchParams } = request.nextUrl;
  const projectId = searchParams.get('project') || undefined;

  const checklists = projectId
    ? db.prepare('SELECT * FROM crm_client_checklists WHERE client_id = ? AND project_id = ? ORDER BY created_at DESC').all(clientId, projectId)
    : db.prepare('SELECT * FROM crm_client_checklists WHERE client_id = ? ORDER BY created_at DESC').all(clientId);

  const result = (checklists as Array<{ id: string }>).map(cl => ({
    ...cl,
    items: db.prepare('SELECT * FROM crm_client_checklist_items WHERE checklist_id = ? ORDER BY position, created_at').all(cl.id),
  }));

  return Response.json(result);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params;
  // Write gate: archived (soft-deleted) clients are frozen — restore first.
  if (!clientIsActive(clientId)) return Response.json({ error: 'Client not found or archived' }, { status: 404 });

  const body = await request.json();
  const { title, project_id, items } = body;

  if (!title || typeof title !== 'string') {
    return Response.json({ error: 'title is required' }, { status: 400 });
  }

  if (project_id && !projectBelongsToClient(project_id, clientId)) {
    return Response.json({ error: 'Project does not belong to this client' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    db.prepare('INSERT INTO crm_client_checklists (id, client_id, project_id, title, created_at) VALUES (?, ?, ?, ?, ?)').run(id, clientId, project_id ?? null, title.trim(), now);
    if (Array.isArray(items)) {
      items.forEach((text: string, idx: number) => {
        if (typeof text === 'string' && text.trim()) {
          db.prepare('INSERT INTO crm_client_checklist_items (id, checklist_id, text, position, created_at) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), id, text.trim(), idx, now);
        }
      });
    }
  });
  txn();

  return Response.json({ id }, { status: 201 });
}
