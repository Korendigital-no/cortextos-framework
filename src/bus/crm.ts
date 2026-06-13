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
  /** Intentional-hold timestamp — deal is suppressed from the stale sweep until this passes. See dealHoldUntil(). */
  snoozed_until: string | null;
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

const VALID_STAGES = ['lead', 'contacted', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost'] as const;

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

  // Auto-manage closed_at from stage transitions, unless the caller set it
  // explicitly. A closing stage stamps it; any move to a non-closed stage (a
  // reopen) CLEARS it — otherwise closed_at lingers after a reopen and the
  // `closed_at IS NULL` guard in getStaleDeals (and the sibling-count subquery)
  // excludes the now-open deal from the stale sweep forever. Codex #95 P2.
  if (fields.stage !== undefined && fields.closed_at === undefined) {
    const closing = fields.stage === 'closed_won' || fields.stage === 'closed_lost';
    sets.push('closed_at = ?');
    params.push(closing ? now() : null);
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
      WHEN 'contacted' THEN 2
      WHEN 'qualified' THEN 3
      WHEN 'proposal' THEN 4
      WHEN 'negotiation' THEN 5
    END
  `).all() as PipelineStage[];
  return rows;
}

export interface StaleDeal extends CrmDeal {
  /** Most recent touch across activity created_at, activity completed_at, and the deal's own updated_at. */
  last_touch: string;
  /** Whole days between last_touch and now. */
  days_stale: number;
}

/** Quarter (1-4) → UTC ISO timestamp of that quarter's first day in `year`. Q1→Jan, Q2→Apr, Q3→Jul, Q4→Oct. */
function quarterStartIso(quarter: number, year: number): string {
  return new Date(Date.UTC(year, (quarter - 1) * 3, 1)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Parse a hold-date token to a UTC ISO timestamp, or null if unparseable.
 * Accepts ISO `YYYY-MM-DD` and Norwegian/EU `DD.MM.YYYY` / `DD/MM/YYYY`.
 * Rejects calendar overflow (e.g. 31.02.2026) by round-tripping the components.
 * Exported so the CLI can validate `--snooze-until` against the same parser.
 */
export function parseHoldDate(token: string): string | null {
  let y: number, mo: number, d: number;
  const isoM = token.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoM) {
    y = +isoM[1]; mo = +isoM[2]; d = +isoM[3];
  } else {
    const euM = token.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
    if (!euM) return null;
    d = +euM[1]; mo = +euM[2]; y = +euM[3];
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Intentional-hold detection for the stale-deal sweep.
 *
 * A deal can be deliberately parked ("send in Q3", "on hold until 2026-08-01")
 * without an open follow-up task. Surfacing such a deal as "neglected" is a
 * false-positive — sales flagged the Åreknute/NHG deal, titled "Q3 send", as
 * exactly this. This resolves an intentional-hold signal to the timestamp the
 * hold EXPIRES, so the deal is suppressed only until that moment and then
 * correctly resurfaces if still untouched. A hold must never blind the sweep
 * forever: a permanent false-negative (a genuinely neglected deal hidden) is
 * worse than a dismissable false-positive — the same doctrine the contact-join
 * guards in getStaleDeals follow.
 *
 * Signals (the latest future expiry across all wins):
 *   1. structured `snoozed_until` column — explicit machine-set snooze
 *   2. "hold/snooze/park until <date>" in title or notes (ISO or DD.MM.YYYY)
 *   3. quarter-send tag ("Q3 send" / "send in Q3") → start of that quarter THIS
 *      year. Before the quarter starts → held; once we are in or past it the
 *      send window is open, so the deal resurfaces (no suppression).
 *
 * Cross-year note (intentional): a bare quarter tag is year-ambiguous — "Q1
 * send" entered in December could mean "next year's Q1" OR "neglected since
 * last Q1". We never roll a past quarter forward to next year: that would hide
 * a possibly-neglected deal for up to a year (the false-negative the doctrine
 * forbids). For a precise cross-year park, use an explicit `snoozed_until` or a
 * "hold until <date>" note — both carry an unambiguous year.
 *
 * A future-dated follow-up TASK is a separate, already-handled park path
 * (the NOT EXISTS pending-follow-up guard in getStaleDeals).
 *
 * @returns the latest future hold-expiry ISO timestamp, or null if not on hold.
 */
export function dealHoldUntil(
  deal: { snoozed_until?: string | null; title?: string | null; notes?: string | null },
  nowMs: number = Date.now(),
): string | null {
  // Function-local regexes: matchAll does not mutate a regex's lastIndex (it
  // clones internally), but keeping them local removes any doubt and any risk a
  // future .exec/.test on a shared global would leak state across calls.
  // "hold until 2026-08-01", "snooze til 01.08.2026", "parkert til ...", "på vent til ..."
  const holdUntilRe = /\b(?:hold|holdt|snoozed?|park(?:ed|ert)?|på vent|vent)\s+(?:until|til)\s+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./]\d{1,2}[./]\d{4})/gi;
  // Q-first, the intentional park form: "Q3 send", "Q3-send", "Q3 SEND", "Q3 hold", "Q3 sende", "Q3 utsendelse"
  const quarterSendRe = /\bQ([1-4])[\s_-]*(?:send|sending|sende|utsend\w*|hold)\b/gi;
  // Reverse, send-verbs only (NOT bare "hold" — "hold Q3 review call" is a
  // meeting note, not a park signal; "Q3 hold" is covered above): "send Q3", "send in Q3", "send i Q3"
  const sendQuarterRe = /\b(?:send|sending|sende|utsend\w*)(?:\s+(?:in|i))?\s+Q([1-4])\b/gi;

  const candidates: string[] = [];

  if (deal.snoozed_until) candidates.push(deal.snoozed_until);

  const text = `${deal.title ?? ''}\n${deal.notes ?? ''}`;
  const nowYear = new Date(nowMs).getUTCFullYear();

  for (const m of text.matchAll(holdUntilRe)) {
    const iso = parseHoldDate(m[1]);
    if (iso) candidates.push(iso);
  }
  for (const re of [quarterSendRe, sendQuarterRe]) {
    for (const m of text.matchAll(re)) {
      candidates.push(quarterStartIso(+m[1], nowYear));
    }
  }

  // Hold only while a signal resolves to the FUTURE; keep the latest expiry.
  const future = candidates.filter((c) => {
    const t = Date.parse(c);
    return !Number.isNaN(t) && t > nowMs;
  });
  if (future.length === 0) return null;
  return future.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

/**
 * Open deals that have gone untouched for `days` (default 7) — the "neglected
 * pipeline" signal, distinct from overdue follow-ups (getFollowUps).
 *
 * Correctness this fixes (resolution-join bug): the naive sweep read only an
 * activity's created_at, so a deal whose follow-up was *resolved* (completed)
 * after a quiet stretch kept re-flagging as stale every run even though sales
 * had triaged it. Here last_touch is the greatest of:
 *   - MAX(activity.created_at)   — last logged interaction (deal- OR contact-linked)
 *   - MAX(activity.completed_at) — resolving a follow-up IS a touch
 *   - deal.updated_at            — stage/notes change is a touch
 * so a triaged/void cohort with closed follow-ups drops out instead of looping.
 *
 * Contact-linked join (Codex #95 follow-up): Cal.com bookings and Fathom
 * meetings write an activity carrying contact_id but no deal_id, so without the
 * contact_id = deal.contact_id branch a deal whose contact was just met would
 * be false-flagged stale despite a real touch. The IS NOT NULL guard keeps
 * contactless deals on the deal_id path only (NULL never matches NULL in SQL,
 * but the guard makes that explicit and avoids a full-table contactless scan).
 *
 * Excluded entirely:
 *   - closed deals (stage closed_won/closed_lost, or closed_at set)
 *   - deals with a *pending* follow-up (open task with a due date) — those are
 *     already tracked by the follow-up sweep, so they aren't "neglected".
 *     Parking a quiet lead is therefore as simple as giving it a future-dated
 *     follow-up.
 *   - deals on an *intentional hold* (dealHoldUntil) — an explicit snoozed_until,
 *     a "hold/snooze until <date>" note, or a quarter-send tag ("Q3 send"). The
 *     hold suppresses only until it expires, then the deal resurfaces if still
 *     untouched, so a deliberate park never permanently blinds the sweep.
 */
/**
 * Shared engine for getStaleDeals / getHeldDeals: open, non-closed, no-pending-
 * follow-up deals whose last_touch is older than the window. The intentional-
 * hold split is applied by the callers, so both see the identical candidate set.
 */
function staleCandidates(
  db: Database.Database,
  days: number,
): { nowMs: number; rows: Array<CrmDeal & { last_touch: string }> } {
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const rows = db.prepare(`
    SELECT d.*,
      (
        SELECT MAX(t) FROM (
          SELECT MAX(a.created_at)   AS t FROM crm_activities a WHERE a.deal_id = d.id
          UNION ALL
          SELECT MAX(a.completed_at) AS t FROM crm_activities a WHERE a.deal_id = d.id
          UNION ALL
          -- Contact-linked touches: Cal.com bookings + Fathom meetings write an
          -- activity with contact_id but NO deal_id (a.deal_id IS NULL), so a
          -- quiet deal whose contact was just met would otherwise re-flag stale.
          -- Two guards, both essential (Codex P2 ×2):
          --   * a.deal_id IS NULL — a deal-A-linked activity must NOT touch a
          --     sibling deal B sharing the contact.
          --   * sole-open-deal — a CONTACT-only touch is ambiguous when the
          --     contact has multiple open deals (which deal was the meeting
          --     about?). Attribute it only when it is the contact's ONLY open
          --     deal; otherwise fall back to deal_id-only, accepting a possible
          --     false-positive rather than hiding a genuinely neglected sibling
          --     (a false-negative defeats the whole stale-sweep).
          SELECT MAX(a.created_at)   AS t FROM crm_activities a
            WHERE d.contact_id IS NOT NULL AND a.contact_id = d.contact_id AND a.deal_id IS NULL
              AND (SELECT COUNT(*) FROM crm_deals sib
                   WHERE sib.contact_id = d.contact_id AND sib.stage NOT IN ('closed_won', 'closed_lost') AND sib.closed_at IS NULL) = 1
          UNION ALL
          SELECT MAX(a.completed_at) AS t FROM crm_activities a
            WHERE d.contact_id IS NOT NULL AND a.contact_id = d.contact_id AND a.deal_id IS NULL
              AND (SELECT COUNT(*) FROM crm_deals sib
                   WHERE sib.contact_id = d.contact_id AND sib.stage NOT IN ('closed_won', 'closed_lost') AND sib.closed_at IS NULL) = 1
          UNION ALL
          SELECT d.updated_at        AS t
        )
      ) AS last_touch
    FROM crm_deals d
    WHERE d.stage NOT IN ('closed_won', 'closed_lost')
      AND d.closed_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM crm_activities a
        WHERE a.deal_id = d.id
          AND a.type = 'task'
          AND a.due_at IS NOT NULL
          AND a.completed_at IS NULL
      )
    ORDER BY last_touch ASC
  `).all() as Array<CrmDeal & { last_touch: string | null }>;

  return {
    nowMs,
    rows: rows
      .map((r) => ({ ...r, last_touch: r.last_touch ?? r.updated_at }))
      .filter((r) => r.last_touch < cutoff),
  };
}

export function getStaleDeals(
  db: Database.Database,
  opts?: { days?: number },
): StaleDeal[] {
  const { nowMs, rows } = staleCandidates(db, opts?.days ?? 7);
  return rows
    // Intentional hold (Q3-send tag / snoozed_until / "hold until <date>"): a
    // deliberately parked deal is not "neglected". Suppressed only until the
    // hold expires — then it resurfaces if still quiet.
    .filter((r) => dealHoldUntil(r, nowMs) === null)
    .map((r) => ({
      ...r,
      days_stale: Math.floor((nowMs - Date.parse(r.last_touch)) / 86400000),
    }));
}

export interface HeldDeal extends StaleDeal {
  /** ISO timestamp the intentional hold expires — after this the deal re-enters the stale sweep. */
  held_until: string;
}

/**
 * The inverse of getStaleDeals: deals that WOULD be flagged stale but are on an
 * intentional hold (dealHoldUntil). Lets sales see what is deliberately parked
 * and when each item resurfaces, instead of the hold being a silent drop.
 */
export function getHeldDeals(
  db: Database.Database,
  opts?: { days?: number },
): HeldDeal[] {
  const { nowMs, rows } = staleCandidates(db, opts?.days ?? 7);
  return rows
    .map((r) => ({ r, held_until: dealHoldUntil(r, nowMs) }))
    .filter((x): x is { r: CrmDeal & { last_touch: string }; held_until: string } => x.held_until !== null)
    .map(({ r, held_until }) => ({
      ...r,
      held_until,
      days_stale: Math.floor((nowMs - Date.parse(r.last_touch)) / 86400000),
    }))
    .sort((a, b) => Date.parse(a.held_until) - Date.parse(b.held_until));
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

export function getActivity(db: Database.Database, id: string): CrmActivity | null {
  return (db.prepare('SELECT * FROM crm_activities WHERE id = ?').get(id) as CrmActivity | undefined) ?? null;
}

/**
 * True when an activity is a pending follow-up: a task with a due date that
 * has not yet been completed — the same predicate getFollowUps lists by. The
 * `crm-follow-ups resolve` command uses this so it only ever completes rows
 * that are actually follow-ups, never an unrelated note/email/booking.
 */
export function isPendingFollowUp(activity: CrmActivity): boolean {
  return activity.type === 'task' && activity.due_at != null && activity.completed_at == null;
}

/**
 * Mark an activity complete by stamping completed_at. Task-type activities
 * (follow-ups) drop out of getFollowUps once completed. Returns the updated
 * row, or null if no activity has that id (caller decides how to report).
 */
export function completeActivity(db: Database.Database, id: string): CrmActivity | null {
  const existing = db.prepare('SELECT * FROM crm_activities WHERE id = ?').get(id) as CrmActivity | undefined;
  if (!existing) return null;
  db.prepare('UPDATE crm_activities SET completed_at = ? WHERE id = ?').run(now(), id);
  return db.prepare('SELECT * FROM crm_activities WHERE id = ?').get(id) as CrmActivity;
}

/**
 * Permanently delete an activity. Returns true if a row was removed, false if
 * the id did not exist (idempotent — deleting an absent row is not an error).
 */
export function deleteActivity(db: Database.Database, id: string): boolean {
  const res = db.prepare('DELETE FROM crm_activities WHERE id = ?').run(id);
  return res.changes > 0;
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

// --- Documents ---

export interface CrmDocument {
  id: string;
  contact_id: string | null;
  deal_id: string | null;
  filename: string;
  filepath: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  created_at: string;
}

export function addDocument(
  db: Database.Database,
  opts: { filename: string; filepath: string; contact_id?: string; deal_id?: string; mime_type?: string; size_bytes?: number; uploaded_by?: string },
): CrmDocument {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO crm_documents (id, contact_id, deal_id, filename, filepath, mime_type, size_bytes, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, opts.contact_id ?? null, opts.deal_id ?? null, opts.filename, opts.filepath, opts.mime_type ?? null, opts.size_bytes ?? null, opts.uploaded_by ?? null, now());
  return db.prepare('SELECT * FROM crm_documents WHERE id = ?').get(id) as CrmDocument;
}

export function listDocuments(
  db: Database.Database,
  filters?: { contact?: string; deal?: string },
): CrmDocument[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters?.contact) { conditions.push('contact_id = ?'); params.push(filters.contact); }
  if (filters?.deal) { conditions.push('deal_id = ?'); params.push(filters.deal); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM crm_documents ${where} ORDER BY created_at DESC`).all(...params) as CrmDocument[];
}

