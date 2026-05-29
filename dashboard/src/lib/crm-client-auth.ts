import { db } from '@/lib/db';

export function clientExists(clientId: string): boolean {
  const row = db.prepare('SELECT 1 FROM crm_clients WHERE id = ?').get(clientId);
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
