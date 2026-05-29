import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function checklistBelongsToClient(clid: string, clientId: string): boolean {
  const row = db.prepare('SELECT 1 FROM crm_client_checklists WHERE id = ? AND client_id = ?').get(clid, clientId);
  return !!row;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; clid: string }> }) {
  const { id: clientId, clid } = await params;
  if (!checklistBelongsToClient(clid, clientId)) return Response.json({ error: 'Checklist not found' }, { status: 404 });

  const body = await request.json();
  const { text } = body;
  if (!text || typeof text !== 'string') return Response.json({ error: 'text is required' }, { status: 400 });

  const id = crypto.randomUUID();
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) as p FROM crm_client_checklist_items WHERE checklist_id = ?').get(clid) as { p: number };
  db.prepare('INSERT INTO crm_client_checklist_items (id, checklist_id, text, position, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').run(id, clid, text.trim(), maxPos.p + 1);

  return Response.json({ id }, { status: 201 });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; clid: string }> }) {
  const { id: clientId, clid } = await params;
  if (!checklistBelongsToClient(clid, clientId)) return Response.json({ error: 'Checklist not found' }, { status: 404 });

  const body = await request.json();
  const { item_id, done } = body;
  if (!item_id) return Response.json({ error: 'item_id required' }, { status: 400 });

  db.prepare('UPDATE crm_client_checklist_items SET done = ? WHERE id = ? AND checklist_id = ?').run(done ? 1 : 0, item_id, clid);
  return Response.json({ ok: true });
}
