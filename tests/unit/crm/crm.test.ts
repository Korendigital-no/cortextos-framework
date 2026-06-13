import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initializeCrmSchema } from '../../../src/bus/crm-schema.js';
import {
  createContact, getContact, listContacts, updateContact, upsertContactByEmail,
  createCompany, getCompany, listCompanies, updateCompany,
  createDeal, getDeal, listDeals, updateDeal, getPipeline, getStaleDeals,
  getHeldDeals, dealHoldUntil, parseHoldDate,
  createActivity, listActivities, getFollowUps, completeActivity, deleteActivity,
  getActivity, isPendingFollowUp,
  createMeeting, getMeeting, listMeetings,
  logWebhook,
} from '../../../src/bus/crm.js';

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'crm-test-'));
  db = new Database(join(tmpDir, 'test.db'));
  db.pragma('foreign_keys = ON');
  initializeCrmSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Contacts', () => {
  it('creates and retrieves a contact', () => {
    const contact = createContact(db, { name: 'Ola Nordmann', email: 'ola@example.no' });
    expect(contact.name).toBe('Ola Nordmann');
    expect(contact.email).toBe('ola@example.no');
    expect(contact.id).toBeTruthy();

    const found = getContact(db, contact.id);
    expect(found).toBeTruthy();
    expect(found!.name).toBe('Ola Nordmann');
  });

  it('lists contacts with search filter', () => {
    createContact(db, { name: 'Alice', email: 'alice@example.com' });
    createContact(db, { name: 'Bob', email: 'bob@example.com' });

    expect(listContacts(db).length).toBe(2);
    expect(listContacts(db, { search: 'alice' }).length).toBe(1);
    expect(listContacts(db, { search: 'alice' })[0].name).toBe('Alice');
    expect(listContacts(db, { search: 'example.com' }).length).toBe(2);
  });

  it('filters contacts by source', () => {
    createContact(db, { name: 'A', source: 'manual' });
    createContact(db, { name: 'B', source: 'cal_booking' });

    expect(listContacts(db, { source: 'manual' }).length).toBe(1);
  });

  it('updates a contact', () => {
    const contact = createContact(db, { name: 'Old', email: 'old@test.com' });
    updateContact(db, contact.id, { name: 'New', phone: '+4712345678' });
    const updated = getContact(db, contact.id)!;
    expect(updated.name).toBe('New');
    expect(updated.phone).toBe('+4712345678');
    expect(updated.email).toBe('old@test.com');
  });

  it('upserts by email - updates existing', () => {
    createContact(db, { name: 'Original', email: 'dup@test.com', source: 'manual' });
    const upserted = upsertContactByEmail(db, { name: 'Updated', email: 'dup@test.com', source: 'cal_booking' });
    expect(upserted.name).toBe('Updated');
    expect(listContacts(db).length).toBe(1);
  });

  it('upserts by email - creates new', () => {
    const contact = upsertContactByEmail(db, { name: 'New', email: 'new@test.com' });
    expect(contact.name).toBe('New');
    expect(listContacts(db).length).toBe(1);
  });
});

describe('Companies', () => {
  it('creates and retrieves a company', () => {
    const company = createCompany(db, { name: 'Acme AS', org_number: '123456789' });
    expect(company.name).toBe('Acme AS');
    expect(company.org_number).toBe('123456789');

    const found = getCompany(db, company.id);
    expect(found!.name).toBe('Acme AS');
  });

  it('lists companies with search', () => {
    createCompany(db, { name: 'Acme AS', domain: 'acme.no' });
    createCompany(db, { name: 'Globex Corp', domain: 'globex.com' });

    expect(listCompanies(db).length).toBe(2);
    expect(listCompanies(db, { search: 'acme' }).length).toBe(1);
    expect(listCompanies(db, { search: 'globex.com' }).length).toBe(1);
  });

  it('updates a company', () => {
    const company = createCompany(db, { name: 'Old Name' });
    updateCompany(db, company.id, { name: 'New Name', industry: 'Tech' });
    const updated = getCompany(db, company.id)!;
    expect(updated.name).toBe('New Name');
    expect(updated.industry).toBe('Tech');
  });

  it('links contacts to companies', () => {
    const company = createCompany(db, { name: 'TestCo' });
    const contact = createContact(db, { name: 'Employee', company_id: company.id });
    expect(contact.company_id).toBe(company.id);

    const companyContacts = listContacts(db, { company: company.id });
    expect(companyContacts.length).toBe(1);
    expect(companyContacts[0].name).toBe('Employee');
  });
});

