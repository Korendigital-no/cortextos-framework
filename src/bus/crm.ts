import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// --- Types ---

export interface CrmContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company_id: string | null;
  source: string | null;
  source_ref: string | null;
  notes: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrmCompany {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  org_number: string | null;
  size: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrmDeal {
  id: string;
  title: string;
  value_nok: number | null;
  stage: string;
  contact_id: string | null;
  company_id: string | null;
  expected_close: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface CrmActivity {
  id: string;
  type: string;
  subject: string | null;
  body: string | null;
  contact_id: string | null;
  deal_id: string | null;
  meeting_id: string | null;
  agent: string | null;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface CrmMeeting {
  id: string;
  fathom_recording_id: string | null;
  title: string | null;
  summary: string | null;
  transcript: string | null;
  action_items: string | null;
  attendees: string | null;
  recording_url: string | null;
  share_url: string | null;
  meeting_start: string | null;
  meeting_end: string | null;
  follow_up_drafted: number;
  created_at: string;
}

export interface PipelineStage {
  stage: string;
  count: number;
  total_value: number;
}

const VALID_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost'] as const;

function validateStage(stage: string): void {
  if (!VALID_STAGES.includes(stage as typeof VALID_STAGES[number])) {
    throw new Error(`Invalid stage '${stage}'. Must be one of: ${VALID_STAGES.join(', ')}`);
  }
}

// --- Contacts ---

export function createContact(
  db: Database.Database,
  opts: { name: string; email?: string; phone?: string; company_id?: string; source?: string; source_ref?: string; notes?: string; tags?: string },
): CrmContact {
  const id = randomUUID();
  const ts = now();
  db.prepare(`
    INSERT INTO crm_contacts (id, name, email, phone, company_id, source, source_ref, notes, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, opts.name, opts.email ?? null, opts.phone ?? null, opts.company_id ?? null, opts.source ?? null, opts.source_ref ?? null, opts.notes ?? null, opts.tags ?? null, ts, ts);
  return getContact(db, id)!;
}

export function getContact(db: Database.Database, id: string): CrmContact | null {
  return db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(id) as CrmContact | null;
}

export function listContacts(
  db: Database.Database,
  filters?: { search?: string; company?: string; source?: string },
): CrmContact[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.search) {
    conditions.push("(name LIKE ? OR email LIKE ?)");
    const term = `%${filters.search}%`;
    params.push(term, term);
  }
  if (filters?.company) {
    conditions.push("company_id = ?");
    params.push(filters.company);
  }
  if (filters?.source) {
    conditions.push("source = ?");
    params.push(filters.source);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM crm_contacts ${where} ORDER BY created_at DESC`).all(...params) as CrmContact[];
}

export function updateContact(
  db: Database.Database,
  id: string,
  fields: Partial<Omit<CrmContact, 'id' | 'created_at' | 'updated_at'>>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      params.push(value);
    }
  }
  if (sets.length === 0) return;

  sets.push('updated_at = ?');
  params.push(now());
  params.push(id);

  db.prepare(`UPDATE crm_contacts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function upsertContactByEmail(
  db: Database.Database,
  opts: { name: string; email: string; phone?: string; company_id?: string; source?: string; source_ref?: string; notes?: string },
): CrmContact {
  const id = randomUUID();
  const ts = now();
  const result = db.prepare(`
    INSERT INTO crm_contacts (id, name, email, phone, company_id, source, source_ref, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name = excluded.name,
      phone = COALESCE(excluded.phone, crm_contacts.phone),
      company_id = COALESCE(excluded.company_id, crm_contacts.company_id),
      source = COALESCE(excluded.source, crm_contacts.source),
      source_ref = COALESCE(excluded.source_ref, crm_contacts.source_ref),
      updated_at = excluded.updated_at
    RETURNING *
  `).get(id, opts.name, opts.email, opts.phone ?? null, opts.company_id ?? null, opts.source ?? null, opts.source_ref ?? null, opts.notes ?? null, ts, ts) as CrmContact;
  return result;
}

// --- Companies ---

export function createCompany(
  db: Database.Database,
  opts: { name: string; domain?: string; industry?: string; org_number?: string; size?: string; notes?: string },
): CrmCompany {
  const id = randomUUID();
  const ts = now();
  db.prepare(`
    INSERT INTO crm_companies (id, name, domain, industry, org_number, size, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, opts.name, opts.domain ?? null, opts.industry ?? null, opts.org_number ?? null, opts.size ?? null, opts.notes ?? null, ts, ts);
  return getCompany(db, id)!;
}

export function getCompany(db: Database.Database, id: string): CrmCompany | null {
  return db.prepare('SELECT * FROM crm_companies WHERE id = ?').get(id) as CrmCompany | null;
}

export function listCompanies(
  db: Database.Database,
  filters?: { search?: string },
): CrmCompany[] {
  if (filters?.search) {
    const term = `%${filters.search}%`;
    return db.prepare('SELECT * FROM crm_companies WHERE name LIKE ? OR domain LIKE ? ORDER BY created_at DESC').all(term, term) as CrmCompany[];
  }
  return db.prepare('SELECT * FROM crm_companies ORDER BY created_at DESC').all() as CrmCompany[];
}

export function updateCompany(
  db: Database.Database,
  id: string,
  fields: Partial<Omit<CrmCompany, 'id' | 'created_at' | 'updated_at'>>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      params.push(value);
    }
  }
  if (sets.length === 0) return;

  sets.push('updated_at = ?');
  params.push(now());
  params.push(id);

  db.prepare(`UPDATE crm_companies SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

// --- Deals ---

export function createDeal(
  db: Database.Database,
  opts: { title: string; value_nok?: number; stage?: string; contact_id?: string; company_id?: string; expected_close?: string; notes?: string },
): CrmDeal {
  const stage = opts.stage ?? 'lead';
  validateStage(stage);
  const id = randomUUID();
  const ts = now();
  db.prepare(`
    INSERT INTO crm_deals (id, title, value_nok, stage, contact_id, company_id, expected_close, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, opts.title, opts.value_nok ?? null, stage, opts.contact_id ?? null, opts.company_id ?? null, opts.expected_close ?? null, opts.notes ?? null, ts, ts);
  return getDeal(db, id)!;
}

export function getDeal(db: Database.Database, id: string): CrmDeal | null {
  return db.prepare('SELECT * FROM crm_deals WHERE id = ?').get(id) as CrmDeal | null;
}

export function listDeals(
  db: Database.Database,
  filters?: { stage?: string; contact?: string; company?: string },
): CrmDeal[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.stage) {
    validateStage(filters.stage);
    conditions.push("stage = ?");
    params.push(filters.stage);
  }
  if (filters?.contact) {
    conditions.push("contact_id = ?");
    params.push(filters.contact);
  }
  if (filters?.company) {
    conditions.push("company_id = ?");
    params.push(filters.company);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM crm_deals ${where} ORDER BY created_at DESC`).all(...params) as CrmDeal[];
}

export function updateDeal(
  db: Database.Database,
  id: string,
  fields: Partial<Omit<CrmDeal, 'id' | 'created_at' | 'updated_at'>>,
): void {
  if (fields.stage) validateStage(fields.stage);

  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      params.push(value);
    }
  }
  if (sets.length === 0) return;

  if (fields.stage === 'closed_won' || fields.stage === 'closed_lost') {
    sets.push('closed_at = ?');
    params.push(now());
  }

  sets.push('updated_at = ?');
  params.push(now());
  params.push(id);

  db.prepare(`UPDATE crm_deals SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function getPipeline(db: Database.Database): PipelineStage[] {
  const rows = db.prepare(`
    SELECT stage, COUNT(*) as count, COALESCE(SUM(value_nok), 0) as total_value
    FROM crm_deals
    WHERE stage NOT IN ('closed_won', 'closed_lost')
    GROUP BY stage
    ORDER BY CASE stage
      WHEN 'lead' THEN 1
      WHEN 'qualified' THEN 2
      WHEN 'proposal' THEN 3
      WHEN 'negotiation' THEN 4
    END
  `).all() as PipelineStage[];
  return rows;
}

// --- Activities ---

export function createActivity(
  db: Database.Database,
  opts: { type: string; subject?: string; body?: string; contact_id?: string; deal_id?: string; meeting_id?: string; agent?: string; due_at?: string },
): CrmActivity {
  const id = randomUUID();
  const ts = now();
  db.prepare(`
    INSERT INTO crm_activities (id, type, subject, body, contact_id, deal_id, meeting_id, agent, due_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, opts.type, opts.subject ?? null, opts.body ?? null, opts.contact_id ?? null, opts.deal_id ?? null, opts.meeting_id ?? null, opts.agent ?? null, opts.due_at ?? null, ts);
  return db.prepare('SELECT * FROM crm_activities WHERE id = ?').get(id) as CrmActivity;
}

export function listActivities(
  db: Database.Database,
  filters?: { contact?: string; deal?: string; type?: string },
): CrmActivity[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.contact) {
    conditions.push("contact_id = ?");
    params.push(filters.contact);
  }
  if (filters?.deal) {
    conditions.push("deal_id = ?");
    params.push(filters.deal);
  }
  if (filters?.type) {
    conditions.push("type = ?");
    params.push(filters.type);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM crm_activities ${where} ORDER BY created_at DESC`).all(...params) as CrmActivity[];
}

export function getFollowUps(
  db: Database.Database,
  filter?: { due?: 'today' | 'overdue' | 'week' },
): CrmActivity[] {
  let dateCondition = '';
  const today = new Date().toISOString().split('T')[0];

  if (filter?.due === 'today') {
    dateCondition = `AND due_at LIKE '${today}%'`;
  } else if (filter?.due === 'overdue') {
    dateCondition = `AND due_at < '${today}'`;
  } else if (filter?.due === 'week') {
    const weekFromNow = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
    dateCondition = `AND due_at <= '${weekFromNow}'`;
  }

  return db.prepare(`
    SELECT * FROM crm_activities
    WHERE type = 'task' AND due_at IS NOT NULL AND completed_at IS NULL ${dateCondition}
    ORDER BY due_at ASC
  `).all() as CrmActivity[];
}

// --- Meetings ---

export function createMeeting(
  db: Database.Database,
  opts: { fathom_recording_id?: string; title?: string; summary?: string; transcript?: string; action_items?: string; attendees?: string; recording_url?: string; share_url?: string; meeting_start?: string; meeting_end?: string },
): CrmMeeting {
  const id = randomUUID();
  const ts = now();
  db.prepare(`
    INSERT INTO crm_meetings (id, fathom_recording_id, title, summary, transcript, action_items, attendees, recording_url, share_url, meeting_start, meeting_end, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, opts.fathom_recording_id ?? null, opts.title ?? null, opts.summary ?? null, opts.transcript ?? null, opts.action_items ?? null, opts.attendees ?? null, opts.recording_url ?? null, opts.share_url ?? null, opts.meeting_start ?? null, opts.meeting_end ?? null, ts);
  return getMeeting(db, id)!;
}

export function getMeeting(db: Database.Database, id: string): CrmMeeting | null {
  return db.prepare('SELECT * FROM crm_meetings WHERE id = ?').get(id) as CrmMeeting | null;
}

export function listMeetings(
  db: Database.Database,
  filters?: { contact?: string },
): CrmMeeting[] {
  if (filters?.contact) {
    return db.prepare(`
      SELECT m.* FROM crm_meetings m
      JOIN crm_activities a ON a.meeting_id = m.id
      WHERE a.contact_id = ?
      ORDER BY m.created_at DESC
    `).all(filters.contact) as CrmMeeting[];
  }
  return db.prepare('SELECT * FROM crm_meetings ORDER BY created_at DESC').all() as CrmMeeting[];
}

// --- Webhook Log ---

export function logWebhook(
  db: Database.Database,
  source: string,
  eventType: string,
  payload: string,
): number {
  const result = db.prepare(`
    INSERT INTO crm_webhook_log (source, event_type, payload, received_at)
    VALUES (?, ?, ?, ?)
  `).run(source, eventType, payload, now());
  return Number(result.lastInsertRowid);
}
