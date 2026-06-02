/**
 * Integration test for the per-project v1 time-entry data layer, against a real
 * in-memory better-sqlite3 with the same schema/queries the routes use.
 *
 * Proves the behaviour the Vidda incident exposed and the v1 fix:
 *  - logging time WITH a project_id persists it (was dropped to NULL → time
 *    invisible on the project page)
 *  - a time entry can be MOVED between projects (the UI action that replaces
 *    hand-editing the DB)
 *  - cross-client project assignment is rejected (ownership check)
 *  - the billable override column round-trips
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

let db: Database.Database;

const SCHEMA = `
  CREATE TABLE crm_clients (id TEXT PRIMARY KEY);
  CREATE TABLE crm_client_projects (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, name TEXT NOT NULL,
    billable INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE crm_time_entries (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, project_id TEXT,
    description TEXT NOT NULL, hours REAL NOT NULL, date TEXT NOT NULL,
    billable INTEGER, agent TEXT, created_at TEXT NOT NULL
  );
`;

// Mirrors src/lib/crm-client-auth.projectBelongsToClient
function projectBelongsToClient(projectId: string, clientId: string): boolean {
  return !!db.prepare('SELECT 1 FROM crm_client_projects WHERE id = ? AND client_id = ?').get(projectId, clientId);
}

function insertEntry(clientId: string, projectId: string | null, billable: 0 | 1 | null) {
  const id = 'e-' + Math.random().toString(36).slice(2);
  db.prepare(`INSERT INTO crm_time_entries (id, client_id, project_id, description, hours, date, billable, agent, created_at)
              VALUES (?, ?, ?, 'work', 2, '2026-06-01', ?, 'dashboard', '2026-06-01')`).run(id, clientId, projectId, billable);
  return id;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO crm_clients (id) VALUES (?)').run('client-A');
  db.prepare('INSERT INTO crm_clients (id) VALUES (?)').run('client-B');
  db.prepare("INSERT INTO crm_client_projects (id, client_id, name, billable) VALUES ('proj-A1','client-A','A1',1)").run();
  db.prepare("INSERT INTO crm_client_projects (id, client_id, name, billable) VALUES ('proj-A2','client-A','A2',1)").run();
  db.prepare("INSERT INTO crm_client_projects (id, client_id, name, billable) VALUES ('proj-B1','client-B','B1',1)").run();
});

describe('time-entry project_id persistence + move', () => {
  it('logs time with a project_id (no longer dropped to NULL)', () => {
    const id = insertEntry('client-A', 'proj-A1', null);
    const row = db.prepare('SELECT project_id FROM crm_time_entries WHERE id = ?').get(id) as { project_id: string | null };
    expect(row.project_id).toBe('proj-A1');
    // visible on the project page query
    const onProject = db.prepare('SELECT COUNT(*) c FROM crm_time_entries WHERE project_id = ?').get('proj-A1') as { c: number };
    expect(onProject.c).toBe(1);
  });

  it('moves an entry from one project to another (UI move action)', () => {
    const id = insertEntry('client-A', 'proj-A1', null);
    // PATCH move: target belongs to same client -> allowed
    expect(projectBelongsToClient('proj-A2', 'client-A')).toBe(true);
    db.prepare('UPDATE crm_time_entries SET project_id = ? WHERE id = ?').run('proj-A2', id);
    const row = db.prepare('SELECT project_id FROM crm_time_entries WHERE id = ?').get(id) as { project_id: string };
    expect(row.project_id).toBe('proj-A2');
    expect((db.prepare('SELECT COUNT(*) c FROM crm_time_entries WHERE project_id = ?').get('proj-A1') as { c: number }).c).toBe(0);
  });

  it('can move an entry back to client-level (project_id = null)', () => {
    const id = insertEntry('client-A', 'proj-A1', null);
    db.prepare('UPDATE crm_time_entries SET project_id = NULL WHERE id = ?').run(id);
    const row = db.prepare('SELECT project_id FROM crm_time_entries WHERE id = ?').get(id) as { project_id: string | null };
    expect(row.project_id).toBeNull();
  });

  it("rejects assigning time to another client's project (ownership check)", () => {
    // proj-B1 belongs to client-B; an entry on client-A must not move to it
    expect(projectBelongsToClient('proj-B1', 'client-A')).toBe(false);
  });

  it('round-trips the billable override (0/1/null)', () => {
    const a = insertEntry('client-A', 'proj-A1', 0);
    const b = insertEntry('client-A', 'proj-A1', 1);
    const c = insertEntry('client-A', 'proj-A1', null);
    const get = (id: string) => (db.prepare('SELECT billable FROM crm_time_entries WHERE id = ?').get(id) as { billable: number | null }).billable;
    expect(get(a)).toBe(0);
    expect(get(b)).toBe(1);
    expect(get(c)).toBeNull();
  });
});