describe('Deals', () => {
  it('creates a deal with default stage', () => {
    const deal = createDeal(db, { title: 'Test Deal' });
    expect(deal.stage).toBe('lead');
    expect(deal.title).toBe('Test Deal');
  });

  it('creates a deal with value and stage', () => {
    const deal = createDeal(db, { title: 'Big Deal', value_nok: 100000, stage: 'proposal' });
    expect(deal.value_nok).toBe(100000);
    expect(deal.stage).toBe('proposal');
  });

  it('rejects invalid stage', () => {
    expect(() => createDeal(db, { title: 'Bad', stage: 'invalid' })).toThrow('Invalid stage');
  });

  it('lists deals filtered by stage', () => {
    createDeal(db, { title: 'A', stage: 'lead' });
    createDeal(db, { title: 'B', stage: 'proposal' });
    createDeal(db, { title: 'C', stage: 'lead' });

    expect(listDeals(db, { stage: 'lead' }).length).toBe(2);
    expect(listDeals(db, { stage: 'proposal' }).length).toBe(1);
  });

  it('updates deal stage and sets closed_at for closing stages', () => {
    const deal = createDeal(db, { title: 'Won Deal', value_nok: 50000 });
    updateDeal(db, deal.id, { stage: 'closed_won' });
    const updated = getDeal(db, deal.id)!;
    expect(updated.stage).toBe('closed_won');
    expect(updated.closed_at).toBeTruthy();
  });

  it('clears closed_at when a deal is reopened to a non-closed stage (Codex #95 P2)', () => {
    const deal = createDeal(db, { title: 'Reopened Deal', stage: 'qualified' });
    updateDeal(db, deal.id, { stage: 'closed_lost' });
    expect(getDeal(db, deal.id)!.closed_at).toBeTruthy();
    updateDeal(db, deal.id, { stage: 'qualified' }); // reopen
    expect(getDeal(db, deal.id)!.closed_at).toBeNull();
  });

  it('respects an explicit closed_at on update — does not auto-clobber when caller sets it', () => {
    const deal = createDeal(db, { title: 'Explicit close', stage: 'qualified' });
    updateDeal(db, deal.id, { stage: 'contacted', closed_at: '2026-01-01T00:00:00Z' });
    expect(getDeal(db, deal.id)!.closed_at).toBe('2026-01-01T00:00:00Z');
  });

  it('returns pipeline aggregation', () => {
    createDeal(db, { title: 'A', value_nok: 10000, stage: 'lead' });
    createDeal(db, { title: 'B', value_nok: 20000, stage: 'lead' });
    createDeal(db, { title: 'C', value_nok: 50000, stage: 'proposal' });
    createDeal(db, { title: 'D', value_nok: 100000, stage: 'closed_won' });

    const pipeline = getPipeline(db);
    expect(pipeline.length).toBe(2);

    const leadStage = pipeline.find(p => p.stage === 'lead');
    expect(leadStage!.count).toBe(2);
    expect(leadStage!.total_value).toBe(30000);

    const proposalStage = pipeline.find(p => p.stage === 'proposal');
    expect(proposalStage!.count).toBe(1);
    expect(proposalStage!.total_value).toBe(50000);
  });

  it('pipeline excludes BOTH closed stages — parity with the dashboard pipeline route (task_1780606343485)', () => {
    // The CLI previously filtered only closed_won, so a lost deal inflated
    // active count/value while dashboard/src/app/api/crm/pipeline/route.ts
    // excludes both closed_won AND closed_lost — the two surfaces disagreed
    // for any pipeline containing lost deals. Codex bycatch, PR #64 R1.
    createDeal(db, { title: 'active', value_nok: 10000, stage: 'lead' });
    createDeal(db, { title: 'won', value_nok: 100000, stage: 'closed_won' });
    createDeal(db, { title: 'lost', value_nok: 999999, stage: 'closed_lost' });

    const pipeline = getPipeline(db);
    expect(pipeline.map(p => p.stage)).toEqual(['lead']);
    expect(pipeline.find(p => p.stage === 'closed_lost')).toBeUndefined();
    // Total active value must not include the lost deal's 999999.
    expect(pipeline.reduce((s, p) => s + p.total_value, 0)).toBe(10000);
  });
});

