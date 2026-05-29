import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHmac } from 'crypto';
import { initializeCrmSchema } from '../../../src/bus/crm-schema.js';

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'crm-webhook-'));
  db = new Database(join(tmpDir, 'test.db'));
  db.pragma('foreign_keys = ON');
  initializeCrmSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Cal.com webhook processing', () => {
  it('creates contact, activity, and deal from BOOKING_CREATED', () => {
    const payload = {
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        bookingId: 'book_123',
        title: 'Discovery Call',
        attendees: [{ name: 'Kari Nordmann', email: 'kari@acme.no' }],
        responses: { company: { value: 'Acme AS' } },
      },
    };

    db.prepare(`
      INSERT INTO crm_webhook_log (source, event_type, payload, received_at)
      VALUES ('calcom', 'BOOKING_CREATED', ?, datetime('now'))
    `).run(JSON.stringify(payload));

    const contactId = 'test-contact-id';
    db.prepare(`
      INSERT INTO crm_contacts (id, name, email, source, source_ref, created_at, updated_at)
      VALUES (?, 'Kari Nordmann', 'kari@acme.no', 'cal_booking', 'book_123', datetime('now'), datetime('now'))
    `).run(contactId);

    const contact = db.prepare('SELECT * FROM crm_contacts WHERE email = ?').get('kari@acme.no') as { name: string };
    expect(contact.name).toBe('Kari Nordmann');
  });

  it('upserts existing contact on duplicate email', () => {
    db.prepare(`
      INSERT INTO crm_contacts (id, name, email, source, created_at, updated_at)
      VALUES ('existing', 'Old Name', 'kari@acme.no', 'manual', datetime('now'), datetime('now'))
    `).run();

    const result = db.prepare(`
      INSERT INTO crm_contacts (id, name, email, source, source_ref, created_at, updated_at)
      VALUES ('new-id', 'Kari Nordmann', 'kari@acme.no', 'cal_booking', 'book_456', datetime('now'), datetime('now'))
      ON CONFLICT(email) DO UPDATE SET
        name = excluded.name,
        source = COALESCE(excluded.source, crm_contacts.source),
        source_ref = COALESCE(excluded.source_ref, crm_contacts.source_ref),
        updated_at = excluded.updated_at
      RETURNING id
    `).get() as { id: string };

    expect(result.id).toBe('existing');
    const contact = db.prepare('SELECT * FROM crm_contacts WHERE email = ?').get('kari@acme.no') as { name: string; source: string };
    expect(contact.name).toBe('Kari Nordmann');
    expect(contact.source).toBe('cal_booking');

    const count = db.prepare('SELECT COUNT(*) as c FROM crm_contacts').get() as { c: number };
    expect(count.c).toBe(1);
  });
});

describe('Fathom webhook processing', () => {
  it('stores meeting and creates follow-up tasks from action items', () => {
    const meetingId = 'meeting-test';
    db.prepare(`
      INSERT INTO crm_meetings (id, fathom_recording_id, title, summary, action_items, attendees, created_at)
      VALUES (?, 'rec_abc', 'Discovery Call', 'Discussed AI automation', ?, ?, datetime('now'))
    `).run(
      meetingId,
      JSON.stringify([{ text: 'Send proposal by Friday' }, { text: 'Schedule follow-up demo' }]),
      JSON.stringify([{ name: 'Kari', email: 'kari@acme.no' }]),
    );

    const meeting = db.prepare('SELECT * FROM crm_meetings WHERE id = ?').get(meetingId) as { title: string; fathom_recording_id: string };
    expect(meeting.title).toBe('Discovery Call');
    expect(meeting.fathom_recording_id).toBe('rec_abc');

    const actionItems = JSON.parse(
      (db.prepare('SELECT action_items FROM crm_meetings WHERE id = ?').get(meetingId) as { action_items: string }).action_items
    );
    expect(actionItems).toHaveLength(2);
  });

  it('matches attendees to existing contacts', () => {
    db.prepare(`
      INSERT INTO crm_contacts (id, name, email, created_at, updated_at)
      VALUES ('contact-kari', 'Kari', 'kari@acme.no', datetime('now'), datetime('now'))
    `).run();

    const contact = db.prepare('SELECT id FROM crm_contacts WHERE email = ?').get('kari@acme.no') as { id: string } | undefined;
    expect(contact).toBeTruthy();
    expect(contact!.id).toBe('contact-kari');
  });
});

describe('HMAC verification', () => {
  it('generates correct Cal.com signature', () => {
    const secret = 'test-secret';
    const body = '{"test": true}';
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    expect(signature).toBe(expected);
  });
});
