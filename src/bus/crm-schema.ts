import type Database from 'better-sqlite3';

function safeAlter(db: Database.Database, sql: string): void {
  try { db.exec(sql); } catch { /* column already exists */ }
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
}
