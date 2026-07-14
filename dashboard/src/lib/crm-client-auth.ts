import { db } from '@/lib/db';

export function clientExists(clientId: string): boolean {
  const row = db.prepare('SELECT 1 FROM crm_clients WHERE id = ?').get(clientId);
  return !!row;
}

/**
 * True only for a LIVE (non-archived) client. Use this to gate WRITES so an
 * archived (soft-deleted) client is frozen — new tasks/notes/projects/time
 * entries can't be added to it via direct API calls, which would make a later
 * restore surprising. Reads still use clientExists so the archived detail view
 * (with its Restore button) can load. A client must be restored before it
 * accepts new child rows again.
 */
export function clientIsActive(clientId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM crm_clients WHERE id = ? AND deleted_at IS NULL')
    .get(clientId);
  return !!row;
}

export function projectBelongsToClient(projectId: string, clientId: string): boolean {
  const row = db.prepare('SELECT 1 FROM crm_client_projects WHERE id = ? AND client_id = ?').get(projectId, clientId);
  return !!row;
}

export function clientTaskBelongsToClient(taskId: string, clientId: string): boolean {
  const row = db.prepare('SELECT 1 FROM crm_client_tasks WHERE id = ? AND client_id = ?').get(taskId, clientId);
  return !!row;
}

export function noteBelongsToClient(noteId: string, clientId: string): boolean {
  const row = db.prepare('SELECT 1 FROM crm_client_notes WHERE id = ? AND client_id = ?').get(noteId, clientId);
  return !!row;
}
