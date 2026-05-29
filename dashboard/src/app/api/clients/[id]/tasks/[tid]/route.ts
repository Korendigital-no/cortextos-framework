import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { clientTaskBelongsToClient } from '@/lib/crm-client-auth';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; tid: string }> }) {
  const { id: clientId, tid: taskId } = await params;
  if (!clientTaskBelongsToClient(taskId, clientId)) return Response.json({ error: 'Task not found' }, { status: 404 });

  const body = await request.json();
  const allowed = ['title', 'description', 'status', 'priority', 'due_at', 'assigned_to'];
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const key of allowed) {
    if (body[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(body[key]);
    }
  }

  if (body.status === 'completed') {
    sets.push('completed_at = ?');
    values.push(new Date().toISOString());
  }

  if (sets.length === 0) return Response.json({ error: 'No fields to update' }, { status: 400 });

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(taskId);

  db.prepare(`UPDATE crm_client_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return Response.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; tid: string }> }) {
  const { id: clientId, tid: taskId } = await params;
  if (!clientTaskBelongsToClient(taskId, clientId)) return Response.json({ error: 'Task not found' }, { status: 404 });

  db.prepare('DELETE FROM crm_client_tasks WHERE id = ?').run(taskId);
  return Response.json({ ok: true });
}
