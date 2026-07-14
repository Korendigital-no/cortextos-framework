import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { noteBelongsToClient } from '@/lib/crm-client-auth';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; noteId: string }> }) {
  const { id: clientId, noteId } = await params;
  if (!noteBelongsToClient(noteId, clientId)) return Response.json({ error: 'Note not found' }, { status: 404 });

  const body = await request.json();
  if (!body.body || typeof body.body !== 'string' || !body.body.trim()) {
    return Response.json({ error: 'body is required' }, { status: 400 });
  }

  db.prepare('UPDATE crm_client_notes SET body = ?, updated_at = ? WHERE id = ?')
    .run(body.body.trim(), new Date().toISOString(), noteId);

  return Response.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; noteId: string }> }) {
  const { id: clientId, noteId } = await params;
  if (!noteBelongsToClient(noteId, clientId)) return Response.json({ error: 'Note not found' }, { status: 404 });

  db.prepare('DELETE FROM crm_client_notes WHERE id = ?').run(noteId);
  return Response.json({ ok: true });
}
