import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { initializeCrmSchema } from './crm-schema.js';
import { switchToWal } from './sqlite-wal.js';

let instance: Database.Database | null = null;

export function getCrmDb(): Database.Database {
  if (instance) return instance;

  const ctxRoot = process.env.CTX_ROOT;
  const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';

  if (!ctxRoot) {
    throw new Error('CTX_ROOT environment variable is required for CRM database access');
  }

  const dbDir = join(ctxRoot, 'dashboard');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = join(dbDir, `cortextos-${instanceId}.db`);
  const db = new Database(dbPath, { timeout: 10000 });
  db.pragma('busy_timeout = 10000');

  // Bounded retry: both the WAL switch and its recovery read can return
  // SQLITE_BUSY without consulting the busy handler while another process
  // holds the journal-mode transition lock — see sqlite-wal.ts
  // (task_1780568342981; same fix mirrored in dashboard/src/lib/db.ts).
  switchToWal(db);

  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  initializeCrmSchema(db);
  instance = db;
  return db;
}

export function closeCrmDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
