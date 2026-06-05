// cortextOS Dashboard - SQLite database singleton
// Read cache for JSON/JSONL files on disk. WAL mode for concurrent reads.

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { initializeSchema } from './schema';
import { switchToWal } from './sqlite-wal';
import { resolveDbPath } from './db-path';

// Path contract (incl. per-process CI isolation for parallel next-build
// workers) lives in db-path.ts where it is unit-tested side-effect-free.
const DB_PATH = resolveDbPath(
  {
    ctxRoot: process.env.CTX_ROOT,
    instanceId: process.env.CTX_INSTANCE_ID,
    buildIsolationId: process.env.CORTEXTOS_BUILD_DB_ISOLATION,
    pid: process.pid,
  },
  process.cwd(),
);

function createDatabase(): Database.Database {
  // Ensure .data directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(DB_PATH, { timeout: 10000 });

  // Set busy_timeout BEFORE attempting any schema or pragma changes that
  // require write locks (e.g. WAL switch, CREATE TABLE). Without this, parallel
  // processes (like Next.js build workers) hit SQLITE_BUSY immediately.
  db.pragma('busy_timeout = 10000');

  // Switch to WAL mode (requires exclusive lock on the DB file). Parallel
  // Next.js build workers race here at module eval; both the switch AND the
  // recovery read can return SQLITE_BUSY without consulting the busy handler
  // during another worker's transition, so this is a bounded retry loop —
  // see sqlite-wal.ts for the full story (task_1780568342981).
  switchToWal(db);
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Run schema initialization
  initializeSchema(db);

  return db;
}

// globalThis singleton survives Next.js hot reload
const globalForDb = globalThis as unknown as {
  __cortextos_db: Database.Database | undefined;
};

export const db = globalForDb.__cortextos_db ?? createDatabase();

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__cortextos_db = db;
}

/** Re-export for explicit initialization (idempotent - db is created on import) */
export function initializeDb(): Database.Database {
  return db;
}

/** Check if the database connection is healthy */
export function isDatabaseReady(): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

/** Get row counts for all tables (useful for diagnostics) */
export function getTableCounts(): Record<string, number> {
  const tables = [
    'tasks',
    'approvals',
    'events',
    'heartbeats',
    'cost_entries',
    'users',
    'messages',
    'sync_meta',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as {
      count: number;
    };
    counts[table] = row.count;
  }
  return counts;
}

export default db;
