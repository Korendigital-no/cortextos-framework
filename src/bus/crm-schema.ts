import type Database from 'better-sqlite3';

function safeAlter(db: Database.Database, sql: string): void {
  try { db.exec(sql); } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name|already exists/i.test(msg)) throw err;
  }
}

export function initializeCrmSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT,
      industry TEXT,
      org_number TEXT,
      size TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crm_contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      company_id TEXT REFERENCES crm_companies(id),
      source TEXT,
      source_ref TEXT,
      notes TEXT,
      tags TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crm_deals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      value_nok REAL,
      stage TEXT NOT NULL DEFAULT 'lead',
      contact_id TEXT REFERENCES crm_contacts(id),
      company_id TEXT REFERENCES crm_companies(id),
      expected_close TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS crm_meetings (
      id TEXT PRIMARY KEY,
      fathom_recording_id TEXT UNIQUE,
      title TEXT,
      summary TEXT,
      transcript TEXT,
      action_items TEXT,
      attendees TEXT,
      recording_url TEXT,
      share_url TEXT,
      meeting_start TEXT,
      meeting_end TEXT,
      follow_up_drafted INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crm_activities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      subject TEXT,
      body TEXT,
      contact_id TEXT REFERENCES crm_contacts(id),
      deal_id TEXT REFERENCES crm_deals(id),
      meeting_id TEXT REFERENCES crm_meetings(id),
      agent TEXT,
      due_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crm_webhook_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      event_type TEXT,
      payload TEXT,
      status TEXT DEFAULT 'pending',
      attempt_count INTEGER DEFAULT 0,
      next_retry_at TEXT,
      locked_at TEXT,
      last_error TEXT,
      processed_at TEXT,
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crm_review_queue (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      context TEXT,
      status TEXT DEFAULT 'pending',
      resolved_by TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS crm_documents (
      id TEXT PRIMARY KEY,
      contact_id TEXT REFERENCES crm_contacts(id),
      deal_id TEXT REFERENCES crm_deals(id),
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      uploaded_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_crm_documents_contact ON crm_documents(contact_id);
    CREATE INDEX IF NOT EXISTS idx_crm_documents_deal ON crm_documents(deal_id);
    CREATE INDEX IF NOT EXISTS idx_crm_review_queue_status ON crm_review_queue(status);

    -- Clients & time tracking
    CREATE TABLE IF NOT EXISTS crm_clients (
      id TEXT PRIMARY KEY,
      company_id TEXT REFERENCES crm_companies(id),
      contact_name TEXT,
      contact_email TEXT,
      deal_type TEXT,
      rate_nok REAL,
      rate_description TEXT,
      hours_commitment TEXT,
      status TEXT DEFAULT 'active',
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crm_time_entries (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES crm_clients(id),
      description TEXT NOT NULL,
      hours REAL NOT NULL,
      date TEXT NOT NULL,
      agent TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_crm_clients_status ON crm_clients(status);
    CREATE INDEX IF NOT EXISTS idx_crm_time_entries_client ON crm_time_entries(client_id);
    CREATE INDEX IF NOT EXISTS idx_crm_time_entries_date ON crm_time_entries(date);

    CREATE TABLE IF NOT EXISTS crm_client_projects (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES crm_clients(id),
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'active',
      started_at TEXT,
      due_at TEXT,
      budget_hours REAL,
      budget_nok REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crm_client_tasks (
      id TEXT PRIMARY KEY,
      client_id TEXT REFERENCES crm_clients(id),
      project_id TEXT REFERENCES crm_client_projects(id),
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'normal',
      due_at TEXT,
      completed_at TEXT,
      assigned_to TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crm_client_notes (
      id TEXT PRIMARY KEY,
      client_id TEXT REFERENCES crm_clients(id),
      project_id TEXT REFERENCES crm_client_projects(id),
      body TEXT NOT NULL,
      agent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crm_client_checklists (
      id TEXT PRIMARY KEY,
      client_id TEXT REFERENCES crm_clients(id),
      project_id TEXT REFERENCES crm_client_projects(id),
      title TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crm_client_checklist_items (
      id TEXT PRIMARY KEY,
      checklist_id TEXT NOT NULL REFERENCES crm_client_checklists(id),
      text TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      position INTEGER DEFAULT 0,
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
    DROP INDEX IF EXISTS idx_crm_contacts_email;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contacts_email ON crm_contacts(email);
    CREATE INDEX IF NOT EXISTS idx_crm_contacts_company ON crm_contacts(company_id);
    CREATE INDEX IF NOT EXISTS idx_crm_deals_stage ON crm_deals(stage);
    CREATE INDEX IF NOT EXISTS idx_crm_deals_contact ON crm_deals(contact_id);
    CREATE INDEX IF NOT EXISTS idx_crm_deals_company ON crm_deals(company_id);
    CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON crm_activities(contact_id);
    CREATE INDEX IF NOT EXISTS idx_crm_activities_deal ON crm_activities(deal_id);
    CREATE INDEX IF NOT EXISTS idx_crm_activities_type ON crm_activities(type);
    CREATE INDEX IF NOT EXISTS idx_crm_activities_due ON crm_activities(due_at);
    CREATE INDEX IF NOT EXISTS idx_crm_meetings_fathom ON crm_meetings(fathom_recording_id);
    CREATE INDEX IF NOT EXISTS idx_crm_webhook_source ON crm_webhook_log(source);
  `);

  safeAlter(db, 'ALTER TABLE crm_contacts ADD COLUMN match_confidence REAL DEFAULT 1.0');
  safeAlter(db, 'ALTER TABLE crm_contacts ADD COLUMN needs_review INTEGER DEFAULT 0');
  safeAlter(db, 'ALTER TABLE crm_meetings ADD COLUMN ai_parsed TEXT');
  safeAlter(db, 'ALTER TABLE crm_meetings ADD COLUMN email_draft TEXT');
  safeAlter(db, "ALTER TABLE crm_webhook_log ADD COLUMN status TEXT DEFAULT 'pending'");
  safeAlter(db, 'ALTER TABLE crm_webhook_log ADD COLUMN attempt_count INTEGER DEFAULT 0');
  safeAlter(db, 'ALTER TABLE crm_webhook_log ADD COLUMN next_retry_at TEXT');
  safeAlter(db, 'ALTER TABLE crm_webhook_log ADD COLUMN locked_at TEXT');
  safeAlter(db, 'ALTER TABLE crm_webhook_log ADD COLUMN last_error TEXT');
  safeAlter(db, 'ALTER TABLE crm_webhook_log ADD COLUMN processed_at TEXT');
  safeAlter(db, 'ALTER TABLE crm_time_entries ADD COLUMN project_id TEXT REFERENCES crm_client_projects(id)');
  safeAlter(db, 'ALTER TABLE crm_documents ADD COLUMN client_id TEXT REFERENCES crm_clients(id)');
  safeAlter(db, 'ALTER TABLE crm_documents ADD COLUMN project_id TEXT REFERENCES crm_client_projects(id)');
  safeAlter(db, 'CREATE INDEX IF NOT EXISTS idx_crm_documents_client ON crm_documents(client_id)');
  safeAlter(db, 'CREATE INDEX IF NOT EXISTS idx_crm_documents_project ON crm_documents(project_id)');
  safeAlter(db, 'CREATE INDEX IF NOT EXISTS idx_crm_time_entries_project ON crm_time_entries(project_id)');
  // Source-based test isolation (#5): a Cal.com webhook signed with
  // CALCOM_TEST_WEBHOOK_SECRET is stamped is_test=1 at ingestion. The queue
  // processor drops is_test=1 jobs to skipped_test before any CRM write or
  // sales notification, so no contact/deal/activity is ever created from test
  // traffic — the marker lives only on the audit row, nothing to filter
  // downstream.
  safeAlter(db, 'ALTER TABLE crm_webhook_log ADD COLUMN is_test INTEGER DEFAULT 0');
}
