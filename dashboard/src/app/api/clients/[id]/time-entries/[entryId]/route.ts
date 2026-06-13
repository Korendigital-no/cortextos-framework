import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { projectBelongsToClient } from '@/lib/crm-client-auth';
import { normalizeBillable } from '@/lib/billable';
import { archiveTimeEntry } from '@/lib/time-entry-archive';

export const dynamic = 'force-dynamic';

interface TimeEntryRow { id: string; client_id: string; }

function entryBelongsToClient(entryId: string, clientId: string): TimeEntryRow | null {
  const row = db.prepare('SELECT id, client_id FROM crm_time_entries WHERE id = ?').get(entryId) as TimeEntryRow | undefined;
  if (!row || row.client_id !== clientId) return null;
  return row;
}

/**
 * Edit a time entry — including MOVING it to a different project (or to
 * client-level by sending project_id: null). This is the UI action that
 * replaces hand-editing the DB to reassign mislogged time.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  const { id: clientId, entryId } = await params;
  if (!entryBelongsToClient(entryId, clientId)) {
    return Response.json({ error: 'Time entry not found' }, { status: 404 });
  }

  const body = await request.json();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || !body.description.trim()) {
      return Response.json({ error: 'description must be a non-empty string' }, { status: 400 });
    }
    sets.push('description = ?');
    values.push(body.description.trim());
  }

  if (body.hours !== undefined) {
    if (typeof body.hours !== 'number' || body.hours <= 0 || body.hours > 24) {
      return Response.json({ error: 'hours must be between 0 and 24' }, { status: 400 });
    }
    sets.push('hours = ?');
    values.push(body.hours);
  }

  if (body.date !== undefined) {
    if (typeof body.date !== 'string' || !body.date) {
      return Response.json({ error: 'date must be a non-empty string' }, { status: 400 });
    }
    sets.push('date = ?');
    values.push(body.date);
  }

  // Move between projects. null -> client-level. A target project must belong
  // to this client so time can't be moved onto another client's project.
  if (body.project_id !== undefined) {
    if (body.project_id !== null && !projectBelongsToClient(body.project_id, clientId)) {
      return Response.json({ error: 'Project not found for this client' }, { status: 404 });
    }
    sets.push('project_id = ?');
    values.push(body.project_id ?? null);
  }

  if (body.billable !== undefined) {
    sets.push('billable = ?');
    values.push(normalizeBillable(body.billable));
  }

  if (sets.length === 0) {
    return Response.json({ error: 'No fields to update' }, { status: 400 });
  }

  values.push(entryId);
  db.prepare(`UPDATE crm_time_entries SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  return Response.json({ ok: true });
}

/**
 * Soft delete: MOVE the entry into the crm_time_entries_deleted archive instead
 * of a hard DELETE. The row leaves crm_time_entries, so every live read +
 * aggregation excludes it by-construction (no deleted_at filter to forget across
 * the 10 read sites), and it stays recoverable via the restore endpoint / undo.
 * The move is transactional so a row can never exist in both tables or neither.
 */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  const { id: clientId, entryId } = await params;
  if (!entryBelongsToClient(entryId, clientId)) {
    return Response.json({ error: 'Time entry not found' }, { status: 404 });
  }
  archiveTimeEntry(db, entryId, new Date().toISOString());
  return Response.json({ ok: true });
}
