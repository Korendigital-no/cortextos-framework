import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initializeCrmSchema } from '../../../src/bus/crm-schema.js';
import { processCalcomWebhook, processFathomWebhook } from '../../../src/bus/crm-webhook-processor.js';

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'crm-proc-'));
  db = new Database(join(tmpDir, 'test.db'));
  db.pragma('foreign_keys = ON');
  initializeCrmSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeCalcomJob(overrides?: Partial<{ bookingId: string; name: string; email: string; company: string }>) {
  const payload = {
    triggerEvent: 'BOOKING_CREATED',
    payload: {
      bookingId: overrides?.bookingId ?? 'book_test',
      title: 'Test Booking',
      attendees: [{ name: overrides?.name ?? 'Test User', email: overrides?.email ?? 'test@test.com' }],
      responses: overrides?.company ? { company: { value: overrides.company } } : {},
    },
  };
  return { id: 1, source: 'calcom', event_type: 'BOOKING_CREATED', payload: JSON.stringify(payload), status: 'pending', attempt_count: 0 };
}

function makeFathomJob(overrides?: Partial<{ recordingId: string; title: string; attendees: Array<{ email: string; name: string }> }>) {
  const payload = {
    recording_id: overrides?.recordingId ?? 'rec_test',
    meeting_title: overrides?.title ?? 'Test Meeting',
    default_summary: 'Discussed project scope',
    action_items: [{ text: 'Send proposal' }, { text: 'Schedule demo' }],
    calendar_invitees: overrides?.attendees ?? [{ email: 'kari@test.com', name: 'Kari' }],
    url: 'https://fathom.video/rec/123',
    share_url: 'https://fathom.video/share/123',
    recording_start_time: '2026-05-27T10:00:00Z',
    recording_end_time: '2026-05-27T10:30:00Z',
  };
  return { id: 2, source: 'fathom', event_type: 'meeting_content_ready', payload: JSON.stringify(payload), status: 'pending', attempt_count: 0 };
}

describe('processCalcomWebhook', () => {
  it('creates contact, deal, and activity from booking', () => {
    const job = makeCalcomJob({ name: 'Ola', email: 'ola@firma.no', company: 'Firma AS' });
    const result = processCalcomWebhook(db, job);

    expect(result.new_deal).toBe(true);
    expect(result.contact_id).toBeTruthy();
    expect(result.deal_id).toBeTruthy();

    const contact = db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(result.contact_id) as { name: string; email: string; source: string };
    expect(contact.name).toBe('Ola');
    expect(contact.email).toBe('ola@firma.no');
    expect(contact.source).toBe('cal_booking');

    const company = db.prepare('SELECT * FROM crm_companies WHERE name = ?').get('Firma AS');
    expect(company).toBeTruthy();

    const deal = db.prepare('SELECT * FROM crm_deals WHERE id = ?').get(result.deal_id) as { stage: string };
    expect(deal.stage).toBe('lead');

    const activities = db.prepare('SELECT * FROM crm_activities WHERE contact_id = ?').all(result.contact_id);
    expect(activities.length).toBe(1);
  });

  it('reuses existing deal for repeat bookings', () => {
    const job1 = makeCalcomJob({ email: 'repeat@test.com', bookingId: 'b1' });
    const result1 = processCalcomWebhook(db, job1);
    expect(result1.new_deal).toBe(true);

    const job2 = makeCalcomJob({ email: 'repeat@test.com', bookingId: 'b2' });
    const result2 = processCalcomWebhook(db, job2);
    expect(result2.new_deal).toBe(false);
    expect(result2.deal_id).toBe(result1.deal_id);
  });

  it('upserts contact on duplicate email', () => {
    processCalcomWebhook(db, makeCalcomJob({ name: 'First', email: 'dup@test.com' }));
    processCalcomWebhook(db, makeCalcomJob({ name: 'Updated', email: 'dup@test.com' }));

    const contacts = db.prepare('SELECT * FROM crm_contacts WHERE email = ?').all('dup@test.com');
    expect(contacts.length).toBe(1);
    expect((contacts[0] as { name: string }).name).toBe('Updated');
  });
});

describe('processFathomWebhook', () => {
  it('stores meeting and creates follow-up tasks from AI output', () => {
    const job = makeFathomJob();
    const aiOutput = {
      meeting_category: 'discovery' as const,
      deal_signals: { interest_level: 'high' as const, budget_mentioned: true, timeline: '3 months', needs: ['automation'] },
      action_items: [
        { text: 'Send proposal', owner: 'sales' as const, due_days: 3 },
        { text: 'Review requirements', owner: 'customer' as const, due_days: 5 },
      ],
      follow_up_email_draft: 'Thanks for the meeting...',
    };

    const result = processFathomWebhook(db, job, aiOutput);

    expect(result.meeting_id).toBeTruthy();
    expect(result.tasks_created).toBe(1); // only sales-owned tasks

    const meeting = db.prepare('SELECT * FROM crm_meetings WHERE id = ?').get(result.meeting_id) as { title: string; ai_parsed: string; email_draft: string };
    expect(meeting.title).toBe('Test Meeting');
    expect(meeting.ai_parsed).toContain('discovery');
    expect(meeting.email_draft).toBe('Thanks for the meeting...');
  });

  it('matches existing contacts by email', () => {
    db.prepare(`INSERT INTO crm_contacts (id, name, email, created_at, updated_at) VALUES ('c1', 'Kari', 'kari@test.com', datetime('now'), datetime('now'))`).run();

    const job = makeFathomJob({ attendees: [{ email: 'kari@test.com', name: 'Kari' }] });
    const result = processFathomWebhook(db, job, null);

    expect(result.matched_contacts).toBe(1);

    const activities = db.prepare("SELECT * FROM crm_activities WHERE contact_id = 'c1' AND type = 'meeting'").all();
    expect(activities.length).toBe(1);
  });

  it('creates review queue entry when no contacts match', () => {
    const job = makeFathomJob({ attendees: [{ email: 'unknown@nobody.com', name: 'Unknown' }] });
    const result = processFathomWebhook(db, job, null);

    expect(result.matched_contacts).toBe(0);

    const reviews = db.prepare("SELECT * FROM crm_review_queue WHERE type = 'contact_match'").all();
    expect(reviews.length).toBe(1);
  });

  it('handles idempotent meeting insert', () => {
    const job = makeFathomJob({ recordingId: 'rec_idempotent' });
    processFathomWebhook(db, job, null);
    processFathomWebhook(db, job, null);

    const meetings = db.prepare("SELECT * FROM crm_meetings WHERE fathom_recording_id = 'rec_idempotent'").all();
    expect(meetings.length).toBe(1);
  });

  it('works without AI output (graceful degradation)', () => {
    const job = makeFathomJob();
    const result = processFathomWebhook(db, job, null);

    expect(result.meeting_id).toBeTruthy();
    expect(result.tasks_created).toBe(0);
  });
});

describe('webhook_log schema', () => {
  it('has retry columns', () => {
    const columns = db.prepare("PRAGMA table_info(crm_webhook_log)").all() as Array<{ name: string }>;
    const names = columns.map(c => c.name);
    expect(names).toContain('status');
    expect(names).toContain('attempt_count');
    expect(names).toContain('next_retry_at');
    expect(names).toContain('locked_at');
    expect(names).toContain('last_error');
    expect(names).toContain('processed_at');
  });
});
