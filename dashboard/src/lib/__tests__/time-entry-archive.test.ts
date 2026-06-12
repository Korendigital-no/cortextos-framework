/**
 * Soft-delete (move-to-archive) + restore for CRM time entries, against a REAL
 * in-memory dashboard schema (initializeSchema) — so the crm_time_entries_deleted
 * table, its mirror of crm_time_entries, and the by-construction aggregation
 * exclusion are all exercised against the actual DDL, not a hand-written stub.
 *
 * Guards the chosen design over a deleted_at flag: a moved row leaves the live
 * table, so the 4 aggregations (total_hours, entry_count, ...) drop it WITHOUT
 * any filter — the test proves that, plus round-trip restore and the loud
 * FK-failure path when the owning client is gone.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../schema';
import { archiveTimeEntry, restoreTimeEntry } from '../time-entry-archive';

let db: Database.Database;

function seedClient(id = 'client-A'): string {
  const now = '2026-06-01T00:00:00Z';
  db.prepare("INSERT INTO crm_companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(`co-${id}`, `Co ${id}`, now, now);
  db.prepare("INSERT INTO crm_clients (id, company_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, `co-${id}`, now, now);
  return id;
}

function seedEntry(clientId: string, hours: number, opts: { billable?: 0 | 1 | null } = {}): string {
  const id = 'e-' + Math.random().toString(36).slice(2);
  db.prepare(`INSERT INTO crm_time_entries (id, client_id, description, hours, date, billable, agent, created_at)
              VALUES (?, ?, 'work', ?, '2026-06-01', ?, 'dashboard', '2026-06-01T00:00:00Z')`)
    .run(id, clientId, hours, opts.billable ?? null);
  return id;
}

// Route aggregations (mirror /api/clients/route.ts) — must exclude archived rows
// purely because the row is gone from the live table.
const totalHours = (clientId: string) =>
  (db.prepare('SELECT COALESCE(SUM(hours),0) h FROM crm_time_entries WHERE client_id = ?').get(clientId) as { h: number }).h;
const entryCount = (clientId: string) =>
  (db.prepare('SELECT COUNT(*) c FROM crm_time_entries WHERE client_id = ?').get(clientId) as { c: number }).c;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); // matches dashboard/src/lib/db.ts
  initializeSchema(db);
});

describe('archiveTimeEntry (soft delete = move to crm_time_entries_deleted)', () => {
  it('removes the row from the live table and places it in the archive with deleted_at', () => {
    const c = seedClient();
    const e = seedEntry(c, 3);

    archiveTimeEntry(db, e, '2026-06-12T10:00:00Z');

    expect(db.prepare('SELECT 1 FROM crm_time_entries WHERE id = ?').get(e)).toBeUndefined();
    const archived = db.prepare('SELECT * FROM crm_time_entries_deleted WHERE id = ?').get(e) as
      { id: string; client_id: string; hours: number; deleted_at: string } | undefined;
    expect(archived).toBeTruthy();
    expect(archived!.client_id).toBe(c);
    expect(archived!.hours).toBe(3);
    expect(archived!.deleted_at).toBe('2026-06-12T10:00:00Z');
  });

  it('excludes archived entries from aggregations BY CONSTRUCTION (no filter)', () => {
    const c = seedClient();
    const keep = seedEntry(c, 2);
    const drop = seedEntry(c, 5);
    expect(totalHours(c)).toBe(7);
    expect(entryCount(c)).toBe(2);

    archiveTimeEntry(db, drop, '2026-06-12T10:00:00Z');

    expect(totalHours(c)).toBe(2); // 5h dropped without touching the aggregation query
    expect(entryCount(c)).toBe(1);
    expect(db.prepare('SELECT id FROM crm_time_entries WHERE client_id = ?').all(c)).toEqual([{ id: keep }]);
  });

  it('preserves the billable override through the move', () => {
    const c = seedClient();
    const e = seedEntry(c, 1, { billable: 0 });
    archiveTimeEntry(db, e, '2026-06-12T10:00:00Z');
    const row = db.prepare('SELECT billable FROM crm_time_entries_deleted WHERE id = ?').get(e) as { billable: number | null };
    expect(row.billable).toBe(0);
  });
});

describe('restoreTimeEntry (undo = move back to live)', () => {
  it('round-trips a deleted entry back into the live table and clears the archive', () => {
    const c = seedClient();
    const e = seedEntry(c, 4);
    archiveTimeEntry(db, e, '2026-06-12T10:00:00Z');

    restoreTimeEntry(db, e);

    expect(totalHours(c)).toBe(4);
    expect(db.prepare('SELECT 1 FROM crm_time_entries_deleted WHERE id = ?').get(e)).toBeUndefined();
    expect((db.prepare('SELECT hours FROM crm_time_entries WHERE id = ?').get(e) as { hours: number }).hours).toBe(4);
  });

  it('throws (loud failure) when the owning client was deleted while archived', () => {
    const c = seedClient();
    const e = seedEntry(c, 2);
    archiveTimeEntry(db, e, '2026-06-12T10:00:00Z');
    // Client can be deleted now: no LIVE entry references it (the row is archived).
    db.prepare('DELETE FROM crm_clients WHERE id = ?').run(c);

    expect(() => restoreTimeEntry(db, e)).toThrow(); // FK on client_id can't be satisfied
    // The archive row is left intact (transaction rolled back) — nothing lost.
    expect(db.prepare('SELECT 1 FROM crm_time_entries_deleted WHERE id = ?').get(e)).toBeTruthy();
  });
});

describe('crm_time_entries_deleted mirror guard', () => {
  it('has exactly the columns of crm_time_entries plus deleted_at', () => {
    const cols = (t: string) =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name).sort();
    const live = cols('crm_time_entries');
    const archive = cols('crm_time_entries_deleted');
    expect(archive).toEqual([...live, 'deleted_at'].sort());
  });
});
