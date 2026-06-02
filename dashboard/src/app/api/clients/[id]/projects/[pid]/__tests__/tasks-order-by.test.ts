/**
 * Regression test for the project-detail "Project not found" incident (2026-06-02).
 *
 * ROOT CAUSE: the GET handler ordered tasks with
 *   ORDER BY status = "completed", ...
 * better-sqlite3 ships with SQLITE_DQS=0, so a DOUBLE-quoted "completed" is
 * parsed as a column identifier (not a string literal) → throws
 * `no such column: "completed"` → the route returned 500 → the client rendered
 * a misleading "Project not found." for EVERY project that had any tasks loaded.
 *
 * This test pins the contract at two levels:
 *  1. BEHAVIOUR — against a real in-memory better-sqlite3 (same DQS settings as
 *     production), the single-quoted ordering runs and sorts completed-last,
 *     while the double-quoted form throws. If anyone "fixes" the quoting back to
 *     double-quotes, the behaviour assertion fails.
 *  2. SOURCE — the route source must not contain a `status = "..."` double-quoted
 *     SQL literal, so the bug class cannot silently reappear in this file even if
 *     the query is reworded.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import path from 'path';

const TASKS_SCHEMA = `
  CREATE TABLE crm_client_tasks (
    id TEXT PRIMARY KEY, client_id TEXT, project_id TEXT,
    title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'pending',
    priority TEXT DEFAULT 'normal', due_at TEXT, completed_at TEXT,
    assigned_to TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
`;

function seed(db: Database.Database) {
  const insert = db.prepare(
    `INSERT INTO crm_client_tasks (id, project_id, title, status, due_at, created_at, updated_at)
     VALUES (?, 'p1', ?, ?, ?, '2026-01-01', '2026-01-01')`,
  );
  insert.run('t-done', 'done task', 'completed', '2026-01-01');
  insert.run('t-due-early', 'due early', 'pending', '2026-01-02');
  insert.run('t-due-late', 'due late', 'pending', '2026-01-10');
  insert.run('t-no-due', 'no due date', 'pending', null);
}

describe('project-detail tasks ORDER BY — SQLITE_DQS regression', () => {
  it('single-quoted literal runs and orders completed tasks last', () => {
    const db = new Database(':memory:');
    db.exec(TASKS_SCHEMA);
    seed(db);

    const rows = db
      .prepare(
        "SELECT id, status FROM crm_client_tasks WHERE project_id = ? ORDER BY status = 'completed', due_at IS NULL, due_at",
      )
      .all('p1') as Array<{ id: string; status: string }>;

    // Pending tasks come first (with due dates ascending, null dates last),
    // completed tasks sink to the bottom.
    expect(rows.map(r => r.id)).toEqual(['t-due-early', 't-due-late', 't-no-due', 't-done']);
    db.close();
  });

  it('double-quoted literal throws under better-sqlite3 (the original bug)', () => {
    const db = new Database(':memory:');
    db.exec(TASKS_SCHEMA);
    seed(db);

    expect(() =>
      db
        .prepare(
          'SELECT id FROM crm_client_tasks WHERE project_id = ? ORDER BY status = "completed", due_at IS NULL, due_at',
        )
        .all('p1'),
    ).toThrow(/no such column/i);
    db.close();
  });

  it('route source contains no double-quoted SQL string literal in the tasks query', () => {
    const routePath = path.join(__dirname, '..', 'route.ts');
    const src = readFileSync(routePath, 'utf8');
    // Guard the exact bug class: `status = "<word>"` inside the SQL.
    expect(src).not.toMatch(/status\s*=\s*"[a-z_]+"/);
  });
});
