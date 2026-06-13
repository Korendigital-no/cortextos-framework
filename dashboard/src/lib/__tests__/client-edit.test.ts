/**
 * Data-layer test for client edit + soft/hard delete (task_1780503843115),
 * against a real in-memory better-sqlite3 mirroring the dashboard CRM schema.
 *
 * Proves the accounting-safe delete policy:
 *  - a client that ever logged time (live OR trashed) has time history → must be
 *    soft-archived, never hard-deleted (preserves invoice-basis records)
 *  - a client with no time history is safe to hard cascade-delete
 *  - hardDeleteClient removes the client + all child rows
 *  - resolveCompanyId reuses a company by name or creates one (edit == add)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  resolveCompanyId,
  clientHasTimeHistory,
  hardDeleteClient,
  isValidClientStatus,
} from '../client-edit';

let db: Database.Database;

const SCHEMA = `
  CREATE TABLE crm_companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT, updated_at TEXT);
  CREATE TABLE crm_clients (
    id TEXT PRIMARY KEY, company_id TEXT, contact_name TEXT, contact_email TEXT,
    deal_type TEXT, rate_nok REAL, rate_description TEXT, hours_commitment TEXT,
    status TEXT DEFAULT 'active', notes TEXT, deleted_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE crm_time_entries (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, project_id TEXT, hours REAL, date TEXT, created_at TEXT);
  CREATE TABLE crm_time_entries_deleted (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, project_id TEXT, hours REAL, date TEXT, created_at TEXT, deleted_at TEXT);
  CREATE TABLE crm_client_projects (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, name TEXT);
  CREATE TABLE crm_client_tasks (id TEXT PRIMARY KEY, client_id TEXT, project_id TEXT, title TEXT);
  CREATE TABLE crm_client_notes (id TEXT PRIMARY KEY, client_id TEXT, project_id TEXT, body TEXT);
  CREATE TABLE crm_client_checklists (id TEXT PRIMARY KEY, client_id TEXT, project_id TEXT, name TEXT);
  CREATE TABLE crm_client_checklist_items (id TEXT PRIMARY KEY, checklist_id TEXT NOT NULL, label TEXT);
  CREATE TABLE crm_documents (id TEXT PRIMARY KEY, client_id TEXT, project_id TEXT, name TEXT);
`;

function makeClient(id: string): void {
  db.prepare(
    "INSERT INTO crm_clients (id, status, created_at, updated_at) VALUES (?, 'active', 't', 't')",
  ).run(id);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA);
});

describe('resolveCompanyId', () => {
  it('reuses an existing company by exact name', () => {
    db.prepare("INSERT INTO crm_companies (id, name) VALUES ('co1', 'Acme AS')").run();
    expect(resolveCompanyId(db, 'Acme AS', 'now')).toBe('co1');
    expect(db.prepare('SELECT COUNT(*) n FROM crm_companies').get()).toEqual({ n: 1 });
  });

  it('creates a company when the name is new', () => {
    const id = resolveCompanyId(db, 'New Co', 'now');
    const row = db.prepare('SELECT name FROM crm_companies WHERE id = ?').get(id);
    expect(row).toEqual({ name: 'New Co' });
  });
});

describe('clientHasTimeHistory (accounting guard)', () => {
  beforeEach(() => makeClient('c1'));

  it('false for a client that never logged time', () => {
    expect(clientHasTimeHistory(db, 'c1')).toBe(false);
  });

  it('true when the client has a live time entry', () => {
    db.prepare("INSERT INTO crm_time_entries (id, client_id, hours, date, created_at) VALUES ('t1','c1',2,'2026-06-01','t')").run();
    expect(clientHasTimeHistory(db, 'c1')).toBe(true);
  });

  it('true when the client only has a SOFT-DELETED (trashed) time entry — history still counts', () => {
    db.prepare("INSERT INTO crm_time_entries_deleted (id, client_id, hours, date, created_at, deleted_at) VALUES ('t1','c1',2,'2026-06-01','t','d')").run();
    expect(clientHasTimeHistory(db, 'c1')).toBe(true);
  });

  it('does not bleed across clients', () => {
    makeClient('c2');
    db.prepare("INSERT INTO crm_time_entries (id, client_id, hours, date, created_at) VALUES ('t1','c2',2,'2026-06-01','t')").run();
    expect(clientHasTimeHistory(db, 'c1')).toBe(false);
    expect(clientHasTimeHistory(db, 'c2')).toBe(true);
  });
});

describe('hardDeleteClient (only for time-history-free clients)', () => {
  it('cascades all child rows and removes the client', () => {
    makeClient('c1');
    db.prepare("INSERT INTO crm_client_projects (id, client_id, name) VALUES ('p1','c1','P')").run();
    db.prepare("INSERT INTO crm_client_tasks (id, client_id, title) VALUES ('tk1','c1','T')").run();
    db.prepare("INSERT INTO crm_client_notes (id, client_id, body) VALUES ('n1','c1','N')").run();
    db.prepare("INSERT INTO crm_client_checklists (id, client_id, name) VALUES ('cl1','c1','CL')").run();
    db.prepare("INSERT INTO crm_client_checklist_items (id, checklist_id, label) VALUES ('i1','cl1','x')").run();
    db.prepare("INSERT INTO crm_documents (id, client_id, name) VALUES ('d1','c1','D')").run();

    hardDeleteClient(db, 'c1');

    const counts = {
      clients: (db.prepare('SELECT COUNT(*) n FROM crm_clients').get() as { n: number }).n,
      projects: (db.prepare('SELECT COUNT(*) n FROM crm_client_projects').get() as { n: number }).n,
      tasks: (db.prepare('SELECT COUNT(*) n FROM crm_client_tasks').get() as { n: number }).n,
      notes: (db.prepare('SELECT COUNT(*) n FROM crm_client_notes').get() as { n: number }).n,
      checklists: (db.prepare('SELECT COUNT(*) n FROM crm_client_checklists').get() as { n: number }).n,
      items: (db.prepare('SELECT COUNT(*) n FROM crm_client_checklist_items').get() as { n: number }).n,
      docs: (db.prepare('SELECT COUNT(*) n FROM crm_documents').get() as { n: number }).n,
    };
    expect(counts).toEqual({ clients: 0, projects: 0, tasks: 0, notes: 0, checklists: 0, items: 0, docs: 0 });
  });

  it('only removes the targeted client, not siblings', () => {
    makeClient('c1');
    makeClient('c2');
    hardDeleteClient(db, 'c1');
    expect(db.prepare('SELECT id FROM crm_clients').all()).toEqual([{ id: 'c2' }]);
  });
});

describe('soft-delete via deleted_at (the archive path)', () => {
  it('archived clients drop out of the active list; restore brings them back', () => {
    makeClient('c1');
    makeClient('c2');
    const activeList = () =>
      db.prepare('SELECT id FROM crm_clients WHERE deleted_at IS NULL ORDER BY id').all();
    expect(activeList()).toEqual([{ id: 'c1' }, { id: 'c2' }]);

    db.prepare("UPDATE crm_clients SET deleted_at = 'now' WHERE id = 'c1'").run(); // archive
    expect(activeList()).toEqual([{ id: 'c2' }]);
    // the row + its data are preserved, just hidden
    expect(db.prepare("SELECT id FROM crm_clients WHERE id = 'c1'").get()).toEqual({ id: 'c1' });

    db.prepare("UPDATE crm_clients SET deleted_at = NULL WHERE id = 'c1'").run(); // restore
    expect(activeList()).toEqual([{ id: 'c1' }, { id: 'c2' }]);
  });

  it('write-gate (clientIsActive query) only passes for a live client', () => {
    makeClient('c1');
    // Mirrors crm-client-auth.clientIsActive — the WHERE used to freeze writes to
    // an archived client (POST tasks/notes/projects/time-entries 404 once archived).
    const isActive = (id: string) =>
      !!db.prepare('SELECT 1 FROM crm_clients WHERE id = ? AND deleted_at IS NULL').get(id);
    expect(isActive('c1')).toBe(true);
    db.prepare("UPDATE crm_clients SET deleted_at = 'now' WHERE id = 'c1'").run();
    expect(isActive('c1')).toBe(false); // archived → writes blocked
    expect(isActive('nope')).toBe(false); // missing → blocked
  });
});

describe('isValidClientStatus', () => {
  it('accepts the canonical set, rejects junk', () => {
    for (const s of ['active', 'inactive', 'archived', 'prospect', 'paused', 'churned']) {
      expect(isValidClientStatus(s)).toBe(true);
    }
    for (const s of ['', 'deleted', 'ACTIVE', 123, null, undefined]) {
      expect(isValidClientStatus(s)).toBe(false);
    }
  });
});
