import type Database from 'better-sqlite3';

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
      processed INTEGER DEFAULT 0,
      error TEXT,
      received_at TEXT NOT NULL
    );

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
}
