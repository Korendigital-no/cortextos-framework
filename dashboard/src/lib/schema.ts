// cortextOS Dashboard - SQLite schema definition and migrations.
//
// Extracted from db.ts so the schema can be applied to any Database handle
// (e.g. an in-memory DB in tests) WITHOUT triggering db.ts's module-scope
// singleton side effect (createDatabase opens the real DB file on import).
// The framework's canonical CRM schema lives in src/bus/crm-schema.ts —
// tests/unit/dashboard/schema-drift.test.ts pins this file as a superset of
// it for all crm_* tables, so the two cannot silently drift apart again.

import type Database from 'better-sqlite3';

export function initializeSchema(db: Database.Database): void {
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

    -- Soft-delete archive for time entries (dashboard-only self-serve delete).
    -- Deleting a time entry MOVES the row here in a transaction instead of a hard
    -- DELETE, so every crm_time_entries read + aggregation (10 sites, 4 totals)
    -- stays correct BY-CONSTRUCTION — no deleted_at filter to forget. Restore
    -- moves the row back. Columns mirror crm_time_entries (incl. the project_id +
    -- billable extensions) plus deleted_at; guarded by the mirror test. No FK
    -- constraints: an archive must survive deletion of a referenced client/project.
    CREATE TABLE IF NOT EXISTS crm_time_entries_deleted (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      project_id TEXT,
      description TEXT NOT NULL,
      hours REAL NOT NULL,
      date TEXT NOT NULL,
      billable INTEGER,
      agent TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crm_time_entries_deleted_client ON crm_time_entries_deleted(client_id);

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

    -- Accounting v3: company accounts (Bedriftskonto, Skattekonto, MVA-konto, Privat, ...)
    -- type='personal' is a tag-only bucket: expenses tagged to it still count
    -- in revenue/cost totals but do NOT affect any account balance computation.
    CREATE TABLE IF NOT EXISTS accounting_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('operating','tax','vat','personal','other')),
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

  // Migrate accounting_accounts CHECK constraint to allow 'personal' type.
  // SQLite can't ALTER constraints — do a safe backup/drop/recreate/restore
  // inside a single transaction so partial failure rolls back cleanly.
  migrateAccountsForPersonalType(db);

  // Idempotent column additions (SQLite has no ADD COLUMN IF NOT EXISTS)
  safeAddColumn(db, 'accounting_invoices', 'account_id', 'TEXT REFERENCES accounting_accounts(id) ON DELETE SET NULL');
  safeAddColumn(db, 'accounting_expenses', 'account_id', 'TEXT REFERENCES accounting_accounts(id) ON DELETE SET NULL');
  safeAddColumn(db, 'accounting_expenses', 'recurring_id', 'TEXT REFERENCES accounting_recurring(id) ON DELETE SET NULL');
  // Mirrors columns added by cortextos bus crm-schema.ts so dashboard-only DBs
  // built from this file alone still satisfy queries on contact match metadata.
  safeAddColumn(db, 'crm_contacts', 'match_confidence', 'REAL DEFAULT 1.0');
  safeAddColumn(db, 'crm_contacts', 'needs_review', 'INTEGER DEFAULT 0');
  // Source-based test isolation (#5): the calcom webhook route stamps is_test=1
  // when a request is signed with CALCOM_TEST_WEBHOOK_SECRET. The framework
  // queue processor then drops those jobs to skipped_test (no CRM rows created),
  // so only this audit column is needed. Mirror it so dashboard-built DBs match.
  safeAddColumn(db, 'crm_webhook_log', 'is_test', 'INTEGER DEFAULT 0');
  // Per-project v1: time entries can belong to a project (nullable — a NULL
  // project_id is a client-level entry not yet assigned to any project). The
  // framework's crm-schema.ts already adds project_id on the real DB; mirror it
  // here so dashboard-built DBs match and the project-detail queries resolve.
  safeAddColumn(db, 'crm_time_entries', 'project_id', 'TEXT REFERENCES crm_client_projects(id)');
  // Billable model: the project carries the DEFAULT (billable=1), each time
  // entry carries a NULLABLE override (NULL = inherit the project default,
  // 1 = billable, 0 = non-billable). Effective billability is resolved in
  // src/lib/billable.ts so the rule lives in exactly one place.
  safeAddColumn(db, 'crm_client_projects', 'billable', 'INTEGER NOT NULL DEFAULT 1');
  safeAddColumn(db, 'crm_time_entries', 'billable', 'INTEGER');
  // Mirrors of src/bus/crm-schema.ts (DDL copied verbatim) so dashboard-only
  // DBs satisfy every query the dashboard prepares: project-detail GET/DELETE
  // touch crm_documents.project_id; deal/contact detail pages read
  // crm_meetings.ai_parsed/email_draft. Pinned by the parity test in
  // tests/unit/dashboard/schema-drift.test.ts — when that test fails after a
  // framework schema change, mirror the change here.
  safeAddColumn(db, 'crm_documents', 'client_id', 'TEXT REFERENCES crm_clients(id)');
  safeAddColumn(db, 'crm_documents', 'project_id', 'TEXT REFERENCES crm_client_projects(id)');
  safeAddColumn(db, 'crm_meetings', 'ai_parsed', 'TEXT');
  safeAddColumn(db, 'crm_meetings', 'email_draft', 'TEXT');
  // Soft-delete for clients with billing history (accounting integrity: a client
  // that ever logged time is archived, not destroyed). Dashboard-only column —
  // the active client list filters `deleted_at IS NULL`; restore clears it.
  safeAddColumn(db, 'crm_clients', 'deleted_at', 'TEXT');
  // Intentional-hold/snooze for the stale-deal sweep: a deal with a future
  // snoozed_until (or a "Q3 send" / "hold until <date>" marker in title/notes)
  // is suppressed from the stale sweep until it expires. Mirror so dashboard
  // deal queries resolve the column. See dealHoldUntil() in src/bus/crm.ts.
  safeAddColumn(db, 'crm_deals', 'snoozed_until', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_crm_time_entries_project ON crm_time_entries(project_id);
    CREATE INDEX IF NOT EXISTS idx_crm_documents_client ON crm_documents(client_id);
    CREATE INDEX IF NOT EXISTS idx_crm_documents_project ON crm_documents(project_id);
    CREATE INDEX IF NOT EXISTS idx_crm_clients_deleted_at ON crm_clients(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_crm_deals_company ON crm_deals(company_id);
    CREATE INDEX IF NOT EXISTS idx_crm_activities_due ON crm_activities(due_at);
    CREATE INDEX IF NOT EXISTS idx_crm_meetings_fathom ON crm_meetings(fathom_recording_id);
    CREATE INDEX IF NOT EXISTS idx_crm_webhook_source ON crm_webhook_log(source);
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

export function safeAddColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  // Identifiers are caller-controlled (constants), not user input. Parameter binding
  // is not supported for DDL identifiers in SQLite, so concatenation is correct here.
  //
  // Race-safety: a PRAGMA table_info check followed by ALTER is NOT atomic across
  // processes. `next build` collects page data in parallel worker processes that
  // each open this same SQLite file and run migrations; two workers can both see
  // the column absent and both ALTER, so the loser throws "duplicate column name"
  // and fails the build intermittently. Attempt the ALTER and treat duplicate-
  // column as the benign idempotent outcome it is — the column exists afterward
  // either way. Mirrors the framework's safeAlter (src/bus/crm-schema.ts).
  const sql = 'ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + ddl;
  try {
    db.exec(sql);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name|already exists/i.test(msg)) throw err;
  }
}

function migrateAccountsForPersonalType(db: Database.Database): void {
  // Read the current CREATE statement and short-circuit if the new value is
  // already allowed (covers fresh DBs created with the updated CREATE TABLE).
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='accounting_accounts'",
  ).get() as { sql: string } | undefined;
  if (!row) return; // table doesn't exist yet → CREATE TABLE handles it
  if (row.sql.includes("'personal'")) return; // already migrated

  // Drift guard: the rebuild copies only the 6 columns we know about. If a
  // future migration adds a column without updating this rebuild block, the
  // data in that column would be silently lost. Refuse to migrate when the
  // live schema does not match the expected pre-migration shape; the operator
  // can then update this function intentionally.
  const expectedCols = new Set([
    'id', 'name', 'type', 'starting_balance_nok', 'created_at', 'updated_at',
  ]);
  const liveCols = (db.prepare('PRAGMA table_info(accounting_accounts)').all() as Array<{ name: string }>).map(c => c.name);
  const extra = liveCols.filter(c => !expectedCols.has(c));
  const missing = [...expectedCols].filter(c => !liveCols.includes(c));
  if (extra.length || missing.length) {
    throw new Error(
      `accounting_accounts schema drift detected — refusing personal-type migration. ` +
      `Update migrateAccountsForPersonalType to handle: extra=${JSON.stringify(extra)} missing=${JSON.stringify(missing)}`,
    );
  }
  // Also refuse if any triggers exist on the table — none expected today, but
  // a future trigger would be dropped by the table swap.
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='accounting_accounts'",
  ).all() as Array<{ name: string }>;
  if (triggers.length > 0) {
    throw new Error(
      `accounting_accounts has triggers (${triggers.map(t => t.name).join(', ')}) — ` +
      `refusing migration that would drop them. Update migrateAccountsForPersonalType.`,
    );
  }

  // SQLite blocks DROP of tables that are FK-referenced by other tables, so we
  // disable FK enforcement for the swap. PRAGMA can't run inside a transaction,
  // so structure: pragma off → tx (recreate + restore) → pragma on. The tx
  // rolls back atomically on any failure; FKs are restored either way via the
  // try/finally.
  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE accounting_accounts__new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('operating','tax','vat','personal','other')),
          starting_balance_nok REAL NOT NULL DEFAULT 0 CHECK(starting_balance_nok = starting_balance_nok AND ABS(starting_balance_nok) < 1e12),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO accounting_accounts__new (id, name, type, starting_balance_nok, created_at, updated_at)
          SELECT id, name, type, starting_balance_nok, created_at, updated_at FROM accounting_accounts;
        DROP TABLE accounting_accounts;
        ALTER TABLE accounting_accounts__new RENAME TO accounting_accounts;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_accounts_type ON accounting_accounts(type);
      `);
    });
    tx();
    // Verify FK integrity after the swap before we re-enable enforcement.
    const fkProblems = db.pragma('foreign_key_check') as Array<unknown>;
    if (fkProblems.length > 0) {
      throw new Error(`Foreign key integrity broken after accounts migration: ${JSON.stringify(fkProblems)}`);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