export function deleteDocument(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM crm_documents WHERE id = ?').run(id);
}

// --- Delete ---

export function deleteContact(db: Database.Database, id: string): void {
  const contact = db.prepare('SELECT id FROM crm_contacts WHERE id = ?').get(id);
  if (!contact) throw new Error(`Contact ${id} not found`);
  const txn = db.transaction(() => {
    db.prepare('UPDATE crm_activities SET contact_id = NULL WHERE contact_id = ? AND deal_id IS NOT NULL').run(id);
    db.prepare('DELETE FROM crm_activities WHERE contact_id = ? AND deal_id IS NULL').run(id);
    db.prepare('UPDATE crm_deals SET contact_id = NULL WHERE contact_id = ?').run(id);
    db.prepare('DELETE FROM crm_contacts WHERE id = ?').run(id);
  });
  txn();
}

export function deleteCompany(db: Database.Database, id: string): void {
  const company = db.prepare('SELECT id FROM crm_companies WHERE id = ?').get(id);
  if (!company) throw new Error(`Company ${id} not found`);
  const txn = db.transaction(() => {
    db.prepare('UPDATE crm_contacts SET company_id = NULL WHERE company_id = ?').run(id);
    db.prepare('UPDATE crm_deals SET company_id = NULL WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM crm_companies WHERE id = ?').run(id);
  });
  txn();
}

