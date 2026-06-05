import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initializeCrmSchema } from '../../../src/bus/crm-schema.js';
import {
  createContact, getContact, listContacts, updateContact, upsertContactByEmail,
  createCompany, getCompany, listCompanies, updateCompany,
  createDeal, getDeal, listDeals, updateDeal, getPipeline,
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
