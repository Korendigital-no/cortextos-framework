import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { projectBelongsToClient } from '@/lib/crm-client-auth';
import { splitBillableHours, type HoursEntry } from '@/lib/billable';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; pid: string }> }) {
  const { id: clientId, pid: projectId } = await params;
  if (!projectBelongsToClient(projectId, clientId)) return Response.json({ error: 'Project not found' }, { status: 404 });

  const project = db.prepare('SELECT * FROM crm_client_projects WHERE id = ?').get(projectId);
  const timeEntries = db.prepare('SELECT * FROM crm_time_entries WHERE project_id = ? ORDER BY date DESC').all(projectId);
  // NOTE: 'completed' MUST be single-quoted. better-sqlite3 ships with
  // SQLITE_DQS=0, so a double-quoted "completed" is parsed as a column name
  // (not a string literal) and throws `no such column: "completed"` → 500.
  const tasks = db.prepare("SELECT * FROM crm_client_tasks WHERE project_id = ? ORDER BY status = 'completed', due_at IS NULL, due_at").all(projectId);
  const notes = db.prepare('SELECT * FROM crm_client_notes WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
  const documents = db.prepare('SELECT * FROM crm_documents WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
  const checklists = db.prepare('SELECT * FROM crm_client_checklists WHERE project_id = ? ORDER BY created_at DESC').all(projectId);

  const totalsRow = db.prepare(`
    SELECT COALESCE(SUM(hours), 0) as total_hours, COUNT(*) as entry_count
    FROM crm_time_entries WHERE project_id = ?
  `).get(projectId) as { total_hours: number; entry_count: number };

  // Billable split: per-entry override on top of the project default, resolved
  // in lib/billable so API/UI agree. Surfaces invoiceable vs non-invoiceable hours.
  const projectBillable = (project as { billable?: 0 | 1 | null } | undefined)?.billable;
  const { billableHours, nonBillableHours } = splitBillableHours(timeEntries as HoursEntry[], projectBillable);
  const totals = { ...totalsRow, billable_hours: billableHours, non_billable_hours: nonBillableHours };

  return Response.json({ project, timeEntries, tasks, notes, documents, checklists, totals });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; pid: string }> }) {
  const { id: clientId, pid: projectId } = await params;
  if (!projectBelongsToClient(projectId, clientId)) return Response.json({ error: 'Project not found' }, { status: 404 });

  const body = await request.json();
  const allowed = ['name', 'description', 'status', 'started_at', 'due_at', 'budget_hours', 'budget_nok'];
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const key of allowed) {
    if (body[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(body[key]);
    }
  }

  if (sets.length === 0) return Response.json({ error: 'No fields to update' }, { status: 400 });

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(projectId);

  db.prepare(`UPDATE crm_client_projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return Response.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; pid: string }> }) {
  const { id: clientId, pid: projectId } = await params;
  if (!projectBelongsToClient(projectId, clientId)) return Response.json({ error: 'Project not found' }, { status: 404 });

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM crm_client_checklist_items WHERE checklist_id IN (SELECT id FROM crm_client_checklists WHERE project_id = ?)').run(projectId);
    db.prepare('DELETE FROM crm_client_checklists WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM crm_client_notes WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM crm_client_tasks WHERE project_id = ?').run(projectId);
    db.prepare('UPDATE crm_time_entries SET project_id = NULL WHERE project_id = ?').run(projectId);
    db.prepare('UPDATE crm_documents SET project_id = NULL WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM crm_client_projects WHERE id = ?').run(projectId);
  });
  txn();
  return Response.json({ ok: true });
}