export function deleteDeal(db: Database.Database, id: string): void {
  const deal = db.prepare('SELECT id FROM crm_deals WHERE id = ?').get(id);
  if (!deal) throw new Error(`Deal ${id} not found`);
  const txn = db.transaction(() => {
    db.prepare('UPDATE crm_activities SET deal_id = NULL WHERE deal_id = ?').run(id);
    db.prepare('DELETE FROM crm_deals WHERE id = ?').run(id);
  });
  txn();
}

// --- Review Queue ---

export interface CrmReviewItem {
  id: string;
  type: string;
  entity_id: string;
  context: string | null;
  status: string;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

export function listReviewQueue(
  db: Database.Database,
  filters?: { status?: string },
): CrmReviewItem[] {
  const status = filters?.status ?? 'pending';
  return db.prepare('SELECT * FROM crm_review_queue WHERE status = ? ORDER BY created_at DESC').all(status) as CrmReviewItem[];
}

export function resolveReviewItem(
  db: Database.Database,
  id: string,
  action: 'merge' | 'create' | 'dismiss',
  resolvedBy: string,
): void {
  const item = db.prepare('SELECT * FROM crm_review_queue WHERE id = ?').get(id) as CrmReviewItem | null;
  if (!item) throw new Error(`Review item ${id} not found`);

  if (item.status !== 'pending') throw new Error(`Review item ${id} is already ${item.status}`);

  if (action === 'dismiss') {
    db.prepare("UPDATE crm_review_queue SET status = 'dismissed', resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(resolvedBy, now(), id);
    return;
  }

  if (action === 'create' && item.type === 'contact_match') {
    let context: Record<string, unknown> = {};
    try { context = item.context ? JSON.parse(item.context) : {}; } catch { /* skip */ }
    const attendees = context.attendees as Array<{ name?: string; email?: string }> | undefined;
    if (Array.isArray(attendees)) {
      for (const att of attendees) {
        if (!att.email || typeof att.email !== 'string') continue;
        const ts = now();
        db.prepare(`
          INSERT INTO crm_contacts (id, name, email, source, match_confidence, needs_review, created_at, updated_at)
          VALUES (?, ?, ?, 'review_queue', 0.5, 0, ?, ?)
          ON CONFLICT(email) DO NOTHING
        `).run(randomUUID(), att.name ?? att.email.split('@')[0], att.email, ts, ts);
      }
    }
  }

  db.prepare("UPDATE crm_review_queue SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(resolvedBy, now(), id);
}
