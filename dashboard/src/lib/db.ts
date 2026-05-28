// cortextOS Dashboard - SQLite database singleton
// Read cache for JSON/JSONL files on disk. WAL mode for concurrent reads.

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
const ctxRoot = process.env.CTX_ROOT;
const DB_PATH = ctxRoot
  ? path.join(ctxRoot, 'dashboard', `cortextos-${instanceId}.db`)
  : path.join(process.cwd(), '.data', `cortextos-${instanceId}.db`);

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

  // Switch to WAL mode (requires exclusive lock on the DB file).
  // Guard against SQLITE_BUSY when multiple Next.js build workers open the DB
  // simultaneously: if the switch fails, check whether another worker already
  // succeeded. If so, continue; otherwise re-throw.
  try {
    db.pragma('journal_mode = WAL');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException & { code?: string }).code !== 'SQLITE_BUSY') throw err;
    const rows = db.pragma('journal_mode') as { journal_mode: string }[];
    if (rows[0]?.journal_mode !== 'wal') throw err;
    // Another worker already switched to WAL — we're fine.
  }
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Run schema initialization
  initializeSchema(db);

  return db;
}

function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'normal',
      assignee TEXT,
      org TEXT NOT NULL DEFAULT '',
      project TEXT,
      needs_approval INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      completed_at TEXT,
      notes TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_note TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      category TEXT,
      severity TEXT NOT NULL DEFAULT 'info',
      data TEXT,
      message TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS heartbeats (
      agent TEXT PRIMARY KEY,
      org TEXT NOT NULL DEFAULT '',
      status TEXT,
      current_task TEXT,
      mode TEXT,
      last_heartbeat TEXT,
      loop_interval INTEGER,
      uptime_seconds INTEGER
    );

    CREATE TABLE IF NOT EXISTS cost_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      file_path TEXT PRIMARY KEY,
      mtime REAL NOT NULL,
      last_synced TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Rate limit table: persists across server restarts so limits survive hot-reloads
    -- and intentional restarts. reset_at is a Unix timestamp in milliseconds.
    CREATE TABLE IF NOT EXISTS rate_limits (
      ip TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      reset_at INTEGER NOT NULL
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

    CREATE INDEX IF NOT EXISTS idx_approvals_org ON approvals(org);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(agent);

    CREATE INDEX IF NOT EXISTS idx_events_org ON events(org);
    CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);

    CREATE INDEX IF NOT EXISTS idx_cost_entries_timestamp ON cost_entries(timestamp);
    CREATE INDEX IF NOT EXISTS idx_cost_entries_agent ON cost_entries(agent);
    CREATE INDEX IF NOT EXISTS idx_cost_entries_org ON cost_entries(org);

    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent);
    CREATE INDEX IF NOT EXISTS idx_messages_org ON messages(org);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

    -- CRM tables
    CREATE TABLE IF NOT EXISTS crm_companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT, industry TEXT,
      org_number TEXT, size TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crm_contacts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT,
      company_id TEXT REFERENCES crm_companies(id), source TEXT, source_ref TEXT,
      notes TEXT, tags TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crm_deals (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, value_nok REAL,
      stage TEXT NOT NULL DEFAULT 'lead', contact_id TEXT REFERENCES crm_contacts(id),
      company_id TEXT REFERENCES crm_companies(id), expected_close TEXT, notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS crm_meetings (
      id TEXT PRIMARY KEY, fathom_recording_id TEXT UNIQUE, title TEXT, summary TEXT,
      transcript TEXT, action_items TEXT, attendees TEXT, recording_url TEXT, share_url TEXT,
      meeting_start TEXT, meeting_end TEXT, follow_up_drafted INTEGER DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crm_activities (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, subject TEXT, body TEXT,
      contact_id TEXT REFERENCES crm_contacts(id), deal_id TEXT REFERENCES crm_deals(id),
      meeting_id TEXT REFERENCES crm_meetings(id), agent TEXT, due_at TEXT,
      completed_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crm_webhook_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, event_type TEXT,
      payload TEXT, status TEXT DEFAULT 'pending', attempt_count INTEGER DEFAULT 0,
      next_retry_at TEXT, locked_at TEXT, last_error TEXT, processed_at TEXT,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crm_review_queue (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, entity_id TEXT NOT NULL,
      context TEXT, status TEXT DEFAULT 'pending', resolved_by TEXT,
      created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS crm_documents (
      id TEXT PRIMARY KEY, contact_id TEXT REFERENCES crm_contacts(id),
      deal_id TEXT REFERENCES crm_deals(id), filename TEXT NOT NULL,
      filepath TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER,
      uploaded_by TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crm_documents_contact ON crm_documents(contact_id);
    CREATE INDEX IF NOT EXISTS idx_crm_documents_deal ON crm_documents(deal_id);
    CREATE INDEX IF NOT EXISTS idx_crm_review_queue_status ON crm_review_queue(status);
    CREATE TABLE IF NOT EXISTS crm_clients (
      id TEXT PRIMARY KEY, company_id TEXT REFERENCES crm_companies(id),
      contact_name TEXT, contact_email TEXT, deal_type TEXT,
      rate_nok REAL, rate_description TEXT, hours_commitment TEXT,
      status TEXT DEFAULT 'active', notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crm_time_entries (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES crm_clients(id),
      description TEXT NOT NULL, hours REAL NOT NULL, date TEXT NOT NULL,
      agent TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crm_clients_status ON crm_clients(status);
    CREATE INDEX IF NOT EXISTS idx_crm_time_entries_client ON crm_time_entries(client_id);
    CREATE INDEX IF NOT EXISTS idx_crm_time_entries_date ON crm_time_entries(date);

    CREATE TABLE IF NOT EXISTS crm_client_projects (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES crm_clients(id),
      name TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'active',
      started_at TEXT, due_at TEXT, budget_hours REAL, budget_nok REAL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crm_client_tasks (
      id TEXT PRIMARY KEY, client_id TEXT REFERENCES crm_clients(id),
      project_id TEXT REFERENCES crm_client_projects(id),
      title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'normal', due_at TEXT, completed_at TEXT,
      assigned_to TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crm_client_notes (
      id TEXT PRIMARY KEY, client_id TEXT REFERENCES crm_clients(id),
      project_id TEXT REFERENCES crm_client_projects(id),
      body TEXT NOT NULL, agent TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crm_client_checklists (
      id TEXT PRIMARY KEY, client_id TEXT REFERENCES crm_clients(id),
      project_id TEXT REFERENCES crm_client_projects(id),
      title TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crm_client_checklist_items (
      id TEXT PRIMARY KEY, checklist_id TEXT NOT NULL REFERENCES crm_client_checklists(id),
      text TEXT NOT NULL, done INTEGER DEFAULT 0, position INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crm_client_projects_client ON crm_client_projects(client_id);
    CREATE INDEX IF NOT EXISTS idx_crm_client_tasks_client ON crm_client_tasks(client_id);
    CREATE INDEX IF NOT EXISTS idx_crm_client_tasks_project ON crm_client_tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_crm_client_notes_client ON crm_client_notes(client_id);
    CREATE INDEX IF NOT EXISTS idx_crm_client_notes_project ON crm_client_notes(project_id);
    CREATE INDEX IF NOT EXISTS idx_crm_client_checklists_client ON crm_client_checklists(client_id);
    CREATE INDEX IF NOT EXISTS idx_crm_client_checklists_project ON crm_client_checklists(project_id);
    CREATE INDEX IF NOT EXISTS idx_crm_client_checklist_items_list ON crm_client_checklist_items(checklist_id);

    -- Accounting (manual entry)
    CREATE TABLE IF NOT EXISTS accounting_invoices (
      id TEXT PRIMARY KEY,
      invoice_number TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      issue_date TEXT NOT NULL CHECK(issue_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      due_date TEXT CHECK(due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      net_nok REAL NOT NULL CHECK(net_nok >= 0 AND net_nok = net_nok AND net_nok < 1e12),
      vat_nok REAL NOT NULL DEFAULT 0 CHECK(vat_nok >= 0 AND vat_nok = vat_nok AND vat_nok < 1e12),
      settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)),
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounting_expenses (
      id TEXT PRIMARY KEY,
      supplier_name TEXT NOT NULL,
      description TEXT,
      date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      net_nok REAL NOT NULL CHECK(net_nok >= 0 AND net_nok = net_nok AND net_nok < 1e12),
      vat_nok REAL NOT NULL DEFAULT 0 CHECK(vat_nok >= 0 AND vat_nok = vat_nok AND vat_nok < 1e12),
      paid INTEGER NOT NULL DEFAULT 1 CHECK(paid IN (0,1)),
      account TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_invoices_number ON accounting_invoices(invoice_number);
    CREATE INDEX IF NOT EXISTS idx_accounting_invoices_date ON accounting_invoices(issue_date);
    CREATE INDEX IF NOT EXISTS idx_accounting_invoices_settled ON accounting_invoices(settled);
    CREATE INDEX IF NOT EXISTS idx_accounting_expenses_date ON accounting_expenses(date);
    CREATE INDEX IF NOT EXISTS idx_accounting_expenses_paid ON accounting_expenses(paid);

    -- Accounting v3: company accounts (Bedriftskonto, Skattekonto, MVA-konto, ...)
    CREATE TABLE IF NOT EXISTS accounting_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('operating','tax','vat','other')),
      starting_balance_nok REAL NOT NULL DEFAULT 0 CHECK(starting_balance_nok = starting_balance_nok AND ABS(starting_balance_nok) < 1e12),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_accounts_type ON accounting_accounts(type);

    -- Accounting v3: recurring monthly deductions (rent, salaries, subscriptions, ...)
    CREATE TABLE IF NOT EXISTS accounting_recurring (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounting_accounts(id) ON DELETE RESTRICT,
      amount_nok REAL NOT NULL CHECK(amount_nok >= 0 AND amount_nok = amount_nok AND amount_nok < 1e12),
      day_of_month INTEGER NOT NULL CHECK(day_of_month BETWEEN 1 AND 28),
      apply_on_last_day INTEGER NOT NULL DEFAULT 0 CHECK(apply_on_last_day IN (0,1)),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      last_applied_ym TEXT CHECK(last_applied_ym IS NULL OR last_applied_ym GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_accounting_recurring_active ON accounting_recurring(active);
    CREATE INDEX IF NOT EXISTS idx_accounting_recurring_account ON accounting_recurring(account_id);
    DROP INDEX IF EXISTS idx_crm_contacts_email;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contacts_email ON crm_contacts(email);
    CREATE INDEX IF NOT EXISTS idx_crm_contacts_company ON crm_contacts(company_id);
    CREATE INDEX IF NOT EXISTS idx_crm_deals_stage ON crm_deals(stage);
    CREATE INDEX IF NOT EXISTS idx_crm_deals_contact ON crm_deals(contact_id);
    CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON crm_activities(contact_id);
    CREATE INDEX IF NOT EXISTS idx_crm_activities_deal ON crm_activities(deal_id);
    CREATE INDEX IF NOT EXISTS idx_crm_activities_type ON crm_activities(type);
  `);

  // Idempotent column additions (SQLite has no ADD COLUMN IF NOT EXISTS)
  safeAddColumn(db, 'accounting_invoices', 'account_id', 'TEXT REFERENCES accounting_accounts(id) ON DELETE SET NULL');
  safeAddColumn(db, 'accounting_expenses', 'account_id', 'TEXT REFERENCES accounting_accounts(id) ON DELETE SET NULL');
  safeAddColumn(db, 'accounting_expenses', 'recurring_id', 'TEXT REFERENCES accounting_recurring(id) ON DELETE SET NULL');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_accounting_invoices_account ON accounting_invoices(account_id);
    CREATE INDEX IF NOT EXISTS idx_accounting_expenses_account ON accounting_expenses(account_id);
    CREATE INDEX IF NOT EXISTS idx_accounting_expenses_recurring ON accounting_expenses(recurring_id);
    -- Hard guarantee: at most one auto-posted expense per recurring per calendar month.
    -- Used by the recurring engine to make double-apply impossible under concurrent calls.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_expenses_recurring_month
      ON accounting_expenses(recurring_id, substr(date, 1, 7))
      WHERE recurring_id IS NOT NULL;
  `);
}

function safeAddColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  // Identifiers are caller-controlled (constants), not user input. Parameter binding
  // is not supported for DDL identifiers in SQLite, so concatenation is correct here.
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string }>;
  if (cols.some(c => c.name === column)) return;
  const sql = 'ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + ddl;
  db.exec(sql);
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
