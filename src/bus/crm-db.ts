import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { initializeCrmSchema } from './crm-schema.js';

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

  try {
    db.pragma('journal_mode = WAL');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException & { code?: string }).code !== 'SQLITE_BUSY') throw err;
    const rows = db.pragma('journal_mode') as { journal_mode: string }[];
    if (rows[0]?.journal_mode !== 'wal') throw err;
  }

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
