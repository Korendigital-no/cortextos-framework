import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { initializeCrmSchema } from './crm-schema.js';
import { switchToWal } from './sqlite-wal.js';
import { resolveEnv } from '../utils/env.js';

let instance: Database.Database | null = null;

export function getCrmDb(): Database.Database {
  if (instance) return instance;

  // resolveEnv, not raw process.env: honors .cortextos-env and falls back to
  // the canonical default root (~/.cortextos/<instanceId>) like every other
  // bus module — a CRM CLI command run from a normal checkout must not throw
  // just because CTX_ROOT was not exported (task_1780606343419).
  //
  // agentName override: only ctxRoot/instanceId are consumed here, but
  // resolveEnv defaults agentName to basename(cwd) AND validates it — without
  // the override, running a CRM command from any directory with an uppercase
  // name (~/Documents, ~/MyProject) would throw "CTX_AGENT_NAME is invalid",
  // trading one spurious env failure for another. The constant is valid and
  // discarded; the sandbox/live leak guards in resolveEnv still run on the
  // real env values.
  const { ctxRoot, instanceId } = resolveEnv({ agentName: 'crm-db' });

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