describe('getStaleDeals (resolution-join staleness)', () => {
  const iso = (msAgo: number) =>
    new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const daysAgo = (n: number) => iso(n * 86400000);

  // createDeal stamps updated_at = now(), so a deal is never stale until we
  // backdate it. This mirrors a deal that genuinely went quiet.
  function backdateDeal(id: string, isoTs: string) {
    db.prepare('UPDATE crm_deals SET created_at = ?, updated_at = ? WHERE id = ?').run(isoTs, isoTs, id);
  }
  function insertActivity(opts: {
    deal_id: string; type?: string; created_at: string; completed_at?: string | null; due_at?: string | null;
  }) {
    db.prepare(
      `INSERT INTO crm_activities (id, type, deal_id, due_at, completed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), opts.type ?? 'email', opts.deal_id, opts.due_at ?? null, opts.completed_at ?? null, opts.created_at);
  }

  it('flags an open deal whose last activity is older than the window', () => {
    const deal = createDeal(db, { title: 'Quiet Lead', stage: 'contacted' });
    backdateDeal(deal.id, daysAgo(10));
    insertActivity({ deal_id: deal.id, created_at: daysAgo(10) });

    const stale = getStaleDeals(db);
    expect(stale.map(d => d.id)).toContain(deal.id);
    expect(stale.find(d => d.id === deal.id)!.days_stale).toBeGreaterThanOrEqual(7);
  });

  it('does NOT re-flag a deal whose follow-up was resolved recently (the bug)', () => {
    // Created 10d ago, follow-up logged 10d ago BUT completed 1d ago. The naive
    // sweep read created_at only and re-flagged it every run; completing a
    // follow-up is a touch, so last_touch is 1d and it must drop out.
    const deal = createDeal(db, { title: 'Triaged/Void', stage: 'contacted' });
    backdateDeal(deal.id, daysAgo(10));
    insertActivity({
      deal_id: deal.id, type: 'task',
      created_at: daysAgo(10), due_at: daysAgo(9), completed_at: daysAgo(1),
    });

    expect(getStaleDeals(db).map(d => d.id)).not.toContain(deal.id);
  });

  it('counts contact-linked activities — a quiet deal whose contact was just met is not false-flagged (Codex #95 follow-up)', () => {
    // Cal.com bookings + Fathom meetings write an activity with contact_id but
    // NO deal_id. A deal whose deal-linked activity is old but whose CONTACT
    // was met 1d ago must NOT re-flag stale.
    const contact = createContact(db, { name: 'Met Recently', email: 'met@test.com' });
    const deal = createDeal(db, { title: 'Quiet but contact met', stage: 'contacted', contact_id: contact.id });
    backdateDeal(deal.id, daysAgo(10));
    insertActivity({ deal_id: deal.id, created_at: daysAgo(10) }); // old deal-linked touch
    createActivity(db, { type: 'meeting', subject: 'Cal booking', contact_id: contact.id }); // recent, no deal_id

    expect(getStaleDeals(db).map(d => d.id)).not.toContain(deal.id);
  });

  it('contactless deal stays on the deal_id path — an unrelated contact activity does not rescue it (IS NOT NULL guard)', () => {
    const other = createContact(db, { name: 'Unrelated', email: 'unrelated@test.com' });
    const deal = createDeal(db, { title: 'Contactless quiet', stage: 'contacted' }); // contact_id NULL
    backdateDeal(deal.id, daysAgo(10));
    insertActivity({ deal_id: deal.id, created_at: daysAgo(10) });
    createActivity(db, { type: 'meeting', subject: 'someone else', contact_id: other.id }); // recent, unrelated

    expect(getStaleDeals(db).map(d => d.id)).toContain(deal.id);
  });

  it('a sibling deal sharing the contact is NOT rescued by an activity linked to another deal (Codex P2)', () => {
    // Contact has deal A (recent activity linked to A) and deal B (quiet). B
    // must still flag stale — A's deal-linked activity is not a touch for B,
    // because the contact branch only counts activities with deal_id IS NULL.
    const contact = createContact(db, { name: 'Two Deals', email: 'two@test.com' });
    const dealA = createDeal(db, { title: 'Active A', stage: 'contacted', contact_id: contact.id });
    const dealB = createDeal(db, { title: 'Quiet B', stage: 'contacted', contact_id: contact.id });
    backdateDeal(dealA.id, daysAgo(10));
    backdateDeal(dealB.id, daysAgo(10));
    insertActivity({ deal_id: dealA.id, created_at: daysAgo(1) });  // recent, linked to A only
    insertActivity({ deal_id: dealB.id, created_at: daysAgo(10) }); // B's own touch is old

    const ids = getStaleDeals(db).map(d => d.id);
    expect(ids).not.toContain(dealA.id); // A is fresh
    expect(ids).toContain(dealB.id);     // B still stale — A's activity must not rescue it
  });

  it('contact-only touch is ambiguous with multiple open deals — falls back to deal_id-only (Codex P2 round 2)', () => {
    // Contact has TWO open deals. A Cal/Fathom meeting logged contact-only (no
    // deal_id) cannot be attributed to one deal, so neither is rescued — a
    // genuinely neglected sibling must still surface (a false-negative that
    // hides a stale deal is worse than a false-positive sales can dismiss).
    const contact = createContact(db, { name: 'Ambiguous', email: 'amb@test.com' });
    const dealA = createDeal(db, { title: 'Open A', stage: 'contacted', contact_id: contact.id });
    const dealB = createDeal(db, { title: 'Open B', stage: 'contacted', contact_id: contact.id });
    backdateDeal(dealA.id, daysAgo(10));
    backdateDeal(dealB.id, daysAgo(10));
    insertActivity({ deal_id: dealA.id, created_at: daysAgo(10) });
    insertActivity({ deal_id: dealB.id, created_at: daysAgo(10) });
    createActivity(db, { type: 'meeting', subject: 'contact-only', contact_id: contact.id }); // recent, no deal_id

    const ids = getStaleDeals(db).map(d => d.id);
    expect(ids).toContain(dealA.id); // ambiguous touch does not rescue either
    expect(ids).toContain(dealB.id);
  });

  it('excludes deals that already have a pending follow-up (tracked elsewhere)', () => {
    const deal = createDeal(db, { title: 'Has Open Follow-up', stage: 'contacted' });
    backdateDeal(deal.id, daysAgo(20));
    insertActivity({
      deal_id: deal.id, type: 'task',
      created_at: daysAgo(20), due_at: daysAgo(2), completed_at: null,
    });

    expect(getStaleDeals(db).map(d => d.id)).not.toContain(deal.id);
  });

  it('excludes closed_won and closed_lost deals regardless of age', () => {
    const won = createDeal(db, { title: 'Won', stage: 'contacted' });
    const lost = createDeal(db, { title: 'Lost', stage: 'contacted' });
    backdateDeal(won.id, daysAgo(30));
    backdateDeal(lost.id, daysAgo(30));
    updateDeal(db, won.id, { stage: 'closed_won' });
    updateDeal(db, lost.id, { stage: 'closed_lost' });
    // updateDeal refreshes updated_at; re-backdate to prove it's the stage, not age, that excludes.
    backdateDeal(won.id, daysAgo(30));
    backdateDeal(lost.id, daysAgo(30));

    const ids = getStaleDeals(db).map(d => d.id);
    expect(ids).not.toContain(won.id);
    expect(ids).not.toContain(lost.id);
  });

  it('a reopened deal can become stale again — closed_at is cleared on reopen (Codex #95 P2)', () => {
    // A deal closed then reopened (stage moved back to an open stage) must
    // re-enter the stale sweep. Before the fix, closed_at lingered after the
    // close, so the `closed_at IS NULL` guard excluded the deal permanently even
    // though it is open and has gone quiet.
    const deal = createDeal(db, { title: 'Reopened & quiet', stage: 'contacted' });
    updateDeal(db, deal.id, { stage: 'closed_lost' }); // closed (stamps closed_at)
    updateDeal(db, deal.id, { stage: 'contacted' });   // reopened (must clear closed_at)
    backdateDeal(deal.id, daysAgo(10));                // went quiet after reopen
    insertActivity({ deal_id: deal.id, created_at: daysAgo(10) });

    expect(getStaleDeals(db).map(d => d.id)).toContain(deal.id);
  });

  it('treats a recent activity as a touch (not stale)', () => {
    const deal = createDeal(db, { title: 'Recently Touched', stage: 'contacted' });
    backdateDeal(deal.id, daysAgo(30));
    insertActivity({ deal_id: deal.id, created_at: daysAgo(1) });

    expect(getStaleDeals(db).map(d => d.id)).not.toContain(deal.id);
  });

  it('treats a recent stage change (updated_at) as a touch', () => {
    const deal = createDeal(db, { title: 'Just Moved', stage: 'lead' });
    backdateDeal(deal.id, daysAgo(30));
    updateDeal(db, deal.id, { stage: 'contacted' }); // refreshes updated_at to now

    expect(getStaleDeals(db).map(d => d.id)).not.toContain(deal.id);
  });

  it('flags an open deal with NO activities once its own age passes the window', () => {
    const deal = createDeal(db, { title: 'Never Worked', stage: 'lead' });
    backdateDeal(deal.id, daysAgo(15));

    const stale = getStaleDeals(db);
    expect(stale.map(d => d.id)).toContain(deal.id);
  });

  it('respects a custom window — a 10d-quiet deal is not stale at days=30', () => {
    const deal = createDeal(db, { title: 'Quiet 10d', stage: 'contacted' });
    backdateDeal(deal.id, daysAgo(10));
    insertActivity({ deal_id: deal.id, created_at: daysAgo(10) });

    expect(getStaleDeals(db, { days: 30 }).map(d => d.id)).not.toContain(deal.id);
    expect(getStaleDeals(db, { days: 7 }).map(d => d.id)).toContain(deal.id);
  });

  it('orders most-stale first', () => {
    const a = createDeal(db, { title: 'A 8d', stage: 'contacted' });
    const b = createDeal(db, { title: 'B 20d', stage: 'contacted' });
    backdateDeal(a.id, daysAgo(8));
    backdateDeal(b.id, daysAgo(20));

    const stale = getStaleDeals(db);
    const aIdx = stale.findIndex(d => d.id === a.id);
    const bIdx = stale.findIndex(d => d.id === b.id);
    expect(bIdx).toBeLessThan(aIdx); // 20d-stale before 8d-stale
  });

  it('returns an empty list when there is nothing stale', () => {
    createDeal(db, { title: 'Fresh', stage: 'lead' });
    expect(getStaleDeals(db)).toEqual([]);
  });

  // --- Intentional-hold / snooze suppression (sales caught Åreknute/"Q3 send"
  // being false-flagged stale; a deliberately parked deal is not neglected) ---

  it('does NOT flag a deal with a future snoozed_until (explicit park)', () => {
    const deal = createDeal(db, { title: 'Parked deal', stage: 'contacted' });
    backdateDeal(deal.id, daysAgo(30));
    db.prepare('UPDATE crm_deals SET snoozed_until = ? WHERE id = ?').run('2999-01-01T00:00:00Z', deal.id);
    expect(getStaleDeals(db).map(d => d.id)).not.toContain(deal.id);
  });

  it('DOES flag a deal whose snoozed_until is in the past (hold expired → resurfaces)', () => {
    const deal = createDeal(db, { title: 'Expired snooze', stage: 'contacted' });
    backdateDeal(deal.id, daysAgo(30));
    db.prepare('UPDATE crm_deals SET snoozed_until = ? WHERE id = ?').run('2000-01-01T00:00:00Z', deal.id);
    expect(getStaleDeals(db).map(d => d.id)).toContain(deal.id);
  });

  it('does NOT flag a deal with a "hold until <future date>" note', () => {
    const deal = createDeal(db, { title: 'Quiet', stage: 'contacted', notes: 'on hold until 2999-01-01' });
    backdateDeal(deal.id, daysAgo(30));
    expect(getStaleDeals(db).map(d => d.id)).not.toContain(deal.id);
  });

  it('DOES flag a deal whose "hold until <date>" is in the past', () => {
    const deal = createDeal(db, { title: 'Quiet', stage: 'contacted', notes: 'hold until 2000-01-01' });
    backdateDeal(deal.id, daysAgo(30));
    expect(getStaleDeals(db).map(d => d.id)).toContain(deal.id);
  });

  it('getHeldDeals surfaces a suppressed deal with its resurface date; getStaleDeals omits it', () => {
    const held = createDeal(db, { title: 'Åreknute — Pabau (Q3 send)', stage: 'lead' });
    const stale = createDeal(db, { title: 'Genuinely neglected', stage: 'contacted' });
    backdateDeal(held.id, daysAgo(15));
    backdateDeal(stale.id, daysAgo(15));
    db.prepare('UPDATE crm_deals SET snoozed_until = ? WHERE id = ?').run('2999-01-01T00:00:00Z', held.id);

    expect(getStaleDeals(db).map(d => d.id)).toEqual([stale.id]);
    const heldList = getHeldDeals(db);
    expect(heldList.map(d => d.id)).toContain(held.id);
    expect(heldList.map(d => d.id)).not.toContain(stale.id);
    expect(heldList.find(d => d.id === held.id)!.held_until).toBe('2999-01-01T00:00:00Z');
    expect(heldList.find(d => d.id === held.id)!.days_stale).toBeGreaterThanOrEqual(7);
  });

  it('getHeldDeals only considers candidates past the window — a fresh held deal is not listed', () => {
    const deal = createDeal(db, { title: 'Recently touched + snoozed', stage: 'contacted' });
    backdateDeal(deal.id, daysAgo(2)); // within window → not a stale candidate
    db.prepare('UPDATE crm_deals SET snoozed_until = ? WHERE id = ?').run('2999-01-01T00:00:00Z', deal.id);
    expect(getHeldDeals(db).map(d => d.id)).not.toContain(deal.id);
  });
});

describe('dealHoldUntil (intentional-hold parsing)', () => {
  const MID_Q2 = Date.parse('2026-05-15T00:00:00Z'); // mid Q2 2026

  it('returns null when there is no hold signal', () => {
    expect(dealHoldUntil({ title: 'Normal deal', notes: 'some notes' }, MID_Q2)).toBeNull();
    expect(dealHoldUntil({ title: null, notes: null }, MID_Q2)).toBeNull();
  });

  it('resolves a "Q3 send" tag to the start of Q3 (future → held)', () => {
    expect(dealHoldUntil({ title: 'Åreknute (Q3 send)' }, MID_Q2)).toBe('2026-07-01T00:00:00Z');
    expect(dealHoldUntil({ title: 'Deal — Q4 hold' }, MID_Q2)).toBe('2026-10-01T00:00:00Z');
  });

  it('does NOT hold for a quarter we are already in or past (window open → resurfaces)', () => {
    expect(dealHoldUntil({ title: 'Q2 send' }, MID_Q2)).toBeNull();      // in Q2 now
    expect(dealHoldUntil({ title: 'Q1 send' }, MID_Q2)).toBeNull();      // Q1 passed
    const midQ3 = Date.parse('2026-08-15T00:00:00Z');
    expect(dealHoldUntil({ title: 'Q3 send' }, midQ3)).toBeNull();       // now in Q3
  });

  it('matches reversed and Norwegian quarter phrasing', () => {
    expect(dealHoldUntil({ title: 'send in Q3' }, MID_Q2)).toBe('2026-07-01T00:00:00Z');
    expect(dealHoldUntil({ notes: 'send i Q4' }, MID_Q2)).toBe('2026-10-01T00:00:00Z');
    expect(dealHoldUntil({ title: 'Q3-sende kampanje' }, MID_Q2)).toBe('2026-07-01T00:00:00Z');
  });

  it('parses "hold/snooze until <date>" in ISO and DD.MM.YYYY', () => {
    expect(dealHoldUntil({ notes: 'on hold until 2026-08-01' }, MID_Q2)).toBe('2026-08-01T00:00:00Z');
    expect(dealHoldUntil({ notes: 'snooze til 01.08.2026' }, MID_Q2)).toBe('2026-08-01T00:00:00Z');
    expect(dealHoldUntil({ notes: 'parkert til 01/08/2026' }, MID_Q2)).toBe('2026-08-01T00:00:00Z');
    expect(dealHoldUntil({ notes: 'på vent til 2026-08-01' }, MID_Q2)).toBe('2026-08-01T00:00:00Z');
  });

  it('ignores a past or malformed hold date', () => {
    expect(dealHoldUntil({ notes: 'hold until 2000-01-01' }, MID_Q2)).toBeNull();
    expect(dealHoldUntil({ notes: 'hold until 2026-13-40' }, MID_Q2)).toBeNull(); // invalid month/day
    expect(dealHoldUntil({ notes: 'hold until 31.02.2026' }, MID_Q2)).toBeNull(); // Feb 31 overflow
  });

  it('does NOT park on "hold <Q>" meeting-language (only the Q-first "Q3 hold" is a park signal)', () => {
    // "hold Q3 review call" is a note about a meeting to hold, not a park. The
    // reverse pattern is send-verbs only — a false-park here would be exactly the
    // silent false-negative the doctrine forbids.
    expect(dealHoldUntil({ notes: 'hold Q3 review call' }, MID_Q2)).toBeNull();
    expect(dealHoldUntil({ title: 'hold a Q4 pricing discussion' }, MID_Q2)).toBeNull();
    // But the intentional Q-first park form still holds:
    expect(dealHoldUntil({ title: 'Q3 hold' }, MID_Q2)).toBe('2026-07-01T00:00:00Z');
  });

  it('does NOT roll a past quarter forward to next year (cross-year ambiguity → resurfaces, per doctrine)', () => {
    // "Q1 send" entered in December is year-ambiguous (next year's Q1, or
    // neglected since last Q1?). We never hide it for up to a year — it
    // resurfaces. Precise cross-year parks use snoozed_until / "hold until".
    const december = Date.parse('2026-12-15T00:00:00Z');
    expect(dealHoldUntil({ title: 'Q1 send' }, december)).toBeNull();
    // The explicit escape hatch carries an unambiguous year and DOES hold:
    expect(dealHoldUntil({ notes: 'hold until 2027-01-01' }, december)).toBe('2027-01-01T00:00:00Z');
  });

  it('honours an explicit structured snoozed_until', () => {
    expect(dealHoldUntil({ snoozed_until: '2999-01-01T00:00:00Z', title: 'x' }, MID_Q2)).toBe('2999-01-01T00:00:00Z');
    expect(dealHoldUntil({ snoozed_until: '2000-01-01T00:00:00Z', title: 'x' }, MID_Q2)).toBeNull();
  });

  it('returns the latest expiry when multiple hold signals are present', () => {
    const r = dealHoldUntil({ snoozed_until: '2026-08-01T00:00:00Z', title: 'Q4 send' }, MID_Q2);
    expect(r).toBe('2026-10-01T00:00:00Z'); // Q4 start (Oct) is later than the Aug snooze
  });

  it('reads the signal from notes as well as title', () => {
    expect(dealHoldUntil({ title: 'Plain title', notes: 'Q3 send when budget lands' }, MID_Q2)).toBe('2026-07-01T00:00:00Z');
  });
});

describe('parseHoldDate (CLI --snooze-until validation)', () => {
  it('normalises valid ISO and EU dates to UTC midnight ISO', () => {
    expect(parseHoldDate('2026-08-01')).toBe('2026-08-01T00:00:00Z');
    expect(parseHoldDate('01.08.2026')).toBe('2026-08-01T00:00:00Z');
    expect(parseHoldDate('01/08/2026')).toBe('2026-08-01T00:00:00Z');
  });

  it('rejects unparseable, overflowing, or non-date input (CLI must error, not silently no-op)', () => {
    expect(parseHoldDate('next tuesday')).toBeNull();
    expect(parseHoldDate('2026-13-01')).toBeNull(); // month 13
    expect(parseHoldDate('31.02.2026')).toBeNull(); // Feb 31
    expect(parseHoldDate('')).toBeNull();
    expect(parseHoldDate('2026/08/01')).toBeNull(); // ISO must use hyphens
  });
});

describe('Activities', () => {
  it('creates and lists activities', () => {
    const contact = createContact(db, { name: 'Test' });
    createActivity(db, { type: 'note', subject: 'Note 1', contact_id: contact.id });
    createActivity(db, { type: 'call', subject: 'Call 1', contact_id: contact.id });

    const all = listActivities(db);
    expect(all.length).toBe(2);

    const notes = listActivities(db, { type: 'note' });
    expect(notes.length).toBe(1);

    const contactActivities = listActivities(db, { contact: contact.id });
    expect(contactActivities.length).toBe(2);
  });
});

describe('Follow-ups', () => {
  it('returns pending follow-up tasks', () => {
    const contact = createContact(db, { name: 'Test' });
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const tomorrow = new Date(Date.now() + 86400000).toISOString();

    createActivity(db, { type: 'task', subject: 'Overdue', contact_id: contact.id, due_at: yesterday });
    createActivity(db, { type: 'task', subject: 'Upcoming', contact_id: contact.id, due_at: tomorrow });
    createActivity(db, { type: 'note', subject: 'Not a task', contact_id: contact.id });

    const all = getFollowUps(db);
    expect(all.length).toBe(2);

    const overdue = getFollowUps(db, { due: 'overdue' });
    expect(overdue.length).toBe(1);
    expect(overdue[0].subject).toBe('Overdue');
  });
});

describe('completeActivity', () => {
  it('sets completed_at and removes the task from pending follow-ups', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const task = createActivity(db, { type: 'task', subject: 'Send proposal', due_at: yesterday });
    expect(task.completed_at).toBeNull();
    expect(getFollowUps(db).length).toBe(1);

    const done = completeActivity(db, task.id);
    expect(done).not.toBeNull();
    expect(done!.completed_at).toBeTruthy();

    // Completed task no longer surfaces as a pending follow-up.
    expect(getFollowUps(db).length).toBe(0);
  });

  it('returns null for a non-existent id (no throw)', () => {
    expect(completeActivity(db, 'does-not-exist')).toBeNull();
  });
});

describe('isPendingFollowUp / getActivity (resolve scope guard)', () => {
  it('isPendingFollowUp is true only for incomplete task rows with a due date', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const followUp = createActivity(db, { type: 'task', subject: 'fu', due_at: yesterday });
    const note = createActivity(db, { type: 'note', subject: 'just a note' });
    const taskNoDue = createActivity(db, { type: 'task', subject: 'no due' });

    expect(isPendingFollowUp(getActivity(db, followUp.id)!)).toBe(true);
    expect(isPendingFollowUp(getActivity(db, note.id)!)).toBe(false); // wrong type
    expect(isPendingFollowUp(getActivity(db, taskNoDue.id)!)).toBe(false); // no due date

    // Once completed, it is no longer a pending follow-up.
    completeActivity(db, followUp.id);
    expect(isPendingFollowUp(getActivity(db, followUp.id)!)).toBe(false);
  });

  it('getActivity returns null for a missing id', () => {
    expect(getActivity(db, 'nope')).toBeNull();
  });
});

describe('deleteActivity', () => {
  it('deletes an existing activity and returns true', () => {
    const a = createActivity(db, { type: 'task', subject: 'orphan' });
    expect(listActivities(db).length).toBe(1);

    expect(deleteActivity(db, a.id)).toBe(true);
    expect(listActivities(db).length).toBe(0);
  });

  it('returns false when the id does not exist (idempotent, no throw)', () => {
    expect(deleteActivity(db, 'does-not-exist')).toBe(false);
  });
});

describe('Meetings', () => {
  it('creates and retrieves a meeting', () => {
    const meeting = createMeeting(db, {
      fathom_recording_id: 'rec_123',
      title: 'Discovery Call',
      summary: 'Discussed needs',
      action_items: JSON.stringify(['Follow up on pricing']),
      attendees: JSON.stringify([{ name: 'Kari', email: 'kari@test.com' }]),
    });

    expect(meeting.title).toBe('Discovery Call');
    expect(meeting.fathom_recording_id).toBe('rec_123');

    const found = getMeeting(db, meeting.id);
    expect(found!.summary).toBe('Discussed needs');
  });

  it('lists meetings', () => {
    createMeeting(db, { title: 'Call 1' });
    createMeeting(db, { title: 'Call 2' });
    expect(listMeetings(db).length).toBe(2);
  });

  it('lists meetings by contact via activities', () => {
    const contact = createContact(db, { name: 'Linked' });
    const meeting = createMeeting(db, { title: 'Linked Call' });
    createActivity(db, { type: 'meeting', contact_id: contact.id, meeting_id: meeting.id });

    createMeeting(db, { title: 'Unlinked Call' });

    const linked = listMeetings(db, { contact: contact.id });
    expect(linked.length).toBe(1);
    expect(linked[0].title).toBe('Linked Call');
  });

  it('enforces unique fathom_recording_id', () => {
    createMeeting(db, { fathom_recording_id: 'unique_123' });
    expect(() => createMeeting(db, { fathom_recording_id: 'unique_123' })).toThrow();
  });
});

describe('Webhook Log', () => {
  it('logs a webhook event', () => {
    const id = logWebhook(db, 'calcom', 'BOOKING_CREATED', '{"test": true}');
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM crm_webhook_log WHERE id = ?').get(id) as { source: string; event_type: string };
    expect(row.source).toBe('calcom');
    expect(row.event_type).toBe('BOOKING_CREATED');
  });
});
